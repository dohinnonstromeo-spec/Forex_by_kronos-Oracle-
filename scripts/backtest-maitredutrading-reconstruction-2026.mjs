// Non-official, screenshot-led reconstruction of the visible MDT trade logic.
// Data: Deriv-Demo XAUUSD M1 bid/ask, resampled to M5 and higher timeframes.
// This is an explicit hypothesis, not the private MDT 1 source or its exact settings.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const DAY = 86_400_000;
const POINT = 0.01;
const SLIPPAGE = POINT;
const ATR_LEN = 14;
const BOS_LOOKBACK = 5;
const OB_LOOKBACK = 5;
const ORDER_EXPIRY_MIN = 60;
const MAX_HOLD_MIN = 30;
const MAX_STOP_ATR = 3;
const MIN_MTF_VOTES = 2;
const SPREAD_MULTIPLIERS = [1, 1.5, 2];
const WARMUP_DAYS = 80;

function loadCsv(file) {
  const lines = readFileSync(join(DIR, file), "utf8").trim().split(/\r?\n/);
  lines.shift();
  return lines.map((line) => {
    const [stamp, open, high, low, close, volume] = line.split(",");
    return { time: Date.parse(stamp.replace(" ", "T")), open: +open, high: +high,
      low: +low, close: +close, volume: +volume };
  });
}

const bid = loadCsv("XAUUSD_M1_bid.csv");
const askByTime = new Map(loadCsv("XAUUSD_M1_ask.csv").map((bar) => [bar.time, bar]));
const m1 = bid.flatMap((b) => {
  const a = askByTime.get(b.time);
  if (!a) return [];
  return [{ ...b, askOpen: a.open, askHigh: a.high, askLow: a.low, askClose: a.close,
    spread: Math.max(0, a.close - b.close) }];
});

function resample(bars, minutes) {
  const width = minutes * MINUTE;
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / width) * width;
    const bucket = groups.get(start) ?? [];
    bucket.push(bar);
    groups.set(start, bucket);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, g]) => {
    if (g.length !== minutes || g.some((x, i) => x.time !== time + i * MINUTE)) return [];
    return [{ time, open: g[0].open, high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)), close: g.at(-1).close,
      askOpen: g[0].askOpen, askHigh: Math.max(...g.map((x) => x.askHigh)),
      askLow: Math.min(...g.map((x) => x.askLow)), askClose: g.at(-1).askClose,
      volume: g.reduce((s, x) => s + x.volume, 0) }];
  });
}

function resampleDaily(bars) {
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / DAY) * DAY;
    const bucket = groups.get(start) ?? [];
    bucket.push(bar);
    groups.set(start, bucket);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, g]) => {
    if (g.length < 600) return [];
    return [{ time, open: g[0].open, high: Math.max(...g.map((x) => x.high)),
      low: Math.min(...g.map((x) => x.low)), close: g.at(-1).close,
      askOpen: g[0].askOpen, askHigh: Math.max(...g.map((x) => x.askHigh)),
      askLow: Math.min(...g.map((x) => x.askLow)), askClose: g.at(-1).askClose,
      volume: g.reduce((s, x) => s + x.volume, 0) }];
  });
}

function ema(values, len) {
  const alpha = 2 / (len + 1);
  const out = Array(values.length).fill(Number.NaN);
  let v = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    v = Number.isFinite(v) ? alpha * values[i] + (1 - alpha) * v : values[i];
    out[i] = v;
  }
  return out;
}

function atr(bars, len = ATR_LEN) {
  const out = Array(bars.length).fill(Number.NaN);
  let value = Number.NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const prior = i > 0 ? bars[i - 1].close : bars[i].open;
    const tr = Math.max(bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prior), Math.abs(bars[i].low - prior));
    if (i === len - 1) value = bars.slice(0, len).reduce((s, x, j) => {
      const p = j > 0 ? bars[j - 1].close : bars[j].open;
      return s + Math.max(x.high - x.low, Math.abs(x.high - p), Math.abs(x.low - p));
    }, 0) / len;
    else if (i >= len) value = (value * (len - 1) + tr) / len;
    if (i >= len - 1) out[i] = value;
  }
  return out;
}

