// Offline research only. This deliberately reads local Dukascopy M1 CSV files
// and has no server, broker, database, or network dependency.
//
// The hypothesis is fixed before execution: H1/M15 trend alignment, a M5
// liquidity sweep and reclaim, then M1 confirmation. It is not a parameter
// search, so each chronological fold stays a genuine validation period.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDirectory = join(root, "data-backtest");
const PAIRS = {
  XAUUSD: { file: "XAUUSD_M1_365d.csv", spreadPct: 0.0039 },
  GBPUSD: { file: "GBPUSD_M1_365d.csv", spreadPct: 0.0037 },
};
const WARMUP_DAYS = 60;
const FOLD_DAYS = 60;
const VALIDATION_FOLDS = 5;
const MAX_HOLD_MINUTES = 60;
const TARGET_R = 1.25;
const MAX_COST_R = 0.15;
const H1_FAST_EMA = 20;
const H1_SLOW_EMA = 50;
const M15_FAST_EMA = 12;
const M15_SLOW_EMA = 26;
const M5_LIQUIDITY_LOOKBACK = 8;
const M5_ATR_PERIOD = 14;
const STOP_BUFFER_ATR = 0.1;

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function loadMinuteBars(file) {
  const path = join(dataDirectory, file);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const header = lines.shift().split(",");
  const index = Object.fromEntries(header.map((name, position) => [name, position]));
  return lines.map((line, sourceIndex) => {
    const columns = line.split(",");
    return {
      time: Date.parse(columns[index.timestamp]),
      open: numberOrNull(columns[index.open]),
      high: numberOrNull(columns[index.high]),
      low: numberOrNull(columns[index.low]),
      close: numberOrNull(columns[index.close]),
      sourceIndex,
    };
  }).filter((bar) => Number.isFinite(bar.time)
    && bar.open != null && bar.high != null && bar.low != null && bar.close != null);
}

function aggregateBars(minuteBars, minutes) {
  const bucketMs = minutes * 60_000;
  const output = [];
  for (const [index, bar] of minuteBars.entries()) {
    const bucket = Math.floor(bar.time / bucketMs) * bucketMs;
    const current = output.at(-1);
    if (!current || current.time !== bucket) {
      output.push({
        time: bucket,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        startIndex: index,
        endIndex: index,
      });
      continue;
    }
    current.high = Math.max(current.high, bar.high);
    current.low = Math.min(current.low, bar.low);
    current.close = bar.close;
    current.endIndex = index;
  }
  return output;
}

function completedIndexAt(bars, minuteIndex) {
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].endIndex <= minuteIndex) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

function emaAt(bars, endIndex, period) {
  const startIndex = Math.max(0, endIndex - period * 4 + 1);
  if (endIndex - startIndex + 1 < period) return NaN;
  const multiplier = 2 / (period + 1);
  let ema = bars[startIndex].close;
  for (let index = startIndex + 1; index <= endIndex; index += 1) {
    ema = bars[index].close * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function atrAt(bars, endIndex, period) {
  if (endIndex < period) return NaN;
  let sum = 0;
  for (let index = endIndex - period + 1; index <= endIndex; index += 1) {
    const current = bars[index];
    const previousClose = bars[index - 1]?.close ?? current.close;
    sum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previousClose),
      Math.abs(current.low - previousClose),
    );
  }
  return sum / period;
}

function trendDirection(h1Bars, m15Bars, h1Index, m15Index) {
  if (h1Index < H1_SLOW_EMA || m15Index < M15_SLOW_EMA) return null;
  const h1Fast = emaAt(h1Bars, h1Index, H1_FAST_EMA);
  const h1Slow = emaAt(h1Bars, h1Index, H1_SLOW_EMA);
  const m15Fast = emaAt(m15Bars, m15Index, M15_FAST_EMA);
  const m15Slow = emaAt(m15Bars, m15Index, M15_SLOW_EMA);
  if (![h1Fast, h1Slow, m15Fast, m15Slow].every(Number.isFinite)) return null;
  if (h1Fast > h1Slow && h1Bars[h1Index].close > h1Slow
    && m15Fast > m15Slow && m15Bars[m15Index].close > m15Slow) return "BUY";
  if (h1Fast < h1Slow && h1Bars[h1Index].close < h1Slow
    && m15Fast < m15Slow && m15Bars[m15Index].close < m15Slow) return "SELL";
  return null;
}

function buildSignal(minuteBars, m5Bars, m15Bars, h1Bars, m5Index, spreadPct) {
  const current = m5Bars[m5Index];
  const m15Index = completedIndexAt(m15Bars, current.endIndex);
  const h1Index = completedIndexAt(h1Bars, current.endIndex);
  const direction = trendDirection(h1Bars, m15Bars, h1Index, m15Index);
  if (!direction || m5Index < M5_LIQUIDITY_LOOKBACK + M5_ATR_PERIOD) return null;

  const prior = m5Bars.slice(m5Index - M5_LIQUIDITY_LOOKBACK, m5Index);
  const priorLow = Math.min(...prior.map((bar) => bar.low));
  const priorHigh = Math.max(...prior.map((bar) => bar.high));
  const confirmation = minuteBars[current.endIndex];
  const previousMinute = minuteBars[current.endIndex - 1];
  if (!confirmation || !previousMinute) return null;

  const bullishReclaim = current.low < priorLow && current.close > priorLow
    && current.close > current.open && confirmation.close > previousMinute.high;
  const bearishReclaim = current.high > priorHigh && current.close < priorHigh
    && current.close < current.open && confirmation.close < previousMinute.low;
  if ((direction === "BUY" && !bullishReclaim) || (direction === "SELL" && !bearishReclaim)) return null;

  const entryIndex = current.endIndex + 1;
  const entryBar = minuteBars[entryIndex];
  if (!entryBar) return null;
  const atr = atrAt(m5Bars, m5Index, M5_ATR_PERIOD);
  if (!(atr > 0)) return null;
  const stop = direction === "BUY"
    ? current.low - atr * STOP_BUFFER_ATR
    : current.high + atr * STOP_BUFFER_ATR;
  const risk = Math.abs(entryBar.open - stop);
  if (!(risk > 0)) return null;
  const costR = (entryBar.open * (spreadPct / 100)) / risk;
  if (costR > MAX_COST_R) return null;
  const target = direction === "BUY"
    ? entryBar.open + risk * TARGET_R
    : entryBar.open - risk * TARGET_R;
  return { direction, entryIndex, entry: entryBar.open, stop, target, risk, costR };
}

