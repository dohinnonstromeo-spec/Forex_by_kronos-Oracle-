// 2026 year-to-date walk-forward study using Deriv MT5 Demo candles and bar spreads.
// Signals use Deriv BID OHLC. The optional M1 model follows reconstructed BID/ASK
// OHLC minute by minute; the default model estimates costs from the signal bar.
// Neither mode is TradingView's broker emulator.
// Entry rules stay fixed while BE and structural-stop-width management varies.
//
// Run: node scripts/backtest-kronos-exit-management-ytd-2026.mjs
//
// The baseline entry rules stay fixed. The data is split into a 30-day warm-up
// followed by five chronological 50-day folds. These folds compare declared
// exit/filter candidates; after a candidate is inspected on this history, none
// of the later folds is an untouched holdout for that candidate.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPriceActionSetupState,
  KRONOS_PRICE_ACTION_VERSION,
  PRICE_ACTION_RULES,
  stepPriceActionScalp,
} from "../price-action-scalp-engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const DAY_MS = 86_400_000;
const WARMUP_DAYS = 30;
const FOLD_DAYS = 50;
const FOLD_COUNT = 5;
const STOP_RANGE_MULTIPLIER = 1.15;
const MIN_STOP_PRICE_PCT = 0.12;
const MAX_STOP_PRICE_PCT = 2.5;
const PA_LOOKBACK = PRICE_ACTION_RULES.lookbackBars;
const PA_TREND_PERIOD = 10;
const PA_RETEST_BARS = PRICE_ACTION_RULES.retestBars;
const PA_MAX_STOP_RANGE_MULTIPLIER = PRICE_ACTION_RULES.maxStopRangeR;
const PA_MAX_COST_R = PRICE_ACTION_RULES.maxCostR;
const TP1_R = PRICE_ACTION_RULES.tp1R;
const TP2_R = PRICE_ACTION_RULES.tp2R;
const TP1_SIZE_PCT = PRICE_ACTION_RULES.closeAtTp1Pct;
const MAX_HOLD_MINUTES = PRICE_ACTION_RULES.defaultTimeStopMinutes;
const RISK_PCT = 0.5;
const INITIAL_EQUITY = 1000;
const SLIPPAGE_TICKS_PER_SIDE = Math.max(0, Number(process.env.KRONOS_SLIPPAGE_TICKS_PER_SIDE ?? 1));
const COMMISSION_PCT_PER_SIDE = Math.max(0, Number(process.env.KRONOS_COMMISSION_PCT_PER_SIDE ?? 0));
const EXECUTION_MODEL = String(process.env.KRONOS_EXIT_EXECUTION_MODEL || "timeframe_ohlc").trim().toLowerCase();
if (!["timeframe_ohlc", "m1_bid_ask"].includes(EXECUTION_MODEL)) {
  throw new Error("KRONOS_EXIT_EXECUTION_MODEL must be timeframe_ohlc or m1_bid_ask");
}
const PAIR_RUN_FILTER = new Set(String(process.env.KRONOS_EXIT_PAIR_FILTER || "").split(",").map((value) => value.trim().toUpperCase()).filter(Boolean));
const TIMEFRAME_RUN_FILTER = new Set(String(process.env.KRONOS_EXIT_TIMEFRAME_FILTER || "").split(",").map((value) => Number(value.replace(/^M/i, ""))).filter((value) => Number.isFinite(value) && value > 0));
const OUTPUT_TAG = String(process.env.KRONOS_EXIT_OUTPUT_TAG || (EXECUTION_MODEL === "m1_bid_ask" ? "m1-quotes" : "")).replace(/[^a-z0-9_-]/gi, "");
const OUTPUT_SUFFIX = OUTPUT_TAG ? `-${OUTPUT_TAG}` : "";
const PAIRS = {
  EURUSD: { bidFile: "EURUSD_M1_bid.csv", askFile: "EURUSD_M1_ask.csv", tickSize: 0.00001 },
  USDJPY: { bidFile: "USDJPY_M1_bid.csv", askFile: "USDJPY_M1_ask.csv", tickSize: 0.001 },
  GBPUSD: { bidFile: "GBPUSD_M1_bid.csv", askFile: "GBPUSD_M1_ask.csv", tickSize: 0.00001 },
  AUDUSD: { bidFile: "AUDUSD_M1_bid.csv", askFile: "AUDUSD_M1_ask.csv", tickSize: 0.00001 },
  USDCAD: { bidFile: "USDCAD_M1_bid.csv", askFile: "USDCAD_M1_ask.csv", tickSize: 0.00001 },
  USDCHF: { bidFile: "USDCHF_M1_bid.csv", askFile: "USDCHF_M1_ask.csv", tickSize: 0.00001 },
  NZDUSD: { bidFile: "NZDUSD_M1_bid.csv", askFile: "NZDUSD_M1_ask.csv", tickSize: 0.00001 },
  XAUUSD: { bidFile: "XAUUSD_M1_bid.csv", askFile: "XAUUSD_M1_ask.csv", tickSize: 0.001 },
};
const SPREAD_CASES = [
  { label: "Deriv bar spread 1.0x", multiple: 1 },
  { label: "Deriv bar spread 1.5x", multiple: 1.5 },
  { label: "Deriv bar spread 2.0x", multiple: 2 },
];
const BOOTSTRAP_VARIANT_KEYS = new Set([
  "retest_sl_150",
  "retest_sl_150_short_only",
  "retest_sl_150_short_m15_bear",
  "retest_sl_150_m5_short_only",
]);
const BOOTSTRAP_REPLICATES = 5000;
const PA_VARIANTS = ["retest", "rejection"].flatMap((setup) => [
  { key: `${setup}_base`, label: `${setup}: stop structurel, TP1 +1R / TP2 +1.6R`, setup, maxHoldMinutes: 30, stopMultiplier: 1 },
  { key: `${setup}_be_05`, label: `${setup}: BE ajusté aux coûts après +0.5R`, setup, maxHoldMinutes: 30, stopMultiplier: 1, breakevenAtR: 0.5 },
  { key: `${setup}_be_tp1`, label: `${setup}: 50% à +1R, BE ajusté aux coûts après TP1`, setup, maxHoldMinutes: 30, stopMultiplier: 1, breakevenAfterTp1: true },
  { key: `${setup}_sl_125`, label: `${setup}: stop x1.25, objectifs recalculés en R`, setup, maxHoldMinutes: 30, stopMultiplier: 1.25 },
  { key: `${setup}_sl_150`, label: `${setup}: stop x1.50, objectifs recalculés en R`, setup, maxHoldMinutes: 30, stopMultiplier: 1.5 },
]);

// Pre-declared diagnostics for the leading XAUUSD M5 retest candidate. These
// filters are research-only and must not be promoted from this same sample.
PA_VARIANTS.push(
  { key: "retest_sl_150_liquid_session", label: "XAU M5 retest x1.5: session UTC 07-17", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyPair: "XAUUSD", onlyTimeframe: 5, sessionUtc: [7, 17] },
  { key: "retest_sl_150_m15_aligned", label: "XAU M5 retest x1.5: alignement EMA M15 confirme", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyPair: "XAUUSD", onlyTimeframe: 5, m15Alignment: true },
  { key: "retest_sl_150_short_only", label: "XAU M5 retest x1.5: shorts uniquement", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyPair: "XAUUSD", onlyTimeframe: 5, directionFilter: -1 },
  { key: "retest_sl_150_long_only", label: "XAU M5 retest x1.5: longs uniquement", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyPair: "XAUUSD", onlyTimeframe: 5, directionFilter: 1 },
  { key: "retest_sl_150_short_m15_bear", label: "XAU M5 retest x1.5: short et tendance M15 baissiere", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyPair: "XAUUSD", onlyTimeframe: 5, directionFilter: -1, m15Alignment: true },
  { key: "retest_sl_150_m5_short_only", label: "M5 controle intermarche retest x1.5: shorts uniquement", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyTimeframe: 5, directionFilter: -1 },
  { key: "retest_sl_150_m5_long_only", label: "M5 controle intermarche retest x1.5: longs uniquement", setup: "retest", maxHoldMinutes: 30, stopMultiplier: 1.5, onlyTimeframe: 5, directionFilter: 1 },
);

function signalPassesResearchFilters(data, index, signal, variant) {
  if (!signal) return false;
  if (Number.isFinite(Number(variant.directionFilter)) && signal.direction !== Number(variant.directionFilter)) return false;
  if (Array.isArray(variant.sessionUtc)) {
    const hour = new Date(data.times[index]).getUTCHours();
    if (hour < variant.sessionUtc[0] || hour >= variant.sessionUtc[1]) return false;
  }
  if (variant.m15Alignment) {
    const close = data.confirmedM15Close[index];
    const fast = data.confirmedM15Ema20[index];
    const slow = data.confirmedM15Ema50[index];
    const aligned = signal.direction === 1
      ? close > fast && fast > slow
      : close < fast && fast < slow;
    if (!aligned) return false;
  }
  return true;
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function loadBars(file) {
  const path = join(DATA_DIR, file);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const header = rows.shift().split(",");
  const columns = Object.fromEntries(header.map((name, index) => [name, index]));
  return rows.map((row) => {
    const values = row.split(",");
    return {
      time: Date.parse(values[columns.timestamp]),
      open: finite(values[columns.open]),
      high: finite(values[columns.high]),
      low: finite(values[columns.low]),
      close: finite(values[columns.close]),
      volume: finite(values[columns.volume]) ?? 0,
    };
  }).filter((bar) => Number.isFinite(bar.time)
    && bar.open != null && bar.high != null && bar.low != null && bar.close != null);
}

function resampleBars(bars, minutes) {
  if (minutes === 1) return bars;
  const intervalMs = minutes * 60 * 1000;
  const output = [];
  for (const bar of bars) {
    const bucket = Math.floor(bar.time / intervalMs) * intervalMs;
    const last = output.at(-1);
    if (last?.time === bucket) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
      last.volume += bar.volume;
      last.components += 1;
    } else {
      output.push({ time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, components: 1 });
    }
  }
  return output.filter((bar) => bar.components === minutes).map(({ components, ...bar }) => bar);
}