function trendSeries(bars) {
  const closes = bars.map((b) => b.close);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  return bars.map((b, i) => {
    if (i < 3) return 0;
    if (b.close > e20[i] && e20[i] > e50[i] && e20[i] > e20[i - 2]) return 1;
    if (b.close < e20[i] && e20[i] < e50[i] && e20[i] < e20[i - 2]) return -1;
    return 0;
  });
}

const m5 = resample(m1, 5);
const contexts = [
  { label: "M15", minutes: 15, bars: resample(m1, 15) },
  { label: "H1", minutes: 60, bars: resample(m1, 60) },
  { label: "H4", minutes: 240, bars: resample(m1, 240) },
  { label: "D1", minutes: 1440, bars: resampleDaily(m1) },
].map((x) => ({ ...x, trends: trendSeries(x.bars), pointer: 0, current: 0 }));
const m5Atr = atr(m5);

function getContext(closeTime) {
  const result = [];
  for (const c of contexts) {
    if (c.bars.length === 0) {
      result.push(0);
      continue;
    }
    while (c.pointer + 1 < c.bars.length
      && c.bars[c.pointer + 1].time + c.minutes * MINUTE <= closeTime) c.pointer += 1;
    if (c.bars[c.pointer].time + c.minutes * MINUTE <= closeTime) c.current = c.trends[c.pointer];
    result.push(c.current);
  }
  return result;
}

function topClose(bar) {
  const range = Math.max(bar.high - bar.low, POINT);
  return (bar.close - bar.low) / range >= 0.75;
}
function bottomClose(bar) {
  const range = Math.max(bar.high - bar.low, POINT);
  return (bar.high - bar.close) / range >= 0.75;
}

const events = [];
const diagnostic = { displacementFvgs: 0, orderblockFvgSetups: 0, rejectedContext: 0,
  rejectedStop: 0, confluenceZones: 0, oneSidedZones: 0 };
for (let i = OB_LOOKBACK + 2; i < m5.length; i += 1) {
  const bar = m5[i];
  const closeTime = bar.time + 5 * MINUTE;
  const votes = getContext(closeTime);
  const direction = votes[0] !== 0 && votes[0] === votes[1] ? votes[0] : 0;
  const voteCount = direction ? votes.filter((v) => v === direction).length : 0;
  const range = m5Atr[i];
  if (!(range > 0)) continue;

  const priorHigh = Math.max(...m5.slice(i - BOS_LOOKBACK, i).map((x) => x.high));
  const priorLow = Math.min(...m5.slice(i - BOS_LOOKBACK, i).map((x) => x.low));
  const body = Math.abs(bar.close - bar.open);
  const bullFvg = bar.low > m5[i - 2].high && bar.close > bar.open
    && body >= range * 0.6 && bar.close > priorHigh && topClose(bar);
  const bearFvg = bar.high < m5[i - 2].low && bar.close < bar.open
    && body >= range * 0.6 && bar.close < priorLow && bottomClose(bar);
  if (!bullFvg && !bearFvg) continue;
  diagnostic.displacementFvgs += 1;
  const dir = bullFvg ? 1 : -1;
  if (!direction || direction !== dir || voteCount < MIN_MTF_VOTES) {
    diagnostic.rejectedContext += 1;
    continue;
  }

  let obIndex = -1;
  for (let j = i - 1; j >= Math.max(0, i - OB_LOOKBACK); j -= 1) {
    if ((dir === 1 && m5[j].close < m5[j].open)
      || (dir === -1 && m5[j].close > m5[j].open)) {
      obIndex = j;
      break;
    }
  }
  if (obIndex < 0) continue;

  const fvgLow = dir === 1 ? m5[i - 2].high : bar.high;
  const fvgHigh = dir === 1 ? bar.low : m5[i - 2].low;
  const obLow = dir === 1 ? m5[obIndex].low : m5[obIndex].open;
  const obHigh = dir === 1 ? m5[obIndex].open : m5[obIndex].high;
  const overlapLow = Math.max(fvgLow, obLow);
  const overlapHigh = Math.min(fvgHigh, obHigh);
  const hasOverlap = overlapHigh > overlapLow;
  const entry = hasOverlap ? (overlapLow + overlapHigh) / 2 : (fvgLow + fvgHigh) / 2;
  const buffer = Math.max(range * 0.1, 2 * POINT);
  const stop = dir === 1 ? Math.min(fvgLow, obLow) - buffer : Math.max(fvgHigh, obHigh) + buffer;
  const risk = dir === 1 ? entry - stop : stop - entry;
  if (!(risk > 0) || risk > range * MAX_STOP_ATR) {
    diagnostic.rejectedStop += 1;
    continue;
  }
  if (hasOverlap) diagnostic.confluenceZones += 1;
  else diagnostic.oneSidedZones += 1;
  diagnostic.orderblockFvgSetups += 1;
  events.push({ time: closeTime - MINUTE, expiresAt: closeTime + ORDER_EXPIRY_MIN * MINUTE,
    direction: dir, entry, stop, risk, atr: range, votes: voteCount, hasOverlap,
    tp1R: 0.67, tp2R: 2.5 });
}