function simulateTrade(minuteBars, signal) {
  const lastIndex = Math.min(signal.entryIndex + MAX_HOLD_MINUTES - 1, minuteBars.length - 1);
  for (let index = signal.entryIndex; index <= lastIndex; index += 1) {
    const bar = minuteBars[index];
    const stopHit = signal.direction === "BUY" ? bar.low <= signal.stop : bar.high >= signal.stop;
    const targetHit = signal.direction === "BUY" ? bar.high >= signal.target : bar.low <= signal.target;
    // M1 OHLC has no tick path, so this keeps the conservative stop-first rule.
    if (stopHit) return { exitIndex: index, outcome: "loss", rMultiple: -1 - signal.costR, barsHeld: index - signal.entryIndex + 1 };
    if (targetHit) return { exitIndex: index, outcome: "win", rMultiple: TARGET_R - signal.costR, barsHeld: index - signal.entryIndex + 1 };
  }
  const exit = minuteBars[lastIndex].close;
  const grossR = signal.direction === "BUY"
    ? (exit - signal.entry) / signal.risk
    : (signal.entry - exit) / signal.risk;
  return { exitIndex: lastIndex, outcome: "timeout", rMultiple: grossR - signal.costR, barsHeld: lastIndex - signal.entryIndex + 1 };
}

function summarize(trades) {
  if (!trades.length) return { trades: 0, winRate: 0, avgR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, maxLossStreak: 0, averageHoldMinutes: 0 };
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let holds = 0;
  for (const trade of trades) {
    equity += trade.rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    holds += trade.barsHeld;
    if (trade.rMultiple > 0) {
      grossWins += trade.rMultiple;
      lossStreak = 0;
    } else {
      grossLosses += Math.abs(trade.rMultiple);
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }
  const wins = trades.filter((trade) => trade.rMultiple > 0).length;
  return {
    trades: trades.length,
    winRate: round((wins / trades.length) * 100, 1),
    avgR: round(equity / trades.length),
    totalR: round(equity),
    profitFactor: round(grossLosses > 0 ? grossWins / grossLosses : grossWins),
    maxDrawdownR: round(maxDrawdown),
    maxLossStreak,
    averageHoldMinutes: round(holds / trades.length, 1),
  };
}

function runPair(pair, config) {
  const minuteBars = loadMinuteBars(config.file);
  const m5Bars = aggregateBars(minuteBars, 5);
  const m15Bars = aggregateBars(minuteBars, 15);
  const h1Bars = aggregateBars(minuteBars, 60);
  const researchStart = minuteBars[0]?.time + WARMUP_DAYS * 86_400_000;
  const folds = Array.from({ length: VALIDATION_FOLDS }, () => []);
  let nextAvailableMinute = 0;

  for (let index = 0; index < m5Bars.length; index += 1) {
    const current = m5Bars[index];
    if (current.endIndex < nextAvailableMinute) continue;
    const signal = buildSignal(minuteBars, m5Bars, m15Bars, h1Bars, index, config.spreadPct);
    if (!signal || minuteBars[signal.entryIndex].time < researchStart) continue;
    const fold = Math.floor((minuteBars[signal.entryIndex].time - researchStart) / (FOLD_DAYS * 86_400_000));
    if (fold < 0 || fold >= VALIDATION_FOLDS) continue;
    const trade = simulateTrade(minuteBars, signal);
    folds[fold].push(trade);
    nextAvailableMinute = trade.exitIndex + 1;
  }

  const summaries = folds.map(summarize);
  const allTrades = folds.flat();
  const overall = summarize(allTrades);
  const validated = summaries.every((summary) => summary.trades >= 10 && summary.avgR > 0)
    && overall.profitFactor > 1.1;
  return {
    pair,
    minuteBars: minuteBars.length,
    dataFrom: minuteBars[0] ? new Date(minuteBars[0].time).toISOString().slice(0, 10) : null,
    dataTo: minuteBars.at(-1) ? new Date(minuteBars.at(-1).time).toISOString().slice(0, 10) : null,
    folds: summaries,
    overall,
    validated,
  };
}

console.log(JSON.stringify({
  assumptions: {
    source: "local Dukascopy M1 bid bars",
    strategy: "H1/M15 trend plus M5 liquidity reclaim plus M1 confirmation",
    targetR: TARGET_R,
    maxHoldMinutes: MAX_HOLD_MINUTES,
    maxCostR: MAX_COST_R,
    validation: `${VALIDATION_FOLDS} chronological folds of ${FOLD_DAYS} days after ${WARMUP_DAYS} warmup days`,
    sameCandleRule: "stop first",
    limitation: "static observed spread; M1 OHLC cannot reproduce tick order or historic spread changes",
  },
  pairs: Object.entries(PAIRS).map(([pair, config]) => runPair(pair, config)),
}, null, 2));
