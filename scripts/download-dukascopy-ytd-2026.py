"""Download Dukascopy bid/ask M1 candles and UTC-aligned M5/M15 bars for 2026 YTD."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path
import sys
import time

import dukascopy_python as dukascopy
import pandas as pd
from dukascopy_python.instruments import (
    INSTRUMENT_FX_MAJORS_AUD_USD,
    INSTRUMENT_FX_MAJORS_EUR_USD,
    INSTRUMENT_FX_MAJORS_GBP_USD,
    INSTRUMENT_FX_MAJORS_NZD_USD,
    INSTRUMENT_FX_MAJORS_USD_CAD,
    INSTRUMENT_FX_MAJORS_USD_CHF,
    INSTRUMENT_FX_MAJORS_USD_JPY,
    INSTRUMENT_FX_METALS_XAU_USD,
)


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "data-backtest" / "2026-ytd"
PAIRS = {
    "EURUSD": INSTRUMENT_FX_MAJORS_EUR_USD,
    "USDJPY": INSTRUMENT_FX_MAJORS_USD_JPY,
    "GBPUSD": INSTRUMENT_FX_MAJORS_GBP_USD,
    "AUDUSD": INSTRUMENT_FX_MAJORS_AUD_USD,
    "USDCAD": INSTRUMENT_FX_MAJORS_USD_CAD,
    "USDCHF": INSTRUMENT_FX_MAJORS_USD_CHF,
    "NZDUSD": INSTRUMENT_FX_MAJORS_NZD_USD,
    "XAUUSD": INSTRUMENT_FX_METALS_XAU_USD,
}
OHLCV = ["open", "high", "low", "close", "volume"]


def parse_args() -> argparse.Namespace:
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--start", default="2026-01-01", help="UTC date YYYY-MM-DD (default: 2026-01-01)")
    parser.add_argument("--end", default=now.isoformat(), help="Exclusive UTC end datetime/date (default: now, rounded to minute)")
    parser.add_argument("--pairs", nargs="+", choices=PAIRS, default=list(PAIRS))
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--probe-only", action="store_true", help="Fetch and report a small request without writing files")
    parser.add_argument("--aggregate-only", action="store_true", help="Rebuild complete M5/M15 candles from existing M1 CSVs; do not access the network")
    return parser.parse_args()


def parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def fetch_side(instrument: str, side: str, start: datetime, end: datetime) -> pd.DataFrame:
    frame = dukascopy.fetch(
        instrument,
        dukascopy.INTERVAL_MIN_1,
        side,
        start,
        end,
        limit=30_000,
    )
    if frame is None or frame.empty:
        return pd.DataFrame(columns=OHLCV, index=pd.DatetimeIndex([], tz="UTC", name="timestamp"))
    frame = frame.loc[frame.index < pd.Timestamp(end)].sort_index()
    frame = frame.loc[~frame.index.duplicated(keep="last"), OHLCV]
    return frame


def paired_spread_stats(bid: pd.DataFrame, ask: pd.DataFrame) -> tuple[int, float, float, float]:
    paired = pd.concat(
        [bid["close"].rename("bid"), ask["close"].rename("ask")],
        axis=1,
        join="inner",
    ).dropna()
    spread_pct = ((paired["ask"] - paired["bid"]) / paired["bid"] * 100).loc[lambda x: x > 0]
    if spread_pct.empty:
        return 0, float("nan"), float("nan"), float("nan")
    return (
        int(spread_pct.size),
        float(spread_pct.median()),
        float(spread_pct.quantile(0.75)),
        float(spread_pct.quantile(0.90)),
    )


def resample_ohlcv(frame: pd.DataFrame, minutes: int) -> pd.DataFrame:
    buckets = frame["close"].resample(
        f"{minutes}min", origin="epoch", label="left", closed="left"
    )
    complete = buckets.count() == minutes
    result = frame.resample(
        f"{minutes}min", origin="epoch", label="left", closed="left"
    ).agg(
        {
            "open": "first",
            "high": "max",
            "low": "min",
            "close": "last",
            "volume": "sum",
        }
    )
    return result.loc[complete].dropna(subset=["open", "high", "low", "close"])


def write_csv(frame: pd.DataFrame, path: Path) -> None:
    temporary = path.with_suffix(path.suffix + ".part")
    frame.to_csv(temporary, index_label="timestamp")
    temporary.replace(path)


def download_pair(pair: str, instrument: str, start: datetime, end: datetime, out: Path, probe_only: bool) -> bool:
    started = time.monotonic()
    print(f"[{pair}] BID M1 {start.isoformat()} -> {end.isoformat()}", flush=True)
    bid = fetch_side(instrument, dukascopy.OFFER_SIDE_BID, start, end)
    print(f"[{pair}] BID recu: {len(bid):,} bougies", flush=True)
    if bid.empty:
        print(f"[{pair}] Aucun BID; paire ignoree.", flush=True)
        return False

    print(f"[{pair}] ASK M1...", flush=True)
    ask = fetch_side(instrument, dukascopy.OFFER_SIDE_ASK, start, end)
    print(f"[{pair}] ASK recu: {len(ask):,} bougies", flush=True)
    if ask.empty:
        print(f"[{pair}] Aucun ASK; paire ignoree pour un test net de spread.", flush=True)
        return False

    samples, median, p75, p90 = paired_spread_stats(bid, ask)
    print(
        f"[{pair}] Spread observe (points apparies={samples:,}): "
        f"mediane={median:.6f}% | p75={p75:.6f}% | p90={p90:.6f}%",
        flush=True,
    )

    if not probe_only:
        out.mkdir(parents=True, exist_ok=True)
        for side_name, frame in (("bid", bid), ("ask", ask)):
            write_csv(frame, out / f"{pair}_M1_{side_name}.csv")
            for minutes in (5, 15):
                write_csv(resample_ohlcv(frame, minutes), out / f"{pair}_M{minutes}_{side_name}.csv")
        print(f"[{pair}] M1/M5/M15 BID/ASK ecrits dans {out}", flush=True)

    print(f"[{pair}] Termine en {time.monotonic() - started:.1f}s", flush=True)
    return True


def main() -> int:
    args = parse_args()
    if args.aggregate_only:
        rebuilt = 0
        for pair in args.pairs:
            for side in ("bid", "ask"):
                source = args.out / f"{pair}_M1_{side}.csv"
                if not source.exists():
                    print(f"[{pair}] Missing {source}", file=sys.stderr, flush=True)
                    continue
                frame = pd.read_csv(source, index_col="timestamp", parse_dates=True)
                frame.index = pd.to_datetime(frame.index, utc=True)
                for minutes in (5, 15):
                    write_csv(resample_ohlcv(frame, minutes), args.out / f"{pair}_M{minutes}_{side}.csv")
                rebuilt += 1
            print(f"[{pair}] M5/M15 BID/ASK rebuilt from saved M1", flush=True)
        expected = len(args.pairs) * 2
        print(f"Sides rebuilt: {rebuilt}/{expected}", flush=True)
        return 0 if rebuilt == expected else 1

    start = parse_utc(args.start)
    end = parse_utc(args.end)
    if end <= start:
        raise SystemExit("La date de fin doit etre apres la date de debut.")
    if args.probe_only and end - start > pd.Timedelta(days=3):
        raise SystemExit("--probe-only est limite a trois jours.")

    successes = 0
    print(
        f"Telechargement {start.isoformat()} -> {end.isoformat()} UTC "
        f"| {len(args.pairs)} paire(s) | source Dukascopy Bid/Ask",
        flush=True,
    )
    for pair in args.pairs:
        try:
            successes += int(download_pair(pair, PAIRS[pair], start, end, args.out, args.probe_only))
        except Exception as error:  # continue so one missing instrument does not hide other files
            print(f"[{pair}] ECHEC: {type(error).__name__}: {error}", file=sys.stderr, flush=True)

    print(f"Telechargements reussis: {successes}/{len(args.pairs)}", flush=True)
    return 0 if successes == len(args.pairs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