function closeTrade(trades, p, time, price, fraction, reason) {
  const part = Math.min(p.remaining, fraction);
  p.realized += p.direction * (price - p.entry) * part;
  p.remaining -= part;
  if (p.remaining <= 1e-9) {
    trades.push({ direction: p.direction, entryTime: p.entryTime, exitTime: time, entry: p.entry,
      stop: p.originalStop, tp1: p.tp1, tp2: p.tp2, risk: p.risk,
      r: p.realized / p.risk, reason, tp1Reached: p.tp1Reached, votes: p.votes,
      obFvgOverlap: p.hasOverlap });
    return null;
  }
  return p;
}

function simulate(spreadMultiple, variant) {
  const trades = [];
  let pending = null;
  let position = null;
  let eventCursor = 0;
  let previous = null;
  for (let i = 0; i < m1.length; i += 1) {
    const b = m1[i];
    const extra = (spreadMultiple - 1) * b.spread;
    const askOpen = b.askOpen + extra;
    const askHigh = b.askHigh + extra;
    const askLow = b.askLow + extra;
    const askClose = b.askClose + extra;

    if (position && previous && b.time - previous.time > 10 * MINUTE) {
      const px = position.direction === 1 ? previous.close - SLIPPAGE
        : previous.askClose + (spreadMultiple - 1) * previous.spread + SLIPPAGE;
      position = closeTrade(trades, position, previous.time, px, position.remaining, "data_gap_flatten");
    }

    while (eventCursor < events.length && events[eventCursor].time < b.time) eventCursor += 1;
    if (!position && !pending && eventCursor < events.length && events[eventCursor].time === b.time) {
      const e = events[eventCursor];
      if (e.votes >= variant.minVotes) pending = { ...e };
      eventCursor += 1;
    }

    if (pending && b.time > pending.time) {
      if (b.time > pending.expiresAt) pending = null;
      else {
        const filled = pending.direction === 1 ? askLow <= pending.entry : b.high >= pending.entry;
        if (filled) {
          const entry = pending.direction === 1 ? Math.min(pending.entry, askOpen)
            : Math.max(pending.entry, b.open);
          const stop = variant.stopDistanceUsd
            ? entry - pending.direction * variant.stopDistanceUsd : pending.stop;
          const risk = pending.direction === 1 ? entry - stop : stop - entry;
          const totalCost = b.spread * spreadMultiple + 2 * SLIPPAGE;
          if (risk > 0 && risk <= pending.atr * MAX_STOP_ATR && totalCost / risk <= 0.15) {
            const tp1 = variant.tp1DistanceUsd
              ? entry + pending.direction * variant.tp1DistanceUsd
              : entry + pending.direction * risk * (variant.tp1R ?? 0.67);
            const tp2R = pending.direction === 1
              ? (variant.tp2LongR ?? variant.tp2R ?? 2.5)
              : (variant.tp2ShortR ?? variant.tp2R ?? 2.5);
            const tp2Distance = pending.direction === 1
              ? variant.tp2LongDistanceUsd : variant.tp2ShortDistanceUsd;
            position = { direction: pending.direction, entry, entryTime: b.time,
              originalStop: stop, activeStop: stop, risk, tp1,
              tp2: Number.isFinite(tp2Distance)
                ? entry + pending.direction * tp2Distance
                : entry + pending.direction * risk * tp2R,
              remaining: 1, realized: 0,
              tp1Reached: false, votes: pending.votes, hasOverlap: pending.hasOverlap };
          }
          pending = null;
        } else {
          const pendingStop = variant.stopDistanceUsd
            ? pending.entry - pending.direction * variant.stopDistanceUsd : pending.stop;
          if ((pending.direction === 1 && b.low <= pendingStop)
            || (pending.direction === -1 && askHigh >= pendingStop)) pending = null;
        }
      }
    }

    if (position) {
      const long = position.direction === 1;
      const stopHit = long ? b.low <= position.activeStop : askHigh >= position.activeStop;
      const tp1Hit = long ? b.high >= position.tp1 : askLow <= position.tp1;
      const tp2Hit = long ? b.high >= position.tp2 : askLow <= position.tp2;
      if (stopHit) {
        const exit = long ? Math.min(position.activeStop, b.open) - SLIPPAGE
          : Math.max(position.activeStop, askOpen) + SLIPPAGE;
        position = closeTrade(trades, position, b.time, exit, position.remaining,
          position.tp1Reached ? "BE_after_TP1" : "SL");
      } else if (!position.tp1Reached && tp1Hit) {
        position.tp1Reached = true;
        position = closeTrade(trades, position, b.time, position.tp1, 0.5, "TP1");
        if (position) position.activeStop = position.entry;
        // Do not credit TP2 on this M1 candle: its path relative to TP1 is unknown.
      } else if (position && position.tp1Reached && tp2Hit) {
        position = closeTrade(trades, position, b.time, position.tp2,
          position.remaining, "TP2");
      } else if (position && b.time + MINUTE - position.entryTime
        >= (variant.maxHoldMinutes ?? MAX_HOLD_MIN) * MINUTE) {
        const exit = long ? b.close - SLIPPAGE : askClose + SLIPPAGE;
        position = closeTrade(trades, position, b.time, exit, position.remaining, "TIME");
      }
    }
    previous = b;
  }

  if (position && previous) {
    const px = position.direction === 1 ? previous.close - SLIPPAGE
      : previous.askClose + (spreadMultiple - 1) * previous.spread + SLIPPAGE;
    closeTrade(trades, position, previous.time, px, position.remaining, "end_of_data");
  }
  const evaluationStart = m1[0].time + WARMUP_DAYS * DAY;
  return trades.filter((t) => t.entryTime >= evaluationStart);
}