function quantile(sortedValues, probability) {
  if (!sortedValues.length) return null;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

function spreadStatistics(bidBars, askBars) {
  const askByTime = new Map(askBars.map((bar) => [bar.time, bar]));
  const values = [];
  for (const bid of bidBars) {
    const ask = askByTime.get(bid.time);
    if (!ask || bid.close <= 0 || ask.close <= bid.close) continue;
    values.push((ask.close - bid.close) / bid.close * 100);
  }
  values.sort((a, b) => a - b);
  return {
    pairedBars: values.length,
    p50Pct: quantile(values, 0.5),
    p75Pct: quantile(values, 0.75),
    p90Pct: quantile(values, 0.9),
  };
}

function spreadPercentMap(bidBars, askBars) {
  const askByTime = new Map(askBars.map((bar) => [bar.time, bar]));
  const values = new Map();
  for (const bid of bidBars) {
    const ask = askByTime.get(bid.time);
    if (!ask || bid.close <= 0 || ask.close <= bid.close) continue;
    values.set(bid.time, (ask.close - bid.close) / bid.close * 100);
  }
  return values;
}

function buildM1QuoteBuckets(bidBars, askBars, intervalMinutes) {
  const askByTime = new Map(askBars.map((bar) => [bar.time, bar]));
  const buckets = new Map();
  const intervalMs = intervalMinutes * 60 * 1000;
  for (const bid of bidBars) {
    const ask = askByTime.get(bid.time);
    if (!ask || !(bid.open > 0) || !(ask.open >= bid.open)) continue;
    const bucket = Math.floor(bid.time / intervalMs) * intervalMs;
    const quotes = buckets.get(bucket) || [];
    quotes.push({ bid, ask, time: bid.time });
    buckets.set(bucket, quotes);
  }
  for (const quotes of buckets.values()) quotes.sort((a, b) => a.time - b.time);
  return buckets;
}

function sma(values, period) {
  const output = new Float64Array(values.length);
  output.fill(Number.NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) output[i] = sum / period;
  }
  return output;
}

function rollingExtreme(values, period, findMax) {
  const output = new Float64Array(values.length);
  output.fill(Number.NaN);
  const deque = new Int32Array(values.length);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < values.length; i += 1) {
    while (head < tail && deque[head] <= i - period) head += 1;
    while (head < tail) {
      const previous = values[deque[tail - 1]];
      if (findMax ? previous > values[i] : previous < values[i]) break;
      tail -= 1;
    }
    deque[tail] = i;
    tail += 1;
    if (i >= period - 1) output[i] = values[deque[head]];
  }
  return output;
}

function ema(values, period) {
  const output = new Float64Array(values.length);
  output.fill(Number.NaN);
  const alpha = 2 / (period + 1);
  let previous = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    previous = Number.isFinite(previous) ? alpha * values[i] + (1 - alpha) * previous : values[i];
    output[i] = previous;
  }
  return output;
}

function prepare(bars) {
  const n = bars.length;
  const opens = new Float64Array(n);
  const highs = new Float64Array(n);
  const lows = new Float64Array(n);
  const closes = new Float64Array(n);
  const volumes = new Float64Array(n);
  const ranges = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    const bar = bars[i];
    opens[i] = bar.open;
    highs[i] = bar.high;
    lows[i] = bar.low;
    closes[i] = bar.close;
    volumes[i] = bar.volume;
    ranges[i] = Math.max(0, bar.high - bar.low);
  }
  const m15Groups = [];
  const m15Ms = 15 * 60 * 1000;
  for (const bar of bars) {
    const bucket = Math.floor(bar.time / m15Ms);
    const last = m15Groups.at(-1);
    if (last?.bucket === bucket) {
      last.high = Math.max(last.high, bar.high);
      last.low = Math.min(last.low, bar.low);
      last.close = bar.close;
    } else {
      m15Groups.push({ bucket, high: bar.high, low: bar.low, close: bar.close });
    }
  }
  const m15Closes = Float64Array.from(m15Groups, (bar) => bar.close);
  const m15Ema20 = ema(m15Closes, 20);
  const m15Ema50 = ema(m15Closes, 50);
  const m15BullStructure = new Uint8Array(m15Groups.length);
  const m15BearStructure = new Uint8Array(m15Groups.length);
  const pivots = {
    lastHigh: Number.NaN, previousHigh: Number.NaN, lastHighBar: Number.NaN, previousHighBar: Number.NaN,
    lastLow: Number.NaN, previousLow: Number.NaN, lastLowBar: Number.NaN, previousLowBar: Number.NaN,
  };
  for (let i = 0; i < m15Groups.length; i += 1) {
    if (i >= 4) {
      const center = i - 2;
      let pivotHigh = true;
      let pivotLow = true;
      for (let j = i - 4; j <= i; j += 1) {
        if (m15Groups[center].high < m15Groups[j].high) pivotHigh = false;
        if (m15Groups[center].low > m15Groups[j].low) pivotLow = false;
      }
      if (pivotHigh) {
        pivots.previousHigh = pivots.lastHigh;
        pivots.previousHighBar = pivots.lastHighBar;
        pivots.lastHigh = m15Groups[center].high;
        pivots.lastHighBar = center;
      }
      if (pivotLow) {
        pivots.previousLow = pivots.lastLow;
        pivots.previousLowBar = pivots.lastLowBar;
        pivots.lastLow = m15Groups[center].low;
        pivots.lastLowBar = center;
      }
    }
    const recent = Number.isFinite(pivots.lastHighBar) && Number.isFinite(pivots.previousHighBar)
      && Number.isFinite(pivots.lastLowBar) && Number.isFinite(pivots.previousLowBar)
      && i - pivots.lastHighBar <= 90 && i - pivots.previousHighBar <= 90
      && i - pivots.lastLowBar <= 90 && i - pivots.previousLowBar <= 90;
    m15BullStructure[i] = Number(recent && pivots.lastHigh > pivots.previousHigh && pivots.lastLow > pivots.previousLow);
    m15BearStructure[i] = Number(recent && pivots.lastHigh < pivots.previousHigh && pivots.lastLow < pivots.previousLow);
  }
  const confirmedM15Ema20 = new Float64Array(n);
  const confirmedM15Ema50 = new Float64Array(n);
  const confirmedM15Close = new Float64Array(n);
  const confirmedM15BullStructure = new Uint8Array(n);
  const confirmedM15BearStructure = new Uint8Array(n);
  confirmedM15Ema20.fill(Number.NaN);
  confirmedM15Ema50.fill(Number.NaN);
  confirmedM15Close.fill(Number.NaN);
  let groupCursor = 0;
  for (let i = 0; i < n; i += 1) {
    const currentBucket = Math.floor(bars[i].time / m15Ms);
    while (groupCursor < m15Groups.length && m15Groups[groupCursor].bucket < currentBucket) groupCursor += 1;
    const completedGroup = groupCursor - 1;
    if (completedGroup >= 0) {
      confirmedM15Close[i] = m15Closes[completedGroup];
      confirmedM15Ema20[i] = m15Ema20[completedGroup];
      confirmedM15Ema50[i] = m15Ema50[completedGroup];
      confirmedM15BullStructure[i] = m15BullStructure[completedGroup];
      confirmedM15BearStructure[i] = m15BearStructure[completedGroup];
    }
  }
  return {
    times: Float64Array.from(bars, (bar) => bar.time),
    opens,
    highs,
    lows,
    closes,
    volumes,
    avgRange: sma(ranges, 14),
    smaClose10: sma(closes, 10),
    smaClose30: sma(closes, 30),
    confirmedM15Ema20,
    confirmedM15Ema50,
    confirmedM15Close,
    confirmedM15BullStructure,
    confirmedM15BearStructure,
    smaVolume29: sma(volumes, 29),
    hi5: rollingExtreme(highs, 5, true),
    lo5: rollingExtreme(lows, 5, false),
    hi9: rollingExtreme(highs, 9, true),
    lo9: rollingExtreme(lows, 9, false),
    hi10: rollingExtreme(highs, PA_TREND_PERIOD, true),
    lo10: rollingExtreme(lows, PA_TREND_PERIOD, false),
    hi26: rollingExtreme(highs, 26, true),
    lo26: rollingExtreme(lows, 26, false),
    hi30: rollingExtreme(highs, 30, true),
    lo30: rollingExtreme(lows, 30, false),
    hi40: rollingExtreme(highs, 40, true),
    lo40: rollingExtreme(lows, 40, false),
    hi52: rollingExtreme(highs, 52, true),
    lo52: rollingExtreme(lows, 52, false),
    minVolume30: rollingExtreme(volumes, 30, false),
  };
}

function stopFor(direction, reference, close, averageRange) {
  const minimumRisk = Math.max(
    averageRange * STOP_RANGE_MULTIPLIER,
    close * MIN_STOP_PRICE_PCT / 100,
  );
  const structuralRisk = Number.isFinite(reference) ? Math.abs(close - reference) : 0;
  const acceptedStructuralRisk = structuralRisk <= close * MAX_STOP_PRICE_PCT / 100
    ? structuralRisk
    : 0;
  const risk = Math.max(minimumRisk, acceptedStructuralRisk);
  return {
    risk,
    stop: direction === 1 ? close - risk : close + risk,
  };
}

function evaluateRefinedSignal(data, i, runConfig) {
  const result = stepPriceActionScalp({
    bar: {
      open: data.opens[i],
      high: data.highs[i],
      low: data.lows[i],
      close: data.closes[i],
    },
    previousBar: {
      open: data.opens[i - 1],
      high: data.highs[i - 1],
      low: data.lows[i - 1],
      close: data.closes[i - 1],
    },
    index: i,
    averageRange: data.avgRange[i],
    support: data.lo30[i - 1],
    resistance: data.hi30[i - 1],
    setup: runConfig.setup,
    setupState: runConfig.setupState,
    tickSize: runConfig.tickSize,
    spreadPct: runConfig.spreadPct,
    commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
  });
  return { finalDirection: result.finalDirection, signal: result.signal };
}

