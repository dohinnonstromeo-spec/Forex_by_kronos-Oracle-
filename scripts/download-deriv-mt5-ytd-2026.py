"""Export 2026 YTD Deriv MT5 M1 bars and per-bar spread, then derive UTC M5/M15."""

from __future__ import annotations

from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

import MetaTrader5 as mt5
import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "data-backtest" / "2026-ytd-deriv"
START = datetime(2026, 1, 1, tzinfo=timezone.utc)
PAIRS = ("EURUSD", "USDJPY", "GBPUSD", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD")
OHLCV = ("open", "high", "low", "close", "volume")


def write_csv(frame: pd.DataFrame, path: Path) -> None:
    temporary = path.with_suffix(path.suffix + ".part")
    frame.to_csv(temporary, index_label="timestamp")
    temporary.replace(path)


def complete_resample(frame: pd.DataFrame, minutes: int) -> pd.DataFrame:
    groups = frame["close"].resample(f"{minutes}min", origin="epoch", label="left", closed="left")
    complete = groups.count() == minutes
    result = frame.resample(f"{minutes}min", origin="epoch", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    )
    return result.loc[complete].dropna(subset=["open", "high", "low", "close"])


def find_symbol(target: str, available: tuple) -> str | None:
    names = [item.name for item in available]
    exact = next((name for name in names if name.upper() == target), None)
    if exact:
        return exact
    return next((name for name in names if name.upper().startswith(target)), None)


def main() -> int:
    if not mt5.initialize(path=r"C:\Program Files\MetaTrader 5\terminal64.exe", timeout=30_000):
        print(f"MT5 initialize failed: {mt5.last_error()}", file=sys.stderr)
        return 1

    metadata = {"source": "Deriv MT5 terminal", "server": None, "from_utc": START.isoformat(), "to_utc": None, "pairs": {}}
    try:
        account = mt5.account_info()
        if not account or "deriv" not in account.server.lower():
            server = account.server if account else "no account connected"
            print(f"Expected a Deriv MT5 session; connected server is {server!r}.", file=sys.stderr)
            return 2
        metadata["server"] = account.server
        end = datetime.now(timezone.utc).replace(second=0, microsecond=0)
        metadata["to_utc"] = end.isoformat()
        available = mt5.symbols_get() or ()
        OUTPUT.mkdir(parents=True, exist_ok=True)
        succeeded = 0

        for target in PAIRS:
            started = time.monotonic()
            symbol = find_symbol(target, available)
            if not symbol:
                print(f"[{target}] symbol not found", file=sys.stderr, flush=True)
                continue
            if not mt5.symbol_select(symbol, True):
                print(f"[{target}] symbol_select failed: {mt5.last_error()}", file=sys.stderr, flush=True)
                continue
            info = mt5.symbol_info(symbol)
            rates = mt5.copy_rates_range(symbol, mt5.TIMEFRAME_M1, START, end)
            if rates is None or not len(rates):
                print(f"[{target}] no M1 rates: {mt5.last_error()}", file=sys.stderr, flush=True)
                continue

            raw = pd.DataFrame(rates)
            raw = raw.drop_duplicates(subset="time", keep="last").sort_values("time")
            raw["timestamp"] = pd.to_datetime(raw["time"], unit="s", utc=True)
            raw = raw.set_index("timestamp")
            raw["spread_price"] = raw["spread"].astype(float) * float(info.point)
            raw["volume"] = raw["tick_volume"].astype(float)

            bid = raw.loc[:, list(OHLCV)].copy()
            ask = bid.copy()
            for column in ("open", "high", "low", "close"):
                ask[column] = bid[column] + raw["spread_price"]

            write_csv(bid, OUTPUT / f"{target}_M1_bid.csv")
            write_csv(ask, OUTPUT / f"{target}_M1_ask.csv")
            for minutes in (5, 15):
                write_csv(complete_resample(bid, minutes), OUTPUT / f"{target}_M{minutes}_bid.csv")
                write_csv(complete_resample(ask, minutes), OUTPUT / f"{target}_M{minutes}_ask.csv")

            spread_pct = (raw["spread_price"] / raw["close"] * 100).where(raw["spread"] > 0).dropna()
            stats = {
                "symbol": symbol,
                "digits": int(info.digits),
                "point": float(info.point),
                "m1_bars": int(len(bid)),
                "from": bid.index[0].isoformat(),
                "to": bid.index[-1].isoformat(),
                "spread_samples": int(len(spread_pct)),
                "spread_median_pct": float(spread_pct.quantile(0.50)),
                "spread_p75_pct": float(spread_pct.quantile(0.75)),
                "spread_p90_pct": float(spread_pct.quantile(0.90)),
            }
            metadata["pairs"][target] = stats
            succeeded += 1
            print(
                f"[{target}] {len(bid):,} M1 bars | spread p50/p75/p90="
                f"{stats['spread_median_pct']:.6f}%/{stats['spread_p75_pct']:.6f}%/{stats['spread_p90_pct']:.6f}% "
                f"| {time.monotonic() - started:.1f}s",
                flush=True,
            )

        metadata_path = OUTPUT / "deriv-mt5-ytd-2026-metadata.json"
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        print(f"Downloaded {succeeded}/{len(PAIRS)} markets into {OUTPUT}", flush=True)
        print(f"Metadata: {metadata_path}", flush=True)
        return 0 if succeeded == len(PAIRS) else 1
    finally:
        mt5.shutdown()


if __name__ == "__main__":
    raise SystemExit(main())