function summarize(trades) {
  const plus = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const minus = trades.filter((t) => t.r < 0).reduce((s, t) => s - t.r, 0);
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.r;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  const start = m1[0].time + WARMUP_DAYS * DAY;
  const end = m1.at(-1).time;
  const width = (end - start + 1) / 5;
  const folds = Array.from({ length: 5 }, (_, i) => {
    const rows = trades.filter((t) => t.entryTime >= start + width * i
      && (i === 4 ? t.entryTime <= end : t.entryTime < start + width * (i + 1)));
    const net = rows.reduce((s, t) => s + t.r, 0);
    return { trades: rows.length, totalR: +net.toFixed(2),
      avgR: rows.length ? +(net / rows.length).toFixed(3) : 0 };
  });
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const exitReasons = ["SL", "BE_after_TP1", "TP2", "TIME", "data_gap_flatten", "end_of_data"];
  const exitNetR = Object.fromEntries(exitReasons.map((reason) => [reason,
    +trades.filter((t) => t.reason === reason).reduce((s, t) => s + t.r, 0).toFixed(2)]));
  const directional = Object.fromEntries([[1, "LONG"], [-1, "SHORT"]].map(([direction, label]) => {
    const side = trades.filter((t) => t.direction === direction);
    const sideR = side.reduce((s, t) => s + t.r, 0);
    return [label, { trades: side.length, totalR: +sideR.toFixed(2),
      avgR: side.length ? +(sideR / side.length).toFixed(3) : 0,
      positivePct: side.length ? +(100 * side.filter((t) => t.r > 0).length / side.length).toFixed(1) : 0,
      tp2: side.filter((t) => t.reason === "TP2").length }];
  }));
  return { trades: trades.length, positiveTrades: trades.filter((t) => t.r > 0).length,
    winPct: trades.length ? +(100 * trades.filter((t) => t.r > 0).length / trades.length).toFixed(1) : 0,
    avgR: trades.length ? +(totalR / trades.length).toFixed(3) : 0, totalR: +totalR.toFixed(2),
    profitFactor: minus ? +(plus / minus).toFixed(3) : null, maxDrawdownR: +maxDd.toFixed(2),
    tp1Trades: trades.filter((t) => t.tp1Reached).length, tp2Trades: trades.filter((t) => t.reason === "TP2").length,
    beAfterTp1: trades.filter((t) => t.reason === "BE_after_TP1").length,
    exits: Object.fromEntries(["SL", "BE_after_TP1", "TP2", "TIME", "data_gap_flatten", "end_of_data"]
      .map((x) => [x, trades.filter((t) => t.reason === x).length])),
    exitNetR, directional,
    folds, positiveFolds: folds.filter((f) => f.trades > 0 && f.totalR > 0).length };
}