function evaluateSignal(data, i, pivots, previousFinalDirection, runConfig) {
  if (runConfig?.method === "PRICE_ACTION_V2") return evaluateRefinedSignal(data, i, runConfig);
  const {
    opens, highs, lows, closes, volumes, avgRange,
    smaClose10, smaClose30, smaVolume29,
    hi5, lo5, hi9, lo9, hi10, lo10, hi26, lo26, hi30, lo30, hi40, lo40, hi52, lo52, minVolume30,
  } = data;
  const close = closes[i];
  const averageRange = avgRange[i];
  if (!(averageRange > 0) || i < (runConfig?.method === "PRICE_ACTION" ? Math.max(34, PA_LOOKBACK, PA_TREND_PERIOD * 2 - 1) : 77)) return { finalDirection: 0, signal: null };

  const paSupport = lo30[i - 1];
  const paResistance = hi30[i - 1];
  const candleBody = Math.abs(close - opens[i]);
  const candleRange = Math.max(highs[i] - lows[i], close * 0.00001);
  const lowerWick = Math.min(opens[i], close) - lows[i];
  const upperWick = highs[i] - Math.max(opens[i], close);
  const paBullReject = close > opens[i]
    && lowerWick >= Math.max(candleBody * 1.35, candleRange * 0.25)
    && close >= lows[i] + candleRange * 0.62;
  const paBearReject = close < opens[i]
    && upperWick >= Math.max(candleBody * 1.35, candleRange * 0.25)
    && close <= highs[i] - candleRange * 0.62;
  const paBullEngulf = closes[i - 1] < opens[i - 1]
    && close > opens[i] && close >= opens[i - 1] && opens[i] <= closes[i - 1];
  const paBearEngulf = closes[i - 1] > opens[i - 1]
    && close < opens[i] && close <= opens[i - 1] && opens[i] >= closes[i - 1];
  const paBullBreak = close > paResistance * 1.0002;
  const paBearBreak = close < paSupport * 0.9998;
  const paTrendBull = hi10[i] > hi10[i - PA_TREND_PERIOD] && lo10[i] > lo10[i - PA_TREND_PERIOD];
  const paTrendBear = hi10[i] < hi10[i - PA_TREND_PERIOD] && lo10[i] < lo10[i - PA_TREND_PERIOD];
  const paBullEvidence = Number(paBullBreak) + Number(paBullEngulf) + Number(paBullReject) + Number(paTrendBull);
  const paBearEvidence = Number(paBearBreak) + Number(paBearEngulf) + Number(paBearReject) + Number(paTrendBear);
  const paLong = i >= Math.max(34, PA_LOOKBACK, PA_TREND_PERIOD * 2 - 1)
    && (paBullBreak || paBullEngulf || paBullReject)
    && paBullEvidence >= 2 && paBullEvidence >= paBearEvidence;
  const paShort = i >= Math.max(34, PA_LOOKBACK, PA_TREND_PERIOD * 2 - 1)
    && (paBearBreak || paBearEngulf || paBearReject)
    && paBearEvidence >= 2 && paBearEvidence > paBullEvidence;
  const paDirection = paLong ? 1 : paShort ? -1 : 0;

  if (runConfig?.method === "PRICE_ACTION") {
    const structureAligned = !runConfig.m15Structure
      || (paDirection === 1 && data.confirmedM15BullStructure[i] === 1)
      || (paDirection === -1 && data.confirmedM15BearStructure[i] === 1);
    const finalDirection = structureAligned ? paDirection : 0;
    const hourUtc = new Date(data.times[i]).getUTCHours();
    const sessionAllowed = !runConfig.session || (hourUtc >= 7 && hourUtc < 17);
    let signal = null;
    if (finalDirection !== 0 && finalDirection !== previousFinalDirection && sessionAllowed) {
      const reference = finalDirection === 1 ? paSupport : paResistance;
      const stopPlan = stopFor(finalDirection, reference, close, averageRange);
      const valid = close > 0 && stopPlan.risk > 0 && stopPlan.risk <= close * MAX_STOP_PRICE_PCT / 100;
      if (valid) {
        signal = {
          direction: finalDirection,
          entry: close,
          stop: stopPlan.stop,
          risk: stopPlan.risk,
          tp1: close + finalDirection * stopPlan.risk * TP1_R,
          tp2: close + finalDirection * stopPlan.risk * TP2_R,
        };
      }
    }
    return { finalDirection, signal };
  }

  const tenkan = (hi9[i] + lo9[i]) / 2;
  const kijun = (hi26[i] + lo26[i]) / 2;
  const spanA = (tenkan + kijun) / 2;
  const spanB = (hi52[i] + lo52[i]) / 2;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);
  const ichiLong = close > cloudTop && tenkan > kijun && close > closes[i - 26];
  const ichiShort = close < cloudBottom && tenkan < kijun && close < closes[i - 26];
  const ichiDirection = ichiLong ? 1 : ichiShort ? -1 : 0;
  const ichiLongReference = Math.min(kijun, cloudBottom);
  const ichiShortReference = Math.max(kijun, cloudTop);

  if (i >= 4) {
    const center = i - 2;
    const left = center - 2;
    let pivotHigh = true;
    let pivotLow = true;
    for (let j = left; j <= i; j += 1) {
      if (highs[center] < highs[j]) pivotHigh = false;
      if (lows[center] > lows[j]) pivotLow = false;
    }
    if (pivotHigh) {
      pivots.previousHigh = pivots.lastHigh;
      pivots.previousHighBar = pivots.lastHighBar;
      pivots.lastHigh = highs[center];
      pivots.lastHighBar = center;
    }
    if (pivotLow) {
      pivots.previousLow = pivots.lastLow;
      pivots.previousLowBar = pivots.lastLowBar;
      pivots.lastLow = lows[center];
      pivots.lastLowBar = center;
    }
  }
  const pivotsRecent = Number.isFinite(pivots.lastHighBar)
    && Number.isFinite(pivots.previousHighBar)
    && Number.isFinite(pivots.lastLowBar)
    && Number.isFinite(pivots.previousLowBar)
    && i - pivots.lastHighBar <= 90
    && i - pivots.previousHighBar <= 90
    && i - pivots.lastLowBar <= 90
    && i - pivots.previousLowBar <= 90;
  const smcBullStructure = pivotsRecent && pivots.lastHigh > pivots.previousHigh && pivots.lastLow > pivots.previousLow;
  const smcBearStructure = pivotsRecent && pivots.lastHigh < pivots.previousHigh && pivots.lastLow < pivots.previousLow;
  const smcBullBos = pivotsRecent && close > pivots.lastHigh * 1.0002;
  const smcBearBos = pivotsRecent && close < pivots.lastLow * 0.9998;
  const smcBullSweep = pivotsRecent && lows[i] < pivots.lastLow * 0.9998 && close > pivots.lastLow;
  const smcBearSweep = pivotsRecent && highs[i] > pivots.lastHigh * 1.0002 && close < pivots.lastHigh;
  const smcBullFvg = i >= 2 && highs[i - 2] < lows[i];
  const smcBearFvg = i >= 2 && lows[i - 2] > highs[i];
  const smcBullEvidence = Number(smcBullBos) + Number(smcBullStructure) + Number(smcBullSweep) + Number(smcBullFvg);
  const smcBearEvidence = Number(smcBearBos) + Number(smcBearStructure) + Number(smcBearSweep) + Number(smcBearFvg);
  const smcLong = pivotsRecent
    && ((smcBullBos && (smcBullStructure || smcBullFvg)) || (smcBullSweep && smcBullFvg))
    && smcBullEvidence >= smcBearEvidence;
  const smcShort = pivotsRecent
    && ((smcBearBos && (smcBearStructure || smcBearFvg)) || (smcBearSweep && smcBearFvg))
    && smcBearEvidence > smcBullEvidence;
  const smcDirection = smcLong ? 1 : smcShort ? -1 : 0;

  const wyckoffSupport = lo40[i - 5];
  const wyckoffResistance = hi40[i - 5];
  const priorAverageVolume = smaVolume29[i - 1];
  const volumeRatio = priorAverageVolume > 0 ? volumes[i] / priorAverageVolume : Number.NaN;
  const wyckoffVolumeReady = i >= 49 && minVolume30[i] > 0 && Number.isFinite(volumeRatio);
  const wyckoffSpring = wyckoffVolumeReady
    && lo5[i] < wyckoffSupport * 0.9995
    && close > wyckoffSupport && volumeRatio >= 1.15;
  const wyckoffUpthrust = wyckoffVolumeReady
    && hi5[i] > wyckoffResistance * 1.0005
    && close < wyckoffResistance && volumeRatio >= 1.15;
  const wyckoffDirection = wyckoffSpring ? 1 : wyckoffUpthrust ? -1 : 0;

  const longVotes = Number(paDirection === 1) + Number(ichiDirection === 1)
    + Number(smcDirection === 1) + Number(wyckoffDirection === 1);
  const shortVotes = Number(paDirection === -1) + Number(ichiDirection === -1)
    + Number(smcDirection === -1) + Number(wyckoffDirection === -1);
  const mixDirection = longVotes >= 2 && longVotes > shortVotes
    ? 1
    : shortVotes >= 2 && shortVotes > longVotes ? -1 : 0;
  let mixLongStopReference = Number.NaN;
  let mixShortStopReference = Number.NaN;
  if (paDirection === 1) mixLongStopReference = stopFor(1, paSupport, close, averageRange).stop;
  if (ichiDirection === 1) {
    const value = stopFor(1, ichiLongReference, close, averageRange).stop;
    mixLongStopReference = Number.isFinite(mixLongStopReference) ? Math.min(mixLongStopReference, value) : value;
  }
  if (smcDirection === 1) {
    const value = stopFor(1, pivots.lastLow, close, averageRange).stop;
    mixLongStopReference = Number.isFinite(mixLongStopReference) ? Math.min(mixLongStopReference, value) : value;
  }
  if (wyckoffDirection === 1) {
    const value = stopFor(1, wyckoffSupport, close, averageRange).stop;
    mixLongStopReference = Number.isFinite(mixLongStopReference) ? Math.min(mixLongStopReference, value) : value;
  }
  if (paDirection === -1) mixShortStopReference = stopFor(-1, paResistance, close, averageRange).stop;
  if (ichiDirection === -1) {
    const value = stopFor(-1, ichiShortReference, close, averageRange).stop;
    mixShortStopReference = Number.isFinite(mixShortStopReference) ? Math.max(mixShortStopReference, value) : value;
  }
  if (smcDirection === -1) {
    const value = stopFor(-1, pivots.lastHigh, close, averageRange).stop;
    mixShortStopReference = Number.isFinite(mixShortStopReference) ? Math.max(mixShortStopReference, value) : value;
  }
  if (wyckoffDirection === -1) {
    const value = stopFor(-1, wyckoffResistance, close, averageRange).stop;
    mixShortStopReference = Number.isFinite(mixShortStopReference) ? Math.max(mixShortStopReference, value) : value;
  }

  const finalDirection = mixDirection;
  let plan = null;
  if (finalDirection !== 0) {
    const mixedReference = finalDirection === 1 ? mixLongStopReference : mixShortStopReference;
    const stopPlan = stopFor(finalDirection, mixedReference, close, averageRange);
    const valid = close > 0 && stopPlan.risk > 0 && stopPlan.risk <= close * MAX_STOP_PRICE_PCT / 100;
    if (valid && finalDirection !== previousFinalDirection) {
      plan = {
        direction: finalDirection,
        entry: close,
        stop: stopPlan.stop,
        risk: stopPlan.risk,
        tp1: close + finalDirection * stopPlan.risk * TP1_R,
        tp2: close + finalDirection * stopPlan.risk * TP2_R,
      };
    }
  }
  return { finalDirection, signal: plan };
}

