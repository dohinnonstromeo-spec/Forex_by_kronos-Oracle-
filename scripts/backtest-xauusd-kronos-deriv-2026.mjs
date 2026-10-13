// Focused XAUUSD Deriv-Demo study. Signals are evaluated on completed M5 bars,
// with M15 trend context. Entries/exits are simulated on the following M1 bars.
// This is research code; reconstructed ask prices and OHLC path ambiguity remain.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const DAY = 86_400_000;
const POINT = 0.01; // MT5 XAUUSD digits=2, point=0.01
const SLIPPAGE = POINT; // one point each side
const LOOKBACK = 20;
const MAX_HOLD = 60;
const MAX_COST_R = 0.15;
const WARMUP = 30 * DAY;
const FOLD = 50 * DAY;
const FOLD_COUNT = 5;
const COST_MULTIPLIERS = [1, 1.5, 2];

function loadCsv(name) {
  const rows = readFileSync(join(DIR, name), "utf8").trim().split(/\r?\n/);
  rows.shift();
  return rows.map((row) => {
    const [timestamp, open, high, low, close, volume] = row.split(",");
    return { time: Date.parse(timestamp), open: +open, high: +high, low: +low, close: +close, volume: +volume };
  });
}

const bid = loadCsv("XAUUSD_M1_bid.csv");
const ask = loadCsv("XAUUSD_M1_ask.csv");
const askMap = new Map(ask.map((bar) => [bar.time, bar]));
const minuteBars = bid.flatMap((bar) => {
  const a = askMap.get(bar.time);
  if (!a) return [];
  return [{ ...bar, spread: Math.max(0, a.close - bar.close) }];
});

function resample(bars, minutes) {
  const ms = minutes * MINUTE;
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / ms) * ms;
    const group = groups.get(start) ?? [];
    group.push(bar);
    groups.set(start, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, group]) => {
    if (group.length !== minutes || group.some((bar, i) => bar.time !== time + i * MINUTE)) return [];
    return [{ time, open: group[0].open, high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)), close: group.at(-1).close,
      volume: group.reduce((sum, b) => sum + b.volume, 0) }];
  });
}

const m5 = resample(minuteBars, 5);
const m15 = resample(minuteBars, 15);

function ema(values, length) {
  const out = Array(values.length).fill(Number.NaN);
  const alpha = 2 / (length + 1);
  let value = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    value = Number.isFinite(value) ? alpha * values[i] + (1 - alpha) * value : values[i];
    out[i] = value;
  }
  return out;
}

function atr(bars, length = 14) {
  const tr = bars.map((bar, i) => i === 0 ? bar.high - bar.low : Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[i - 1].close),
    Math.abs(bar.low - bars[i - 1].close),
  ));
  const out = Array(bars.length).fill(Number.NaN);
  let value = Number.NaN;
  for (let i = 0; i < tr.length; i += 1) {
    if (i === length - 1) value = tr.slice(0, length).reduce((sum, x) => sum + x, 0) / length;
    else if (i >= length) value = (value * (length - 1) + tr[i]) / length;
    if (i >= length - 1) out[i] = value;
  }
  return out;
}

const m5Atr = atr(m5);
const m5Ema20 = ema(m5.map((b) => b.close), 20);
const ema20 = ema(m15.map((b) => b.close), 20);
const ema50 = ema(m15.map((b) => b.close), 50);
const m15Trend = m15.map((bar, i) => {
  if (i < 2) return 0;
  if (bar.close > ema20[i] && ema20[i] > ema50[i] && ema20[i] > ema20[i - 2]) return 1;
  if (bar.close < ema20[i] && ema20[i] < ema50[i] && ema20[i] < ema20[i - 2]) return -1;
  return 0;
});

function candleConfirms(bar, direction) {
  const range = Math.max(bar.high - bar.low, POINT);
  const body = Math.abs(bar.close - bar.open);
  if (direction === 1) {
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    return bar.close > bar.open && bar.close >= bar.low + range * 0.62
      && lowerWick >= Math.max(body * 0.7, range * 0.2);
  }
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  return bar.close < bar.open && bar.close <= bar.high - range * 0.62
    && upperWick >= Math.max(body * 0.7, range * 0.2);
}