const variants = [
  { label: "Base · M15/H1 aligned, ≥2/4 trends", minVotes: 2, tp2R: 2.5 },
  { label: "Strict · M15/H1 aligned, ≥3/4 trends", minVotes: 3, tp2R: 2.5 },
  { label: "Target sensitivity · base filters, TP2=2R", minVotes: 2, tp2R: 2 },
];
variants.push(
  { key: "strict_tp2_2", label: "Strict filter, structural SL, TP2 2R both ways",
    minVotes: 3, tp1R: 0.67, tp2LongR: 2, tp2ShortR: 2 },
  { key: "strict_tp2_267", label: "Strict filter, structural SL, TP2 2.67R both ways",
    minVotes: 3, tp1R: 0.67, tp2LongR: 2.67, tp2ShortR: 2.67 },
  { key: "strict_screenshot_r", label: "Strict filter, structural SL, screenshot TP2 asymmetry (long 2R / short 2.67R)",
    minVotes: 3, tp1R: 0.67, tp2LongR: 2, tp2ShortR: 2.67 },
  { key: "strict_screenshot_usd", label: "Strict filter, fixed $15 SL / $10 TP1 / $30 long TP2 / $40 short TP2",
    minVotes: 3, stopDistanceUsd: 15, tp1DistanceUsd: 10,
    tp2LongDistanceUsd: 30, tp2ShortDistanceUsd: 40 },
  { key: "strict_screenshot_usd_60", label: "Screenshot fixed-dollar levels, 60-minute max hold",
    minVotes: 3, stopDistanceUsd: 15, tp1DistanceUsd: 10,
    tp2LongDistanceUsd: 30, tp2ShortDistanceUsd: 40, maxHoldMinutes: 60 },
  { key: "strict_screenshot_usd_120", label: "Screenshot fixed-dollar levels, 120-minute max hold",
    minVotes: 3, stopDistanceUsd: 15, tp1DistanceUsd: 10,
    tp2LongDistanceUsd: 30, tp2ShortDistanceUsd: 40, maxHoldMinutes: 120 },
);
const runs = [];
let baseTrades = [];
for (const spreadMultiple of [1, 1.5, 2]) {
  for (const v of variants) {
    const trades = simulate(spreadMultiple, v);
    runs.push({ variant: v.label, minTrendVotes: v.minVotes,
      stopModel: v.stopDistanceUsd ? "fixed_usd" : "structural_OB_FVG",
      stopDistanceUsd: v.stopDistanceUsd ?? null,
      tp1R: v.tp1R ?? 0.67, tp1DistanceUsd: v.tp1DistanceUsd ?? null,
      tp2LongR: v.tp2LongR ?? v.tp2R ?? null,
      tp2ShortR: v.tp2ShortR ?? v.tp2R ?? null,
      tp2LongDistanceUsd: v.tp2LongDistanceUsd ?? null,
      tp2ShortDistanceUsd: v.tp2ShortDistanceUsd ?? null,
      assumedPartialAtTp1: 0.5, moveRemainderStopToBE: true,
      maxHoldMinutes: v.maxHoldMinutes ?? MAX_HOLD_MIN, spreadMultiple, ...summarize(trades) });
    if (spreadMultiple === 1 && v.minVotes === 3 && v.tp2R === 2.5
      && !v.stopDistanceUsd) baseTrades = trades;
  }
}