function walkForward(pair, bars, config, variant, intervalMinutes) {
  const data = prepare(bars);
  const pivots = {
    lastHigh: Number.NaN,
    previousHigh: Number.NaN,
    lastHighBar: Number.NaN,
    previousHighBar: Number.NaN,
    lastLow: Number.NaN,
    previousLow: Number.NaN,
    lastLowBar: Number.NaN,
    previousLowBar: Number.NaN,
  };
  const start = bars[0].time;
  const researchStart = start + WARMUP_DAYS * DAY_MS;
  const foldTrades = Array.from({ length: FOLD_COUNT }, () => []);
  let previousFinalDirection = 0;
  let position = null;
  let pendingEntry = null;
  const setupState = createPriceActionSetupState();

  function finishTrade(index, grossR, reason) {
    const fold = Math.floor((bars[position.entryIndex].time - researchStart) / (FOLD_DAYS * DAY_MS));
    if (fold >= 0 && fold < FOLD_COUNT) {
      const spreadDollars = position.entry * position.spreadPct / 100;
      const commissionDollars = position.entry * 2 * COMMISSION_PCT_PER_SIDE / 100;
      const slipDollars = config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2;
      foldTrades[fold].push({
        pair,
        direction: position.direction,
        entryTime: bars[position.entryIndex].time,
        exitTime: bars[index].time,
        barsHeld: (index - position.entryIndex) * intervalMinutes,
        grossR,
        risk: position.risk,
        spreadDollars,
        commissionDollars,
        slipDollars,
        reason,
      });
    }
    position = null;
  }

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const hadPositionAtBarStart = position !== null;
    let openedPositionThisBar = false;
    if (!position && pendingEntry) {
      const entry = bar.open;
      const rawRisk = pendingEntry.direction === 1
        ? entry - pendingEntry.stop
        : pendingEntry.stop - entry;
      const stopMultiplier = Math.max(1, Number(variant.stopMultiplier) || 1);
      const risk = rawRisk * stopMultiplier;
      const stop = entry - pendingEntry.direction * risk;
      const entrySpreadPct = config.spreadPctByTime?.get(bar.time) ?? config.spreadPct;
      const roundTripCost = entry * entrySpreadPct / 100
        + entry * 2 * COMMISSION_PCT_PER_SIDE / 100
        + config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2;
      const stopStillValid = rawRisk > 0 && rawRisk <= pendingEntry.averageRange * PA_MAX_STOP_RANGE_MULTIPLIER;
      const costsStillValid = risk > 0 && roundTripCost / risk <= PA_MAX_COST_R;
      if (stopStillValid && costsStillValid) {
        position = {
          direction: pendingEntry.direction,
          entry,
          spreadPct: entrySpreadPct,
          stop,
          risk,
          tp1: entry + pendingEntry.direction * risk * TP1_R,
          tp2: entry + pendingEntry.direction * risk * TP2_R,
          entryIndex: i,
          tp1Taken: false,
          breakevenApplied: false,
          breakevenStop: entry + pendingEntry.direction * roundTripCost,
        };
        openedPositionThisBar = true;
      }
      pendingEntry = null;
    }
    if (position && i >= position.entryIndex) {
      const long = position.direction === 1;
      const effectiveStop = position.breakevenApplied ? position.breakevenStop : position.stop;
      const stopHit = long ? bar.low <= effectiveStop : bar.high >= effectiveStop;
      const tp1Hit = long ? bar.high >= position.tp1 : bar.low <= position.tp1;
      const tp2Hit = long ? bar.high >= position.tp2 : bar.low <= position.tp2;
      const beTriggerR = Number(variant.breakevenAtR);
      const beTriggerHit = Number.isFinite(beTriggerR)
        && (long ? bar.high >= position.entry + position.risk * beTriggerR : bar.low <= position.entry - position.risk * beTriggerR);
      // M1 candles do not show intrabar path. If a stop and target share a bar,
      // assume the stop filled first, consistently favoring the conservative side.
      if (stopHit) {
        const stopFill = long
          ? Math.min(effectiveStop, bar.open)
          : Math.max(effectiveStop, bar.open);
        const remainingR = long
          ? (stopFill - position.entry) / position.risk
          : (position.entry - stopFill) / position.risk;
        const grossR = position.tp1Taken
          ? (TP1_R * TP1_SIZE_PCT / 100) + (remainingR * (1 - TP1_SIZE_PCT / 100))
          : remainingR;
        finishTrade(i, grossR, position.breakevenApplied ? "BREAK_EVEN" : "SL");
      } else if (tp2Hit) {
        finishTrade(i, TP1_R * 0.5 + TP2_R * 0.5, "TP2");
      } else if (tp1Hit && !position.tp1Taken) {
        position.tp1Taken = true;
      }
      // The BE stop becomes active on the next candle. Intrabar OHLC cannot tell
      // whether the trigger or a reversal happened first, so this avoids lookahead.
      if (position && beTriggerHit) position.breakevenApplied = true;
      if (position && variant.breakevenAfterTp1 && position.tp1Taken) position.breakevenApplied = true;
      if (position && (i - position.entryIndex) * intervalMinutes >= (variant.maxHoldMinutes ?? MAX_HOLD_MINUTES)) {
        const closeR = long
          ? (bar.close - position.entry) / position.risk
          : (position.entry - bar.close) / position.risk;
        const grossR = position.tp1Taken ? TP1_R * 0.5 + closeR * 0.5 : closeR;
        finishTrade(i, grossR, "TIME");
      }
    }

    const evaluated = !hadPositionAtBarStart && !position
      ? evaluateSignal(data, i, pivots, previousFinalDirection, {
        ...variant,
        method: "PRICE_ACTION_V2",
        setupState,
        spreadPct: config.spreadPctByTime?.get(bar.time) ?? config.spreadPct,
        tickSize: config.tickSize,
      })
      : { finalDirection: 0, signal: null };
    if (!position && !hadPositionAtBarStart && !openedPositionThisBar
      && signalPassesResearchFilters(data, i, evaluated.signal, variant)) {
      pendingEntry = evaluated.signal;
    }
    previousFinalDirection = evaluated.finalDirection;
  }

  if (position) {
    const lastIndex = bars.length - 1;
    const bar = bars[lastIndex];
    const unrealizedR = position.direction === 1
      ? (bar.close - position.entry) / position.risk
      : (position.entry - bar.close) / position.risk;
    const grossR = position.tp1Taken
      ? TP1_R * 0.5 + unrealizedR * 0.5
      : unrealizedR;
    finishTrade(lastIndex, grossR, "OPEN_AT_DATA_END");
  }

  return {
    pair,
    bars: bars.length,
    from: new Date(bars[0].time).toISOString(),
    to: new Date(bars.at(-1).time).toISOString(),
    warmupThrough: new Date(researchStart).toISOString(),
    folds: foldTrades,
  };
}