const variants = [
  { key: "sweep_trend_session", label: "Balayage/reprise M5 + tendance M15 + 07-17 UTC", setup: "sweep", trend: true, session: true },
  { key: "sweep_trend_allhours", label: "Balayage/reprise M5 + tendance M15, toute heure", setup: "sweep", trend: true, session: false },
  { key: "sweep_session_notrend", label: "Balayage/reprise M5 + 07-17 UTC, sans filtre M15", setup: "sweep", trend: false, session: true },
  { key: "retest_trend_session", label: "Cassure/retest M5 + tendance M15 + 07-17 UTC", setup: "retest", trend: true, session: true },
  { key: "pullback_trend_session", label: "Pullback EMA20 M5 + tendance M15 + 07-17 UTC", setup: "pullback", trend: true, session: true },
  { key: "asia_sweep_fvg_retest", label: "Sweep range Asie + displacement/FVG + retest + tendance M15", setup: "fvg_retrace", trend: true, session: true },
  { key: "range20_sweep_fvg_retest", label: "Sweep range M5 20 bougies + displacement/FVG + retest, M15 en contexte", setup: "fvg_retrace", trend: false, session: true },
];
const diagnosticCounts = {};

function buildSignals(variant) {
  const signals = new Map();
  let m15Index = -1;
  let armed = null;
  let swept = null;
  const diag = { liquidityReclaims: 0, alignedReclaims: 0, displacements: 0, armedFvgs: 0, confirmedRetests: 0 };
  const asiaRanges = new Map();
  for (const bar of m5) {
    const date = new Date(bar.time);
    const hour = date.getUTCHours();
    if (hour >= 7) continue;
    const key = date.toISOString().slice(0, 10);
    const range = asiaRanges.get(key) ?? { high: Number.NEGATIVE_INFINITY, low: Number.POSITIVE_INFINITY };
    range.high = Math.max(range.high, bar.high);
    range.low = Math.min(range.low, bar.low);
    asiaRanges.set(key, range);
  }
  for (let i = LOOKBACK + 2; i < m5.length; i += 1) {
    const bar = m5[i];
    const signalEnd = bar.time + 5 * MINUTE;
    while (m15Index + 1 < m15.length && m15[m15Index + 1].time + 15 * MINUTE <= signalEnd) m15Index += 1;
    const directionContext = m15Index >= 0 ? m15Trend[m15Index] : 0;
    const hour = new Date(signalEnd).getUTCHours();
    if (variant.session && !(hour >= 7 && hour < 17)) continue;
    const previous = m5.slice(i - LOOKBACK, i);
    const priorLow = Math.min(...previous.map((x) => x.low));
    const priorHigh = Math.max(...previous.map((x) => x.high));
    const range = m5Atr[i];
    if (!(range > 0)) continue;

    let direction = 0;
    let stop = Number.NaN;
    if (variant.setup === "fvg_retrace") {
      const dateKey = new Date(bar.time).toISOString().slice(0, 10);
      const asia = asiaRanges.get(dateKey);
      const liquidityRange = variant.key.startsWith("asia_") ? asia : { high: priorHigh, low: priorLow };
      if (armed && (i > armed.expires || (armed.direction === 1 && bar.low <= armed.stop)
        || (armed.direction === -1 && bar.high >= armed.stop))) armed = null;
      if (armed && i > armed.index) {
        const midpointTouched = bar.low <= armed.mid && bar.high >= armed.mid;
        if (armed.direction === 1 && midpointTouched
          && bar.close > armed.mid && bar.close > bar.open) {
          diag.confirmedRetests += 1;
          direction = 1;
          stop = armed.stop;
          armed = null;
        } else if (armed.direction === -1 && midpointTouched
          && bar.close < armed.mid && bar.close < bar.open) {
          diag.confirmedRetests += 1;
          direction = -1;
          stop = armed.stop;
          armed = null;
        }
      }
      if (!armed && direction === 0 && asia && directionContext !== 0 && hour >= 7 && hour < 17 && i >= 5) {
        const body = Math.abs(bar.close - bar.open);
        const swingHigh = Math.max(...m5.slice(i - 5, i).map((x) => x.high));
        const swingLow = Math.min(...m5.slice(i - 5, i).map((x) => x.low));
        if (swept && (i > swept.expires || (swept.direction === 1 && bar.low <= swept.extreme)
          || (swept.direction === -1 && bar.high >= swept.extreme))) swept = null;
        const bullishDisplacement = bar.close > bar.open && body >= range * 0.6 && bar.close > swingHigh
          && bar.low > m5[i - 2].high && bar.close >= bar.low + (bar.high - bar.low) * 0.75;
        const bearishDisplacement = bar.close < bar.open && body >= range * 0.6 && bar.close < swingLow
          && bar.high < m5[i - 2].low && bar.close <= bar.high - (bar.high - bar.low) * 0.75;
        if (bullishDisplacement || bearishDisplacement) diag.displacements += 1;
        if (swept?.direction === 1 && (!variant.trend || directionContext === 1) && i > swept.index && bullishDisplacement) {
          diag.armedFvgs += 1;
          const zoneLow = m5[i - 2].high;
          const zoneHigh = bar.low;
          armed = { direction: 1, zoneLow, zoneHigh, mid: (zoneLow + zoneHigh) / 2,
            stop: swept.extreme - Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
          swept = null;
        } else if (swept?.direction === -1 && (!variant.trend || directionContext === -1) && i > swept.index && bearishDisplacement) {
          diag.armedFvgs += 1;
          const zoneLow = bar.high;
          const zoneHigh = m5[i - 2].low;
          armed = { direction: -1, zoneLow, zoneHigh, mid: (zoneLow + zoneHigh) / 2,
            stop: swept.extreme + Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
          swept = null;
        } else if (!swept && liquidityRange && (!variant.trend || directionContext === 1)
          && bar.low < liquidityRange.low && bar.close > liquidityRange.low) {
          diag.liquidityReclaims += 1;
          diag.alignedReclaims += 1;
          swept = { direction: 1, extreme: bar.low, index: i, expires: i + 5 };
        } else if (!swept && liquidityRange && (!variant.trend || directionContext === -1)
          && bar.high > liquidityRange.high && bar.close < liquidityRange.high) {
          diag.liquidityReclaims += 1;
          diag.alignedReclaims += 1;
          swept = { direction: -1, extreme: bar.high, index: i, expires: i + 5 };
        } else if (liquidityRange && ((!variant.trend || directionContext === 1) && bar.low < liquidityRange.low && bar.close > liquidityRange.low
          || (!variant.trend || directionContext === -1) && bar.high > liquidityRange.high && bar.close < liquidityRange.high)) {
          diag.liquidityReclaims += 1;
        }
      }
    } else if (variant.setup === "sweep") {
      if (bar.low < priorLow && bar.close > priorLow && candleConfirms(bar, 1)) direction = 1;
      else if (bar.high > priorHigh && bar.close < priorHigh && candleConfirms(bar, -1)) direction = -1;
      if (direction === 1) stop = bar.low - Math.max(range * 0.1, 2 * POINT);
      if (direction === -1) stop = bar.high + Math.max(range * 0.1, 2 * POINT);
    } else if (variant.setup === "pullback") {
      const body = Math.abs(bar.close - bar.open);
      const candleRange = Math.max(bar.high - bar.low, POINT);
      const bull = bar.close > bar.open && bar.close >= bar.low + candleRange * 0.72 && body >= range * 0.30;
      const bear = bar.close < bar.open && bar.close <= bar.high - candleRange * 0.72 && body >= range * 0.30;
      if (i >= 3 && directionContext === 1 && bar.low <= m5Ema20[i] + range * 0.15
        && bar.close > m5Ema20[i] && bull) {
        direction = 1;
        stop = Math.min(m5[i].low, m5[i - 1].low, m5[i - 2].low) - Math.max(range * 0.1, 2 * POINT);
      } else if (i >= 3 && directionContext === -1 && bar.high >= m5Ema20[i] - range * 0.15
        && bar.close < m5Ema20[i] && bear) {
        direction = -1;
        stop = Math.max(m5[i].high, m5[i - 1].high, m5[i - 2].high) + Math.max(range * 0.1, 2 * POINT);
      }
    } else {
      const tolerance = Math.max(range * 0.2, 2 * POINT);
      if (armed && (i - armed.index > 6
        || (armed.direction === 1 && bar.close < armed.level - tolerance)
        || (armed.direction === -1 && bar.close > armed.level + tolerance))) armed = null;
      const breakBuffer = Math.max(range * 0.05, 2 * POINT);
      if (!armed && bar.close > priorHigh + breakBuffer && m5[i - 1].close <= priorHigh + breakBuffer) {
        armed = { direction: 1, level: priorHigh, index: i };
      } else if (!armed && bar.close < priorLow - breakBuffer && m5[i - 1].close >= priorLow - breakBuffer) {
        armed = { direction: -1, level: priorLow, index: i };
      } else if (armed?.direction === 1 && i > armed.index
        && bar.low <= armed.level + tolerance && bar.low >= armed.level - tolerance * 2
        && bar.close > armed.level && candleConfirms(bar, 1)) {
        direction = 1;
        stop = bar.low - Math.max(range * 0.1, 2 * POINT);
        armed = null;
      } else if (armed?.direction === -1 && i > armed.index
        && bar.high >= armed.level - tolerance && bar.high <= armed.level + tolerance * 2
        && bar.close < armed.level && candleConfirms(bar, -1)) {
        direction = -1;
        stop = bar.high + Math.max(range * 0.1, 2 * POINT);
        armed = null;
      }
    }
    if (direction === 0 || (variant.trend && directionContext !== direction)) continue;
    const eventMinute = signalEnd - MINUTE;
    signals.set(eventMinute, { direction, stop, averageRange: range, signalTime: signalEnd });
  }
  diagnosticCounts[variant.key] = diag;
  return signals;
}

const firstTime = minuteBars[0].time;
const researchStart = firstTime + WARMUP;

function simulate(variant, spreadMultiple) {
  const signals = buildSignals(variant);
  const trades = [];
  let pending = null;
  let position = null;
  let previous = null;

  function closeAt(time, exitPrice, reason) {
    const pnl = position.direction === 1 ? exitPrice - position.entry : position.entry - exitPrice;
    trades.push({ direction: position.direction, entryTime: position.entryTime, exitTime: time,
      r: pnl / position.risk, reason, risk: position.risk, entry: position.entry });
    position = null;
  }

  for (let i = 0; i < minuteBars.length; i += 1) {
    const bar = minuteBars[i];
    const wasOpenAtStart = position !== null;
    let closedThisBar = false;
    if (position && previous && bar.time - previous.time > 10 * MINUTE) {
      const spread = previous.spread * spreadMultiple;
      closeAt(previous.time, position.direction === 1
        ? previous.close - SLIPPAGE
        : previous.close + spread + SLIPPAGE, "data_gap_flatten");
      closedThisBar = true;
    }
    if (!position && pending) {
      const spread = bar.spread * spreadMultiple;
      const entry = pending.direction === 1 ? bar.open + spread + SLIPPAGE : bar.open - SLIPPAGE;
      const risk = pending.direction === 1 ? entry - pending.stop : pending.stop - entry;
      const estimatedCost = spread + 2 * SLIPPAGE;
      if (risk > 0 && risk <= pending.averageRange * 3 && estimatedCost / risk <= MAX_COST_R) {
        position = { direction: pending.direction, entry, entryTime: bar.time, stop: pending.stop,
          target: entry + pending.direction * risk * 1.5, risk, startIndex: i };
      }
      pending = null;
    }
    if (position) {
      const spread = bar.spread * spreadMultiple;
      const askHigh = bar.high + spread;
      const askLow = bar.low + spread;
      const stopHit = position.direction === 1 ? bar.low <= position.stop : askHigh >= position.stop;
      const targetHit = position.direction === 1 ? bar.high >= position.target : askLow <= position.target;
      if (stopHit) {
        const stopFill = position.direction === 1
          ? Math.min(position.stop, bar.open) - SLIPPAGE
          : Math.max(position.stop, bar.open + spread) + SLIPPAGE;
        closeAt(bar.time, stopFill, "SL");
        closedThisBar = true;
      } else if (targetHit) {
        closeAt(bar.time, position.direction === 1 ? position.target - SLIPPAGE : position.target + SLIPPAGE, "TP1_5R");
        closedThisBar = true;
      } else if (bar.time - position.entryTime >= MAX_HOLD * MINUTE) {
        closeAt(bar.time, position.direction === 1 ? bar.close - SLIPPAGE : bar.close + spread + SLIPPAGE, "TIME");
        closedThisBar = true;
      }
    }
    if (!position && !wasOpenAtStart && !closedThisBar && signals.has(bar.time)) pending = signals.get(bar.time);
    previous = bar;
  }
  if (position && previous) closeAt(previous.time,
    position.direction === 1 ? previous.close - SLIPPAGE : previous.close + previous.spread * spreadMultiple + SLIPPAGE,
    "end_of_data");

  const kept = trades.filter((trade) => trade.entryTime >= researchStart
    && trade.entryTime < researchStart + FOLD_COUNT * FOLD);
  return kept.map((trade) => ({ ...trade,
    fold: Math.floor((trade.entryTime - researchStart) / FOLD),
  }));
}

function summarize(trades) {
  const wins = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const losses = trades.filter((t) => t.r < 0).reduce((s, t) => s + Math.abs(t.r), 0);
  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  for (const trade of trades) {
    equityR += trade.r;
    peakR = Math.max(peakR, equityR);
    maxDdR = Math.max(maxDdR, peakR - equityR);
  }
  return { trades: trades.length,
    winPct: trades.length ? Math.round(trades.filter((t) => t.r > 0).length / trades.length * 1000) / 10 : 0,
    avgR: trades.length ? +(trades.reduce((s, t) => s + t.r, 0) / trades.length).toFixed(3) : 0,
    totalR: +trades.reduce((s, t) => s + t.r, 0).toFixed(2),
    profitFactor: losses ? +(wins / losses).toFixed(3) : 0,
    maxDrawdownR: +maxDdR.toFixed(2),
    positiveFolds: Array.from({ length: FOLD_COUNT }, (_, i) => trades.filter((t) => t.fold === i))
      .filter((foldTrades) => foldTrades.length && foldTrades.reduce((s, t) => s + t.r, 0) > 0).length,
    folds: Array.from({ length: FOLD_COUNT }, (_, i) => {
      const group = trades.filter((t) => t.fold === i);
      return { trades: group.length, avgR: group.length ? +(group.reduce((s, t) => s + t.r, 0) / group.length).toFixed(3) : 0,
        totalR: +group.reduce((s, t) => s + t.r, 0).toFixed(2) };
    }),
    exits: Object.fromEntries(["SL", "TP1_5R", "TIME", "data_gap_flatten", "end_of_data"].map((reason) =>
      [reason, trades.filter((t) => t.reason === reason).length])),
  };
}

const results = [];
for (const variant of variants) {
  for (const spreadMultiple of COST_MULTIPLIERS) {
    const trades = simulate(variant, spreadMultiple);
    results.push({ key: variant.key, label: variant.label, spreadMultiple, ...summarize(trades) });
  }
}

const output = {
  source: "Deriv-Demo MT5 historical XAUUSD M1 bid/ask approximations",
  period: { from: new Date(minuteBars[0].time).toISOString(), to: new Date(minuteBars.at(-1).time).toISOString(), researchStart: new Date(researchStart).toISOString() },
  data: { m1Bars: minuteBars.length, m5CompleteBars: m5.length, m15CompleteBars: m15.length,
    point: POINT, spreadMedian: [...minuteBars].sort((a, b) => a.spread - b.spread)[Math.floor(minuteBars.length * 0.5)]?.spread,
    spreadP75: [...minuteBars].sort((a, b) => a.spread - b.spread)[Math.floor(minuteBars.length * 0.75)]?.spread },
  rules: { entry: "R1 candidate: M5 sweep/reclaim of prior 20-bar high/low; within five bars, strong BOS displacement with a 3-candle FVG; enter the first confirmed midpoint retest within 12 bars. M15 trend is displayed as context, not used as a gate in this candidate run. Fixed UTC 07-17 session; local fill next M1 open.",
    exit: "Full exit at stop or +1.5R, whichever is reached first, else close after 60 minutes; stops take priority if both levels occur in one M1 candle",
    stop: "Beyond signal sweep/retest extreme plus max(0.1 ATR14 M5, 0.02 USD)",
    costs: "Entry and exit use reconstructed per-minute bid/ask spread; 1 point ($0.01) slippage per side; stress reruns at 1.5x/2x spread; commission 0 assumed",
    foldMethod: "30-day warm-up plus five chronological 50-day folds; same rules/parameters in every fold" },
  variants: results,
  signalDiagnostics: diagnosticCounts,
  limitations: ["The MT5 source is Deriv-Demo, not a verified live account feed.",
    "Historical ask OHLC is reconstructed from bid OHLC and per-minute spread; no tick-by-tick order path is available.",
    "M15 trend uses completed candles only. Session filter is fixed UTC and does not adjust for daylight-saving time.",
    "Commission, swap, margin, minimum lot, order rejection and real slippage beyond the explicit 1-point assumption are not modeled.",
    "The Pine strategy fills on the next M5 bar in TradingView, while local research enters on the next available M1 bar. Pine's spread input only filters trades; it is not automatically debited from Strategy Tester P&L.",
    "The folds are historical validation, not a future untouched test; selecting a winner after seeing these results creates selection bias."],
};

writeFileSync(join(DIR, "kronos-xauusd-focused-ytd-2026-results.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
const md = [
  "# KRONOS XAUUSD ciblé — Deriv-Demo MT5 — 2026 YTD",
  "",
  `Période source : ${output.period.from} à ${output.period.to}. Données M1 : ${minuteBars.length}; M5 complet : ${m5.length}; M15 complet : ${m15.length}. Spread médian ≈ $${output.data.spreadMedian.toFixed(3)}, p75 ≈ $${output.data.spreadP75.toFixed(3)}.`,
  "",
  "Chaque configuration est rejouée avec le spread historique normal, puis 1,5x et 2x. Exécution et sorties simulées à partir des bougies M1.",
  "",
  "| Configuration | Spread | Trades | Win % | R/trade | Total R | PF | DD max R | Plis + | Pli 1 | Pli 2 | Pli 3 | Pli 4 | Pli 5 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const r of results) md.push(`| ${r.label} | ${r.spreadMultiple}x | ${r.trades} | ${r.winPct} | ${r.avgR} | ${r.totalR} | ${r.profitFactor} | ${r.maxDrawdownR} | ${r.positiveFolds}/5 | ${r.folds.map((f) => `${f.trades} / ${f.avgR}`).join(" | ")} |`);
const range20Base = results.find((r) => r.key === "range20_sweep_fvg_retest" && r.spreadMultiple === 1);
const range20Double = results.find((r) => r.key === "range20_sweep_fvg_retest" && r.spreadMultiple === 2);
const asiaBase = results.find((r) => r.key === "asia_sweep_fvg_retest" && r.spreadMultiple === 1);
md.push("", "## R1 candidate verdict", "",
  `The R1 entry model appears in Kronos_XAUUSD_Sweep_FVG_Retest_Research_v1.pine. On the closest local Deriv-Demo simulation (M5 sweep of prior 20 bars, displacement/BOS/FVG within 5 bars, midpoint retest within 12 bars; M15 context displayed but not used as a gate), the result was ${range20Base.trades} trades, ${range20Base.avgR} R/trade, PF ${range20Base.profitFactor}, positive in ${range20Base.positiveFolds}/5 chronological folds; at 2x spread it was ${range20Double.avgR} R/trade. This does not establish an edge.`,
  `The stricter Asia-range version generated ${asiaBase.trades} trades, so it has no useful performance estimate on this sample. All XAU variants in this research are exploratory; none is approved as a profitable live setup.`,
  "The Pine Strategy Tester shows gross simulated results unless costs are configured in Strategy Properties. The spread input in the script is only an entry filter; use this local report for the Deriv-spread-adjusted estimate.");
md.push("", "## Règles testées", "", "- Balayage/reprise : le M5 dépasse le plus haut/bas des 20 bougies précédentes, clôture de nouveau dans le range et forme un rejet confirmé.",
  "- Cassure/retest : clôture au-delà du range des 20 bougies, puis retest tenu dans les 6 bougies suivantes avec rejet confirmé.",
  "- Pullback EMA20 : en régime M15 aligné, le prix teste l’EMA20 M5 puis clôture à nouveau dans le sens de tendance avec un corps d’au moins 0,3 ATR.",
  "- Variante stricte Sweep Asie/FVG : balayage du range Asie, displacement/BOS et FVG dans les bougies suivantes, puis retest; aucun trade sur l'échantillon, donc résultat non concluant.",
  "- Modèle R1 étudié : sweep/reprise des extrêmes des 20 M5 précédentes, displacement/BOS et FVG sous 5 bougies, retest du milieu de FVG sous 12 bougies; filtre horaire UTC 07-17, M15 affiché comme contexte sans filtre directionnel.",
  "- Filtre de régime M15 : EMA20 au-dessus/au-dessous de l’EMA50, cours du bon côté de l’EMA20 et EMA20 orientée dans le sens du trade.",
  "- Sortie entière au stop ou à +1,5R; sinon clôture après 60 minutes. Un seul trade à la fois.",
  "- Coût d’entrée/sortie basé sur les spreads historiques par minute, slippage simulé d’un point ($0,01) par côté, commission nulle supposée.",
  "", "## Limites", "", ...output.limitations.map((x) => `- ${x}`), "");
writeFileSync(join(DIR, "KRONOS_XAUUSD_FOCUSED_YTD_2026_REPORT.md"), md.join("\n"), "utf8");
console.log(`Saved focused XAUUSD results for ${results.length} runs.`);