const fromUtc = new Date(m1[0].time).toISOString();
const toUtc = new Date(m1.at(-1).time).toISOString();
const spreads = m1.map((x) => x.spread).sort((a, b) => a - b);
const output = { title: "MDT 1 screenshot-led reconstruction, not the proprietary indicator",
  data: { symbol: "XAUUSD", broker: "Deriv-Demo MT5", timeframe: "M1 bid/ask resampled to M5",
    fromUtc, toUtc, m1Bars: m1.length, m5Bars: m5.length,
    warmupDays: WARMUP_DAYS,
    spreadMedianUsd: +spreads[Math.floor(spreads.length / 2)].toFixed(3),
    slippagePerExitUsd: SLIPPAGE, commissionAssumedUsd: 0 },
  reconstructionRules: { trendFrames: ["M15", "H1", "H4", "D1"],
    trendProxy: "EMA20 above/below EMA50 with EMA20 slope over two closed bars",
    tradeBias: "M15 and H1 must agree; confidence-star proxy counts aligned trends across 4 frames",
    setup: "M5 displacement and BOS with a 3-candle FVG; locate last opposing candle as OB",
    limitEntry: "Midpoint of OB/FVG overlap, otherwise FVG midpoint; pending for at most 60 minutes",
    stop: "Beyond the union of OB and FVG by max(0.10 ATR, 0.02 USD); reject risk above 3 ATR",
    exits: "50% at 0.67R; move remaining stop to entry; 50% target at 2.5R; time exit after 30 minutes",
    costs: "Historical paired bid/ask candles; 0.01 USD adverse slippage on stop/time exits; zero commission",
    executionAmbiguity: "M1 OHLC: stop wins if stop and target touch in one minute; TP2 is not credited on the TP1-touch minute" },
  diagnostics: diagnostic, runs };
const jsonPath = join(DIR, "maitredutrading-reconstruction-2026-results.json");
const reportPath = join(DIR, "MAITREDUTRADING_RECONSTRUCTION_2026_REPORT.md");
const tradesPath = join(DIR, "maitredutrading-reconstruction-2026-trades.csv");
writeFileSync(jsonPath, JSON.stringify(output, null, 2) + "\n", "utf8");
writeFileSync(tradesPath, ["direction,entry_time_utc,exit_time_utc,entry,stop,tp1,tp2,r,reason,tp1_reached,mtf_votes,ob_fvg_overlap",
  ...baseTrades.map((t) => [t.direction === 1 ? "LONG" : "SHORT", new Date(t.entryTime).toISOString(),
    new Date(t.exitTime).toISOString(), t.entry.toFixed(2), t.stop.toFixed(2), t.tp1.toFixed(2),
    t.tp2.toFixed(2), t.r.toFixed(4), t.reason, t.tp1Reached, t.votes, t.obFvgOverlap].join(","))]
  .join("\n") + "\n", "utf8");