function walkForwardM1BidAsk(pair, bars, config, variant, intervalMinutes, quoteBuckets) {
  const data = prepare(bars);
  const researchStart = bars[0].time + WARMUP_DAYS * DAY_MS;
  const foldTrades = Array.from({ length: FOLD_COUNT }, () => []);
  let previousFinalDirection = 0;
  let position = null;
  let pendingEntry = null;
  const setupState = createPriceActionSetupState();

  function finishTrade(entryIndex, exitTime, barsHeld, reason) {
    const fold = Math.floor((bars[entryIndex].time - researchStart) / (FOLD_DAYS * DAY_MS));
    if (fold >= 0 && fold < FOLD_COUNT) {
      const totalCosts = position.spreadDollars + position.commissionDollars + position.slipDollars;
      const executableR = position.realizedPnl / position.risk;
      foldTrades[fold].push({
        pair,
        direction: position.direction,
        entryTime: position.entryTime,
        exitTime,
        barsHeld,
        grossR: executableR + totalCosts / position.risk,
        risk: position.risk,
        spreadDollars: position.spreadDollars,
        commissionDollars: position.commissionDollars,
        slipDollars: position.slipDollars,
        stopSlippageDollars: config.tickSize * SLIPPAGE_TICKS_PER_SIDE,
        riskIncludesSpread: true,
        reason,
      });
    }
    position = null;
  }

  function closeFraction(quote, targetPrice, fraction, { marketExit = false, stopExit = false } = {}) {
    if (!position || !(fraction > 0)) return;
    const long = position.direction === 1;
    const quoteOpen = long ? quote.bid.open : quote.ask.open;
    const quoteClose = long ? quote.bid.close : quote.ask.close;
    const spread = Math.max(0, quote.ask.close - quote.bid.close);
    let fill = targetPrice;
    if (stopExit) {
      fill = long ? Math.min(targetPrice, quoteOpen) : Math.max(targetPrice, quoteOpen);
    } else if (marketExit) {
      fill = quoteClose;
    } else {
      // A resting limit may receive price improvement after an opening gap.
      fill = long ? Math.max(targetPrice, quoteOpen) : Math.min(targetPrice, quoteOpen);
    }
    const slip = marketExit || stopExit ? config.tickSize * SLIPPAGE_TICKS_PER_SIDE : 0;
    fill -= position.direction * slip;
    position.realizedPnl += position.direction * (fill - position.entry) * fraction;
    position.spreadDollars += spread * 0.5 * fraction;
    position.commissionDollars += Math.max(fill, 0) * COMMISSION_PCT_PER_SIDE / 100 * fraction;
    position.slipDollars += slip * fraction;
    position.remainingFraction = Math.max(0, position.remainingFraction - fraction);
  }

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const quotes = quoteBuckets.get(bar.time) || [];
    const hadPositionAtBarStart = position !== null;
    let openedPositionThisBar = false;

    if (!position && pendingEntry && quotes[0]?.time === bar.time) {
      const firstQuote = quotes[0];
      const long = pendingEntry.direction === 1;
      const rawEntry = long ? firstQuote.ask.open : firstQuote.bid.open;
      const entrySlippage = config.tickSize * SLIPPAGE_TICKS_PER_SIDE;
      const entry = rawEntry + pendingEntry.direction * entrySlippage;
      const rawRisk = pendingEntry.direction === 1
        ? entry - pendingEntry.stop
        : pendingEntry.stop - entry;
      const stopMultiplier = Math.max(1, Number(variant.stopMultiplier) || 1);
      const risk = rawRisk * stopMultiplier;
      const stop = entry - pendingEntry.direction * risk;
      const entrySpreadPrice = Math.max(0, firstQuote.ask.open - firstQuote.bid.open);
      const entrySpreadPct = firstQuote.bid.open > 0 ? entrySpreadPrice / firstQuote.bid.open * 100 : 0;
      const roundTripCost = entry * entrySpreadPct / 100
        + entry * 2 * COMMISSION_PCT_PER_SIDE / 100
        + config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2;
      const stopStillValid = rawRisk > 0 && rawRisk <= pendingEntry.averageRange * PA_MAX_STOP_RANGE_MULTIPLIER;
      const costsStillValid = risk > 0 && roundTripCost / risk <= PA_MAX_COST_R;
      if (stopStillValid && costsStillValid) {
        position = {
          direction: pendingEntry.direction,
          entry,
          entryTime: firstQuote.time,
          entryIndex: i,
          stop,
          risk,
          tp1: entry + pendingEntry.direction * risk * TP1_R,
          tp2: entry + pendingEntry.direction * risk * TP2_R,
          tp1Taken: false,
          breakevenApplied: false,
          breakevenStop: entry + pendingEntry.direction * (entry * 2 * COMMISSION_PCT_PER_SIDE / 100 + entrySlippage),
          remainingFraction: 1,
          realizedPnl: 0,
          spreadDollars: entrySpreadPrice * 0.5,
          commissionDollars: entry * COMMISSION_PCT_PER_SIDE / 100,
          slipDollars: entrySlippage,
          heldMinutes: 0,
          lastQuote: firstQuote,
        };
        openedPositionThisBar = true;
      }
      pendingEntry = null;
    }
    if (!position && pendingEntry && quotes[0]?.time !== bar.time) pendingEntry = null;

    for (const quote of quotes) {
      if (!position) break;
      const long = position.direction === 1;
      const executable = long ? quote.bid : quote.ask;
      position.heldMinutes += 1;
      position.lastQuote = quote;
      const effectiveStop = position.breakevenApplied ? position.breakevenStop : position.stop;
      const stopHit = long ? executable.low <= effectiveStop : executable.high >= effectiveStop;
      const tp1Hit = long ? executable.high >= position.tp1 : executable.low <= position.tp1;
      const tp2Hit = long ? executable.high >= position.tp2 : executable.low <= position.tp2;

      // Resolve stop/target collisions at the M1 level conservatively. The
      // within-minute path is still unknowable from OHLC, so stop wins ties.
      if (stopHit) {
        closeFraction(quote, effectiveStop, position.remainingFraction, { stopExit: true });
        const reason = position.breakevenApplied ? "BREAK_EVEN" : "SL";
        finishTrade(i, quote.time + 60_000, position.heldMinutes, reason);
        continue;
      }

      if (tp1Hit && !position.tp1Taken) {
        const partial = Math.min(TP1_SIZE_PCT / 100, position.remainingFraction);
        closeFraction(quote, position.tp1, partial);
        position.tp1Taken = true;
      }
      if (position && tp2Hit && position.remainingFraction > 0) {
        closeFraction(quote, position.tp2, position.remainingFraction);
        finishTrade(i, quote.time + 60_000, position.heldMinutes, "TP2");
        continue;
      }

      const beTriggerR = Number(variant.breakevenAtR);
      const beTriggerHit = Number.isFinite(beTriggerR)
        && (long
          ? executable.high >= position.entry + position.risk * beTriggerR
          : executable.low <= position.entry - position.risk * beTriggerR);
      // As in the timeframe-bar study, a BE move triggered in this minute only
      // becomes active on the next minute; OHLC cannot reveal intraminute order.
      if (beTriggerHit || (variant.breakevenAfterTp1 && position.tp1Taken)) position.breakevenApplied = true;

      const maxHoldMinutes = Math.max(1, Number(variant.maxHoldMinutes) || MAX_HOLD_MINUTES);
      if (position && position.heldMinutes >= maxHoldMinutes) {
        closeFraction(quote, long ? quote.bid.close : quote.ask.close, position.remainingFraction, { marketExit: true });
        finishTrade(i, quote.time + 60_000, position.heldMinutes, "TIME");
      }
    }

    const evaluated = !hadPositionAtBarStart && !position
      ? evaluateSignal(data, i, null, previousFinalDirection, {
        ...variant,
        method: "PRICE_ACTION_V2",
        setupState,
        spreadPct: config.spreadPctByTime?.get(bar.time) ?? config.spreadPct,
        tickSize: config.tickSize,
      })
      : { finalDirection: 0, signal: null };
    if (!position && !hadPositionAtBarStart && !openedPositionThisBar
      && signalPassesResearchFilters(data, i, evaluated.signal, variant)) {
      pendingEntry = evaluated.signal;
    }
    previousFinalDirection = evaluated.finalDirection;
  }

  if (position?.lastQuote) {
    const lastIndex = bars.length - 1;
    const quote = position.lastQuote;
    const closingPrice = position.direction === 1 ? quote.bid.close : quote.ask.close;
    closeFraction(quote, closingPrice, position.remainingFraction, { marketExit: true });
    finishTrade(lastIndex, quote.time + 60_000, position.heldMinutes, "OPEN_AT_DATA_END");
  }

  return {
    pair,
    bars: bars.length,
    from: new Date(bars[0].time).toISOString(),
    to: new Date(bars.at(-1).time).toISOString(),
    warmupThrough: new Date(researchStart).toISOString(),
    folds: foldTrades,
  };
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function stableSeed(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0 || 1;
}

function weeklyBlockBootstrap95(trades, spreadMultiple, seedText) {
  const weekly = new Map();
  for (const trade of trades) {
    const time = new Date(trade.entryTime);
    const day = Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate());
    const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
    const key = new Date(monday).toISOString().slice(0, 10);
    const sample = weekly.get(key) || { sumR: 0, trades: 0 };
    const totalCost = trade.spreadDollars * spreadMultiple + trade.commissionDollars + trade.slipDollars;
    sample.sumR += trade.grossR - totalCost / trade.risk;
    sample.trades += 1;
    weekly.set(key, sample);
  }
  const blocks = [...weekly.values()];
  if (blocks.length < 20) {
    return { method: "UTC calendar-week cluster bootstrap", weeks: blocks.length, replicates: BOOTSTRAP_REPLICATES, lower95R: null, upper95R: null };
  }

  let state = stableSeed(seedText);
  const draws = new Float64Array(BOOTSTRAP_REPLICATES);
  for (let iteration = 0; iteration < BOOTSTRAP_REPLICATES; iteration += 1) {
    let sumR = 0;
    let tradeCount = 0;
    for (let sample = 0; sample < blocks.length; sample += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const block = blocks[(state >>> 0) % blocks.length];
      sumR += block.sumR;
      tradeCount += block.trades;
    }
    draws[iteration] = tradeCount ? sumR / tradeCount : 0;
  }
  draws.sort();
  return {
    method: "UTC calendar-week cluster bootstrap",
    weeks: blocks.length,
    replicates: BOOTSTRAP_REPLICATES,
    lower95R: Math.round(percentile(draws, 0.025) * 1000) / 1000,
    upper95R: Math.round(percentile(draws, 0.975) * 1000) / 1000,
  };
}

function summarize(trades, spreadMultiple) {
  if (!trades.length) {
    return { trades: 0, winRatePct: 0, avgR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, maxDrawdownPct: 0, maxLossStreak: 0, medianStopDistancePrice: null, p90StopDistancePrice: null, xauMinLotLossP90Usd: null, xauCapitalAtRisk05PctP90Usd: null };
  }
  const stopDistances = trades.map((trade) => trade.risk);
  const xauMinLotLosses = trades[0].pair === "XAUUSD"
    ? trades.map((trade) => trade.riskIncludesSpread
      ? trade.risk + trade.stopSlippageDollars + trade.commissionDollars
        + trade.spreadDollars * Math.max(0, spreadMultiple - 1)
      : trade.risk + trade.spreadDollars * spreadMultiple + trade.commissionDollars + trade.slipDollars)
    : [];
  const xauMinLotLossP90Usd = xauMinLotLosses.length ? percentile(xauMinLotLosses, 0.90) : null;
  const netR = trades.map((trade) => {
    const totalCost = trade.spreadDollars * spreadMultiple + trade.commissionDollars + trade.slipDollars;
    return trade.grossR - totalCost / trade.risk;
  });
  let totalR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let equity = INITIAL_EQUITY;
  let peakEquity = INITIAL_EQUITY;
  let maxDrawdownPct = 0;
  let grossWins = 0;
  let grossLosses = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  let totalHold = 0;
  let totalCostR = 0;
  const byExit = {};
  const byDirection = { long: { trades: 0, totalR: 0 }, short: { trades: 0, totalR: 0 } };
  for (let i = 0; i < trades.length; i += 1) {
    const value = netR[i];
    const trade = trades[i];
    totalR += value;
    peakR = Math.max(peakR, totalR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - totalR);
    const costR = trade.grossR - value;
    totalCostR += costR;
    totalHold += trade.barsHeld;
    if (!byExit[trade.reason]) byExit[trade.reason] = { trades: 0, netR: 0 };
    byExit[trade.reason].trades += 1;
    byExit[trade.reason].netR += value;
    const direction = trade.direction === 1 ? "long" : "short";
    byDirection[direction].trades += 1;
    byDirection[direction].totalR += value;
    if (value > 0) {
      grossWins += value;
      lossStreak = 0;
    } else {
      if (value < 0) grossLosses += Math.abs(value);
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
    equity *= 1 + (RISK_PCT / 100) * value;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakEquity - equity) / peakEquity * 100);
  }
  return {
    trades: trades.length,
    winRatePct: Math.round(netR.filter((value) => value > 0).length / trades.length * 1000) / 10,
    avgR: Math.round(totalR / trades.length * 1000) / 1000,
    totalR: Math.round(totalR * 100) / 100,
    profitFactor: Math.round((grossLosses > 0 ? grossWins / grossLosses : grossWins) * 1000) / 1000,
    avgCostR: Math.round(totalCostR / trades.length * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdownR * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
    maxLossStreak,
    averageHoldMinutes: Math.round(totalHold / trades.length * 10) / 10,
    equityFrom1000At05PctRisk: Math.round(equity * 100) / 100,
    medianStopDistancePrice: Math.round(percentile(stopDistances, 0.50) * 1000) / 1000,
    p90StopDistancePrice: Math.round(percentile(stopDistances, 0.90) * 1000) / 1000,
    xauMinLotLossP90Usd: xauMinLotLossP90Usd == null ? null : Math.round(xauMinLotLossP90Usd * 100) / 100,
    xauCapitalAtRisk05PctP90Usd: xauMinLotLossP90Usd == null ? null : Math.round(xauMinLotLossP90Usd / (RISK_PCT / 100) * 100) / 100,
    byExit: Object.fromEntries(Object.entries(byExit).map(([reason, value]) => [reason, {
      trades: value.trades,
      netR: Math.round(value.netR * 100) / 100,
    }])),
    byDirection: Object.fromEntries(Object.entries(byDirection).map(([side, value]) => [side, {
      trades: value.trades,
      avgR: value.trades ? Math.round(value.totalR / value.trades * 1000) / 1000 : 0,
    }])),
  };
}

function runPair(pair, config, intervalMinutes) {
  const bidM1 = loadBars(config.bidFile);
  const askM1 = loadBars(config.askFile);
  if (!bidM1.length || !askM1.length) return { pair, error: "BID/ASK data file missing.", bidFile: config.bidFile, askFile: config.askFile };
  const bars = resampleBars(bidM1, intervalMinutes);
  const askBars = resampleBars(askM1, intervalMinutes);
  if (!bars.length) return { pair, error: "Fichier de données absent." };
  const spread = spreadStatistics(bars, askBars);
  if (!Number.isFinite(spread.p75Pct)) return { pair, error: "No paired BID/ASK spread observations." };
  const spreadPctByTime = spreadPercentMap(bars, askBars);
  const m1QuoteBuckets = buildM1QuoteBuckets(bidM1, askM1, intervalMinutes);
  if (EXECUTION_MODEL === "m1_bid_ask" && !m1QuoteBuckets.size) {
    return { pair, error: "No aligned M1 BID/ASK execution bars.", bidFile: config.bidFile, askFile: config.askFile };
  }
  const meta = JSON.parse(readFileSync(join(DATA_DIR, "deriv-mt5-ytd-2026-metadata.json"), "utf8"));
  const instrument = meta.pairs[pair];
  if (!instrument) return { pair, error: "Instrument metadata missing." };
  const runConfig = { ...config, tickSize: instrument.point, spreadPct: spread.p75Pct, spreadPctByTime };
  const simulate = (variant) => EXECUTION_MODEL === "m1_bid_ask"
    ? walkForwardM1BidAsk(pair, bars, runConfig, variant, intervalMinutes, m1QuoteBuckets)
    : walkForward(pair, bars, runConfig, variant, intervalMinutes);
  const result = simulate(PA_VARIANTS[0]);
  const variantResults = {};
  const variantsToRun = PA_VARIANTS.filter((variant) => (!variant.onlyPair || variant.onlyPair === pair)
    && (!variant.onlyTimeframe || variant.onlyTimeframe === intervalMinutes));
  for (const variant of variantsToRun) {
    const variantResult = variant.key === PA_VARIANTS[0].key ? result : simulate(variant);
    const allTrades = variantResult.folds.flat();
    variantResults[variant.key] = {
      label: variant.label,
      folds: variantResult.folds.map((trades, index) => ({
        fold: index + 1,
        byCost: SPREAD_CASES.map((cost) => ({ spread: cost.label, ...summarize(trades, cost.multiple) })),
      })),
      overallByCost: SPREAD_CASES.map((cost) => {
        const summary = summarize(allTrades, cost.multiple);
        if (BOOTSTRAP_VARIANT_KEYS.has(variant.key)) {
          summary.weeklyBlockBootstrap95 = weeklyBlockBootstrap95(
            allTrades,
            cost.multiple,
            `${pair}|M${intervalMinutes}|${variant.key}|${cost.multiple}`,
          );
        }
        return { spread: cost.label, ...summary };
      }),
    };
  }
  return {
    pair,
    timeframe: "M" + intervalMinutes,
    data: {
      bidFile: config.bidFile,
      askFile: config.askFile,
      executionModel: EXECUTION_MODEL,
      bars: result.bars,
      m1ExecutionBuckets: EXECUTION_MODEL === "m1_bid_ask" ? m1QuoteBuckets.size : null,
      from: result.from,
      to: result.to,
      warmupThrough: result.warmupThrough,
    },
    spread,
    folds: result.folds.map((trades, index) => ({
      fold: index + 1,
      from: trades[0] ? new Date(trades[0].entryTime).toISOString().slice(0, 10) : null,
      to: trades.at(-1) ? new Date(trades.at(-1).entryTime).toISOString().slice(0, 10) : null,
      byCost: SPREAD_CASES.map((cost) => ({
        spread: cost.label,
        ...summarize(trades, cost.multiple),
      })),
    })),
    overallByCost: SPREAD_CASES.map((cost) => ({
      spread: cost.label,
      ...summarize(result.folds.flat(), cost.multiple),
    })),
    variants: variantResults,
  };
}

const selectedPairResults = {};
for (const [pair, config] of Object.entries(PAIRS)) {
  if (PAIR_RUN_FILTER.size && !PAIR_RUN_FILTER.has(pair)) continue;
  const timeframes = TIMEFRAME_RUN_FILTER.size
    ? [1, 5, 15].filter((minutes) => TIMEFRAME_RUN_FILTER.has(minutes))
    : pair === "XAUUSD" ? [5, 1, 15] : [5];
  selectedPairResults[pair] = Object.fromEntries(timeframes.map((minutes) => [`M${minutes}`, runPair(pair, config, minutes)]));
}