const resultTable = runs.map((r) => '| ' + r.variant + ' | ' + r.spreadMultiple + 'x | '
  + r.trades + ' | ' + r.winPct + '% | ' + r.avgR + ' | ' + r.totalR + ' | '
  + (r.profitFactor ?? 'n/a') + ' | ' + r.maxDrawdownR + ' | ' + r.tp1Trades + ' | '
  + r.tp2Trades + ' | ' + r.positiveFolds + '/5 |').join('\n');
const fixedDollarRun = (hold, spread = 1) => runs.find((r) => r.variant.includes('fixed-dollar levels')
  && r.maxHoldMinutes === hold && r.spreadMultiple === spread);
const fixed30 = runs.find((r) => r.variant.includes('fixed $15 SL') && r.spreadMultiple === 1);
const fixed60 = fixedDollarRun(60);
const fixed120 = fixedDollarRun(120);
const fixed60Stress = fixedDollarRun(60, 2);
const fixed120Stress = fixedDollarRun(120, 2);
const report = [
  '# Reconstitution de la logique visible MDT - backtest XAUUSD Deriv 2026', '',
  '> Cette simulation ne reproduit pas le code prive MDT. Elle teste des hypotheses lisibles a partir des captures. Les resultats ne prouvent ni les performances de MDT ni une rentabilite future.', '',
  '## Donnees et protocole', '',
  '- XAUUSD Deriv-Demo MT5, chandelles M1 bid/ask appariees, signaux M5.',
  '- Periode : ' + fromUtc + ' a ' + toUtc + ' (' + m1.length + ' minutes); warm-up multi-timeframe de ' + WARMUP_DAYS + ' jours.',
  '- Fenetre evaluee : ' + new Date(m1[0].time + WARMUP_DAYS * DAY).toISOString() + ' a ' + toUtc + '.',
  '- Spread median : $' + output.data.spreadMedianUsd + '; slippage adverse de $' + SLIPPAGE + ' sur sorties stop/temps; commission non disponible et mise a zero.',
  '- Le jeu local ne contient pas BTCUSD. Le test utilise XAUUSD; certaines captures superposent un libelle XAUUSD a une echelle autour de 82 000 et au texte SELL BTC, donc elles ne permettent pas de confirmer le symbole de chaque exemple.',
  '- Une seule position a la fois; les cinq plis sont chronologiques. Les spreads x1.5 et x2 sont des stress tests.', '',
  '## Hypothese de signaux maintenue constante', '',
  '1. Biais M15 et H1 dans le meme sens; votes de tendance EMA20/EMA50 et pente sur M15, H1, H4, D1. Le filtre strict exige au moins 3 cadres sur 4.',
  '2. Signal M5 : bougie de deplacement, cassure des cinq bougies precedentes, FVG trois bougies et derniere bougie opposee comme OB.',
  '3. Entree limite au milieu de l intersection OB/FVG, sinon au milieu du FVG; validite 60 minutes.',
  '4. Les variantes de gestion partagent les memes signaux qualifies. Le filtre initial rejette les structures dont le stop OB/FVG depasse 3 ATR; la variante fixe a ensuite son propre SL de $15.',
  '5. Hypothese de gestion : 50 % ferme au TP1; le stop du reste passe a BE; le reste sort au TP2 ou a la limite de temps. La limite est de 30 minutes pour les controles, puis 30/60/120 minutes pour les variantes a niveaux fixes. Stop prioritaire si le stop et un objectif sont touches dans la meme minute M1.', '',
  '## Calcul des niveaux visibles', '',
  '- Exemple vente : entree 4137, SL 4152, risque 15 points; TP1 4127 = 10 points = 0,67R; TP2 4097 = 40 points = 2,67R.',
  '- Exemple achat : entree 4106, SL 4091, risque 15 points; TP1 4116 = 10 points = 0,67R; TP2 4136 = 30 points = 2R.',
  '- Avec 50 % pris au TP1 et 50 % au TP2, le gain total ideal serait 1,67R sur la vente et 1,33R sur l achat, avant spread/slippage. Si seul TP1 est pris puis le reste ferme a BE, le gain est 0,33R.',
  '- Si les seuls resultats etaient un TP2 complet ou une perte de -1R, le seuil d equilibre theorique serait 37,5 % pour la vente et 42,9 % pour l achat, avant couts. Si tous les gagnants s arretaient a TP1 puis BE, il faudrait environ 75 % de trades gagnants. Ce ne sont pas des probabilites previsionnelles : le backtest inclut aussi les sorties temps et les couts.', '',
  '## Resultats historiques', '',
  '| Variante | Spread | Trades | Positifs | R moyen | R cumule | PF | DD max R | TP1 | TP2 | Plis + |',
  '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  resultTable, '',
  '### Effet de la duree pour les niveaux fixes de la capture', '',
  '- A spread normal, max 30 min : ' + fixed30.trades + ' trades, ' + fixed30.totalR + 'R, PF ' + fixed30.profitFactor + ', TP2 touches ' + fixed30.tp2Trades + '.',
  '- Max 60 min : ' + fixed60.trades + ' trades, ' + fixed60.totalR + 'R, PF ' + fixed60.profitFactor + ', TP2 touches ' + fixed60.tp2Trades + ', plis positifs ' + fixed60.positiveFolds + '/5. Gains/pertes par sortie (R net) : ' + JSON.stringify(fixed60.exitNetR) + '.',
  '- Max 120 min : ' + fixed120.trades + ' trades, ' + fixed120.totalR + 'R, PF ' + fixed120.profitFactor + ', TP2 touches ' + fixed120.tp2Trades + ', plis positifs ' + fixed120.positiveFolds + '/5. Gains/pertes par sortie (R net) : ' + JSON.stringify(fixed120.exitNetR) + '.',
  '- Au spread x2, ces deux variantes font respectivement ' + fixed60Stress.totalR + 'R et ' + fixed120Stress.totalR + 'R; chacune a ' + fixed60Stress.positiveFolds + '/5 plis positifs. Ce resultat depend donc beaucoup de la duree maximale et n est pas une confirmation independante.', '',
  '## Limites a garder en tete', '',
  '- Positifs signifie P&L net superieur a zero apres sorties partielles; ce n est pas la probabilite que le prochain signal gagne.',
  '- Les niveaux et couleurs ne prouvent pas qu une zone ne sera jamais depassee. Le stop est le niveau d invalidation; un gap ou le slippage peut causer une sortie au-dela.',
  '- Les captures ne precisent pas la part fermee au TP1, le moment exact du BE, la logique d annulation ni la construction algorithmique de l OB/FVG. La repartition 50/50 est une hypothese.',
  '- Bougies M1 sans ticks : l ordre intrabar est inconnu; l hypothese stop-prioritaire est prudente mais approximative. La commission est absente.',
  '- Un petit nombre de plis positifs, un PF proche de 1 ou quelques trades ne suffisent pas a conclure a une strategie robuste. Aucune variante ne doit etre choisie parce qu elle maximise simplement ce seul historique.', '',
  '## Fichiers', '',
  '- Resultats structures : maitredutrading-reconstruction-2026-results.json',
  '- Journal des trades du controle strict TP2 2,5R : maitredutrading-reconstruction-2026-trades.csv',
  '- Script reproductible : scripts/backtest-maitredutrading-reconstruction-2026.mjs'
].join('\n');
writeFileSync(reportPath, report + '\n', 'utf8');
console.log(JSON.stringify({ jsonPath, tradesPath, reportPath, diagnostics: diagnostic, runs }, null, 2));