const report = {
  experiment: "KRONOS Price Action scalp v2 / robustness research",
  rules: {
    priceActionEngineVersion: KRONOS_PRICE_ACTION_VERSION,
    executionModel: EXECUTION_MODEL,
    chartTimeframes: ["M1", "M5", "M15"],
    entry: "Two separate setups: close breakout then retest/reclaim within 8 bars, or confirmed rejection at a support/resistance from the prior 30 bars. Signal at close; fill at next bar open.",
    stop: "Behind the level and confirmation candle extreme with max(0.10 x 14-bar average range, 2 ticks); reject risk above 3 x average range.",
    exit: "30 minutes maximum; compare base management, cost-adjusted break-even and widened stops with targets recalculated in R.",
    riskForCompounding: RISK_PCT + "% du solde courant par trade (illustration en R)",
    costs: {
      source: "Deriv MT5 Demo, spread historique par bougie fourni dans les rates MT5; spreads p50/p75/p90 calcules par paire et timeframe",
      baseline: EXECUTION_MODEL === "m1_bid_ask"
        ? "Entree sur ASK pour les achats et BID pour les ventes; sorties sur le cote executable correspondant en M1. Le spread est integre aux fills; les scenarios 1.5x/2x ajoutent le surcout aux memes chemins, sans recalculer les declenchements."
        : "spread MT5 variable a la barre d'entree; couts du meme trade stresses a 1.5x et 2x",
      commissionAssumption: "0% per side, matching the public Deriv MT5 Standard account description; the attached terminal was Deriv-Demo and did not expose the live account type",
      sensitivity: SPREAD_CASES.map((value) => value.label),
      slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
      commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    },
    method: "Price Action only. One open position. Entry is skipped if estimated round-trip spread, commission and slippage exceed 0.15R.",
    variants: PA_VARIANTS.map(({ key, label, onlyPair, onlyTimeframe, sessionUtc, m15Alignment, directionFilter }) => ({
      key,
      label,
      ...(onlyPair ? { onlyPair } : {}),
      ...(onlyTimeframe ? { onlyTimeframe } : {}),
      ...(sessionUtc ? { sessionUtc } : {}),
      ...(m15Alignment ? { m15Alignment } : {}),
      ...(Number.isFinite(directionFilter) ? { directionFilter } : {}),
    })),
    sessionDefinition: "Diagnostic XAUUSD M5: UTC 07:00 inclus a 17:00 exclus, compare au signal sans filtre horaire.",
    m15Structure: "Diagnostic XAUUSD M5: direction permise seulement si la derniere bougie M15 cloturee est alignee avec EMA20 et EMA50; les bougies M15 en cours ne sont jamais lues.",
    validation: WARMUP_DAYS + " jours de chauffe puis " + FOLD_COUNT + " plis chronologiques de " + FOLD_DAYS + " jours; les filtres directionnels sont diagnostiques, et les plis tardifs ne sont pas un holdout independant apres inspection de la famille sur cet historique",
    candleAmbiguity: EXECUTION_MODEL === "m1_bid_ask"
      ? "Les déclenchements sont suivis sur OHLC M1 BID/ASK; si stop et objectif sont touchés dans la même minute, le stop est pris en premier. Le chemin interne à la minute reste inconnu."
      : "si stop et objectif sont touchés dans la même bougie M1, le stop est pris en premier",
    limits: [
      EXECUTION_MODEL === "m1_bid_ask"
        ? "Les sorties M5/M15 sont détaillées sur M1, mais une bougie M1 ne révèle toujours pas l'ordre exact intraminute; le stop gagne les collisions."
        : "Les OHLC M1/M5/M15 ne montrent pas l'ordre exact des prix à l'intérieur d'une bougie; le stop gagne les collisions.",
      EXECUTION_MODEL === "m1_bid_ask"
        ? "L'ASK M1 est reconstruit depuis le BID et le champ spread MT5 de la minute, pas depuis un historique tick par tick; le stress 1.5x/2x ne recalcule pas les déclenchements."
        : "le spread historique de la bougie d'entree sert d'estimation du cout de round-trip; le stress 1.5x/2x revalorise les memes trades sans recalculer le filtre",
      "le test R ne connaît pas le lot minimum, le levier, les exigences de marge, le swap ni les rejets du courtier",
      "le moteur local reproduit les règles Pine, mais n'est pas le moteur Strategy Tester de TradingView",
    ],
  },
  pairs: selectedPairResults,
};

report.experiment = `KRONOS Price Action / Deriv MT5 Demo / exits and focused XAU M5 filter diagnostics / ${EXECUTION_MODEL}`;
report.rules.entry = "Close breakout through prior 30-bar level then retest/reclaim within 8 bars, or confirmed wick/engulf rejection at prior 30-bar support/resistance; signal at bar close, fill at next bar open, one position at a time.";
report.rules.stop = "Base structurelle; variantes stop x1.25/x1.50 elargissent le stop autour de l'entree et recalculent TP1/TP2 a +1R/+1.6R. Le risque en argent est maintenu constant en reduisant la taille de position.";
report.rules.exit = "Horizon 30 min; TP1 ferme 50% a +1R et TP2 le reste a +1.6R. Compare sans BE, BE apres +0.5R sans partial avant TP1, ou BE apres TP1. Le niveau BE est majore des couts estimes.";
report.rules.candleAmbiguity = EXECUTION_MODEL === "m1_bid_ask"
  ? "Les sorties sont évaluées sur M1 BID/ASK; si stop et objectif sont touchés dans la même minute, le stop est pris en premier. Le chemin interne à la minute reste inconnu."
  : "Si stop et objectif sont touchés dans la même bougie M1 ou M5, le stop est pris en premier.";

const outputPath = join(DATA_DIR, `kronos-exit-management-deriv-ytd-2026${OUTPUT_SUFFIX}-results.json`);
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
const md = [
  `# KRONOS Price Action - exit and filter diagnostics - Deriv MT5 Demo 2026 YTD${OUTPUT_TAG ? ` (${OUTPUT_TAG})` : ""}`,
  "",
  `Bougies: ${(() => { const sample = Object.values(report.pairs).flatMap((pair) => Object.values(pair)).find((value) => value.data); return sample ? `${sample.data.from} a ${sample.data.to}` : "plage de donnees indisponible"; })()} UTC. Source: Deriv-Demo dans MT5. M5/M15 sont reconstruits depuis M1; les barres incompletes sont exclues.`,
  "",
  EXECUTION_MODEL === "m1_bid_ask"
    ? "Les signaux restent calculés sur le timeframe choisi; les entrées/sorties sont suivies minute par minute, achats exécutés ASK/BID et ventes BID/ASK. L'ASK est reconstruit avec le spread MT5 par minute. Les stress 1.5x/2x revalorisent les mêmes chemins sans rejouer les déclenchements."
    : "Le cout de spread varie selon le spread MT5 enregistre sur chaque bougie; le p75 affiche est descriptif. Les colonnes de stress revalorisent les memes trades a 1.5x et 2x le spread observe.",
  "",
  "| Marche | UT | Gestion | Spread p75 (%) | Trades | Gagnants (%) | R moyen | PF | R total | DD max (%) | R moyen, spread 2x |",
  "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const [pair, timeframes] of Object.entries(report.pairs)) {
  for (const timeframe of Object.keys(timeframes)) {
    const result = timeframes[timeframe];
    if (result.error) {
      md.push(`| ${pair} | ${timeframe} | ERROR: ${result.error} | - | - | - | - | - | - | - | - |`);
      continue;
    }
    for (const key of Object.keys(result.variants)) {
      const variant = result.variants[key];
      const base = variant.overallByCost[0];
      const stress = variant.overallByCost.find((value) => value.spread === "Deriv bar spread 2.0x");
      md.push(`| ${pair} | ${timeframe} | ${variant.label} | ${result.spread.p75Pct.toFixed(6)} | ${base.trades} | ${base.winRatePct} | ${base.avgR} | ${base.profitFactor} | ${base.totalR} | ${base.maxDrawdownPct} | ${stress?.avgR ?? "-"} |`);
    }
  }
}
const cases = [];
for (const [pair, timeframes] of Object.entries(report.pairs)) {
  for (const timeframe of Object.keys(timeframes)) {
    const result = timeframes[timeframe];
    if (result.error) continue;
    for (const [key, variant] of Object.entries(result.variants)) {
      const base = variant.overallByCost[0];
      const stress = variant.overallByCost.find((value) => value.spread === "Deriv bar spread 2.0x");
      cases.push({
        pair,
        timeframe,
        key,
        label: variant.label,
        trades: base.trades,
        avgR: base.avgR,
        profitFactor: base.profitFactor,
        stressAvgR: stress?.avgR ?? 0,
        maxDrawdownPct: base.maxDrawdownPct,
        positiveFolds: variant.folds.filter((fold) => fold.byCost[0].avgR > 0).length,
      });
    }
  }
}
const positiveBase = cases.filter((value) => value.avgR > 0);
const positiveStress = cases.filter((value) => value.avgR > 0 && value.stressAvgR > 0);
const stressPositiveUnder30 = positiveStress.filter((value) => value.trades < 30);
const stressPositiveOver30 = positiveStress.filter((value) => value.trades >= 30);
const atLeast100 = cases.filter((value) => value.trades >= 100);
const highSamplePositive = atLeast100.filter((value) => value.avgR > 0);

const xauM5 = report.pairs.XAUUSD?.M5;
if (xauM5 && !xauM5.error) {
  const focusKeys = ["retest_sl_150", "retest_sl_150_liquid_session", "retest_sl_150_m15_aligned", "retest_sl_150_short_only", "retest_sl_150_short_m15_bear", "retest_sl_150_long_only"];
  const foldWindow = (variant, costIndex, start, end) => {
    const rows = variant.folds.slice(start, end).map((fold) => fold.byCost[costIndex]);
    const trades = rows.reduce((sum, row) => sum + row.trades, 0);
    const totalR = rows.reduce((sum, row) => sum + row.totalR, 0);
    return { trades, avgR: trades ? Math.round(totalR / trades * 1000) / 1000 : 0 };
  };
  md.push(
    "",
    "## Diagnostic XAUUSD M5 : filtres du retest stop x1.5",
    "",
    "Comparaison descriptive des plis 1-3 (developpement) aux plis 4-5 (periode tardive), puis aux memes trades recalcules avec spread x2. Les filtres directionnels sont des hypotheses de recherche, pas des recommandations de trading.",
    "Les plis 4-5 ne sont pas un holdout statistiquement vierge : la famille de strategie a ete reperee apres inspection des resultats du meme historique. Il faut une validation sur de nouvelles donnees avant toute promotion.",
    "",
    "| Variante | Trades plis 1-3 | R/trade plis 1-3 | Trades plis 4-5 | R/trade plis 4-5 | R/trade plis 4-5, spread x2 |",
    "|---|---:|---:|---:|---:|---:|",
  );
  for (const key of focusKeys) {
    const variant = xauM5.variants[key];
    if (!variant) continue;
    const development = foldWindow(variant, 0, 0, 3);
    const later = foldWindow(variant, 0, 3, 5);
    const laterStress = foldWindow(variant, 2, 3, 5);
    md.push(`| ${variant.label} | ${development.trades} | ${development.avgR} | ${later.trades} | ${later.avgR} | ${laterStress.avgR} |`);
  }
}
const m5DirectionPairs = Object.entries(report.pairs)
  .map(([pair, timeframes]) => ({ pair, result: timeframes.M5 }))
  .filter(({ result }) => result && !result.error);
if (m5DirectionPairs.length) {
  md.push(
    "",
    "## Controle directionnel intermarche M5",
    "",
    "Ce controle verifie si l'asymetrie vendeuse observee sur XAU se repete sur les autres instruments. C'est un diagnostic transversal, pas une validation hors echantillon : les memes dates sont utilisees sur chaque marche.",
    "",
    "| Marche | Variante | Trades | R/trade | PF | Plis positifs | R/trade au spread x2 |",
    "|---|---|---:|---:|---:|---:|---:|",
  );
  for (const { pair, result } of m5DirectionPairs) {
    for (const key of ["retest_sl_150", "retest_sl_150_m5_short_only", "retest_sl_150_m5_long_only"]) {
      const variant = result.variants[key];
      if (!variant) continue;
      const base = variant.overallByCost[0];
      const stress = variant.overallByCost[2];
      const positiveFolds = variant.folds.filter((fold) => fold.byCost[0].avgR > 0).length;
      md.push(`| ${pair} | ${key} | ${base.trades} | ${base.avgR} | ${base.profitFactor} | ${positiveFolds}/5 | ${stress.avgR} |`);
    }
  }
}
if (m5DirectionPairs.length) {
  md.push(
    "",
    "## Incertitude de l'esperance short-only M5",
    "",
    `Intervalle percentile a 95% par bootstrap de ${BOOTSTRAP_REPLICATES} repetitions sur des semaines UTC entieres, pour garder ensemble les trades d'une meme semaine. Cet intervalle mesure l'incertitude d'echantillonnage conditionnelle aux trades historiques; il ne corrige pas la selection apres coup, les changements de regime ni les erreurs de reconstruction ASK.`,
    "",
    "| Marche | Cout | Trades | Semaines actives | R/trade | Intervalle bootstrap 95% |",
    "|---|---|---:|---:|---:|---:|",
  );
  for (const { pair, result } of m5DirectionPairs) {
    const variant = result.variants.retest_sl_150_m5_short_only;
    if (!variant) continue;
    for (const costIndex of [0, 2]) {
      const summary = variant.overallByCost[costIndex];
      const ci = summary.weeklyBlockBootstrap95;
      const range = ci?.lower95R == null ? "non calcule (<20 semaines)" : `[${ci.lower95R}, ${ci.upper95R}]`;
      md.push(`| ${pair} | ${summary.spread} | ${summary.trades} | ${ci?.weeks ?? 0} | ${summary.avgR} | ${range} |`);
    }
  }
}
if (xauM5 && !xauM5.error) {
  md.push(
    "",
    "## Faisabilite petit compte XAUUSD (estimation)",
    "",
    "La specification publique Deriv consultable (https://ae.deriv.com/trading-specifications) indique XAUUSD: taille de contrat 100 oz/lot, volume minimal 0.01 lot. A 0.01 lot, un mouvement de 1 USD/oz represente environ 1 USD de P/L avant couts. Ces valeurs doivent etre verifiees dans la specification du symbole de ton propre serveur MT5.",
    "Le capital affiche est le minimum theorique pour que le risque estime au 90e percentile, frais de spread et slippage inclus, reste sous 0.5% du solde. Il n'inclut ni gap, glissement exceptionnel, marge libre, conversion de devise ni contrainte de volume propre au compte.",
    "",
    "| Variante | Perte estimee p90 au lot min. (spread x1) | Solde theorique pour risque <=0.5% | Perte p90 au spread x2 | Solde theorique x2 |",
    "|---|---:|---:|---:|---:|",
  );
  for (const key of ["retest_sl_150", "retest_sl_150_short_only", "retest_sl_150_short_m15_bear"]) {
    const variant = xauM5.variants[key];
    if (!variant) continue;
    const base = variant.overallByCost[0];
    const stress = variant.overallByCost[2];
    md.push(`| ${variant.label} | ${base.xauMinLotLossP90Usd} USD | ${base.xauCapitalAtRisk05PctP90Usd} USD | ${stress.xauMinLotLossP90Usd} USD | ${stress.xauCapitalAtRisk05PctP90Usd} USD |`);
  }
}
md.push(
  "",
  "## Lecture quantitative",
  "",
  `- ${cases.length} variantes-marche-unite de temps ont ete evaluees dans ce lancement sur ${Object.keys(report.pairs).join(", ") || "aucune paire"}; ${positiveBase.length} ont un R moyen positif avec les spreads Deriv observes; ${positiveStress.length} le restent avec le spread double.`,
  `- Parmi les ${atLeast100.length} combinaisons avec au moins 100 trades, ${highSamplePositive.length} sont positives avec les spreads observes; ${atLeast100.filter((value) => value.stressAvgR > 0).length} restent positives au spread double.`,
  `- Sous spread double, ${stressPositiveUnder30.length}/${positiveStress.length} variantes positives ont moins de 30 trades. Les autres restent exploratoires et demandent un futur hors-echantillon.`,
  "- Variantes positives avec au moins 30 trades:",
);
for (const value of positiveBase.filter((item) => item.trades >= 30).sort((a, b) => b.avgR - a.avgR).slice(0, 5)) {
  md.push(`  - ${value.pair} ${value.timeframe}, ${value.key}: ${value.trades} trades, ${value.avgR} R/trade, PF ${value.profitFactor}, plis positifs ${value.positiveFolds}/5, stress spread x2 ${value.stressAvgR} R/trade.`);
}
for (const value of stressPositiveOver30) {
  md.push(`  - Toujours positif a 2x: ${value.pair} ${value.timeframe}, ${value.key}: ${value.trades} trades, ${value.avgR} R/trade de base, ${value.stressAvgR} R/trade a 2x, plis positifs ${value.positiveFolds}/5.`);
}
md.push(
  "",
  "## Protocole",
  "",
  `- ${report.rules.validation}. Les plis suivent le calendrier depuis la premiere bougie; les plis sans trade restent inclus.`,
  `- ${report.rules.entry}`,
  `- ${report.rules.stop}`,
  `- ${report.rules.exit}`,
  `- Commission: ${COMMISSION_PCT_PER_SIDE}% par cote. Slippage: ${SLIPPAGE_TICKS_PER_SIDE} tick(s) par cote.`,
  "- Hypothese commission nulle, conforme a la description publique du compte Deriv MT5 Standard; la session MT5 connectee etait Deriv-Demo et son type de compte n'a pas ete confirme.",
  "- Une position maximum; signal a la cloture puis execution a l'ouverture suivante; en cas de conflit stop/objectif dans une bougie, stop d'abord.",
  "- Le JSON associe contient les variantes actives pour ce lancement, les 3 niveaux de cout et les resultats par pli.",
  "",
  "## Limites",
  "",
  EXECUTION_MODEL === "m1_bid_ask"
    ? "- OHLC M1 ne revele pas l'ordre exact a l'interieur de la minute; si stop et objectif sont touches dans la meme minute, le stop est pris en premier. Ce moteur local ne correspond pas exactement au simulateur TradingView ou au courtier."
    : "- OHLC ne revele pas l'ordre intrabar. Ce moteur local ne correspond pas exactement au simulateur TradingView ou au courtier.",
  EXECUTION_MODEL === "m1_bid_ask"
    ? "- Les OHLC ASK M1 sont reconstruits en ajoutant le spread MT5 de la minute aux OHLC BID, pas lus d'un historique ASK/tick natif. Le stress 1.5x/2x revalorise les memes transactions sans rejouer les declenchements ni le filtre d'entree."
    : "- Le spread MT5 de la bougie d'entree estime le cout aller-retour; le stress de cout revalorise les trades de base sans recalculer le filtre d'entree.",
  "- Les cotations viennent du serveur Deriv-Demo, pas du serveur live; le type de compte du terminal n'a pas ete confirme. Le champ MT5 spread est conserve par barre et l'ASK OHLC est reconstruit a partir du BID et de ce spread.",
  "- La simulation en R ne modelise pas lot minimum, levier, marge, swaps, rejets ni commissions reelles du compte.",
  "",
  "## Insuffisances et priorites de recherche",
  "",
  "1. La logique d'entree est identique, mais une position gardee plus longtemps peut rendre indisponibles des signaux suivants; le nombre d'entrees executees peut donc varier entre gestions.",
  EXECUTION_MODEL === "m1_bid_ask"
    ? "2. Les OHLC ASK sont reconstruits depuis les BID et le spread MT5 de chaque minute; cela reste une approximation des cotations, et le stress de spread ne rejoue pas les fills ni les signaux."
    : "2. Le spread de la bougie d'entree estime le cout aller-retour; les colonnes de stress reprennent les trades et ne simulent pas un carnet bid/ask intrabar complet.",
  "3. Le BE majore des couts ne devient actif qu'a la bougie suivante; OHLC ne revele pas l'ordre du declenchement et d'un retournement dans la meme bougie.",
  "4. Les stops x1.25/x1.50 supposent un lot reduit pour garder le meme risque en argent. Avec le lot initial, le risque cash augmenterait dans la meme proportion que le stop.",
  "5. Cette comparaison porte sur la codification Price Action testee ici, pas sur toutes les lectures discretionnaires ni sur la rentabilite future.",
  "",
);
const markdownPath = join(DATA_DIR, `KRONOS_EXIT_MANAGEMENT_DERIV_YTD_2026${OUTPUT_TAG ? `_${OUTPUT_TAG.toUpperCase()}` : ""}_REPORT.md`);
writeFileSync(markdownPath, md.join("\n"), "utf8");
console.log("Readable report: " + markdownPath);
console.log("Résultats écrits dans " + outputPath);
