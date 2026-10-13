// 2026 year-to-date walk-forward study using Deriv MT5 Demo candles and bar spreads.
// Signals use Deriv BID OHLC; MT5's historical spread field supplies per-bar costs.
// Signals fill at the following bar open; this is not TradingView's broker emulator.
// It simulates 50% exits at +1R and +1.6R.
//
// Run: node scripts/backtest-kronos-price-action-ytd-2026.mjs
//
// Historical entry rules are fixed before execution. The data is split into a
// 30-day warm-up followed by five chronological 50-day test folds. No parameter
// search or optimization is performed on these folds.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KRONOS_PRICE_ACTION_VERSION, PRICE_ACTION_RULES, stepPriceActionScalp } from "../price-action-scalp-engine.mjs";

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
const PA_MAX_STOP_RANGE_MULTIPLIER = PRICE_ACTION_RULES.maxStopRangeR;
const PA_MAX_COST_R = PRICE_ACTION_RULES.maxCostR;
const TP1_R = PRICE_ACTION_RULES.tp1R;
const TP2_R = PRICE_ACTION_RULES.tp2R;
const TP1_SIZE_PCT = PRICE_ACTION_RULES.closeAtTp1Pct;
const MAX_HOLD_MINUTES = 60;
const RISK_PCT = 0.5;
const INITIAL_EQUITY = 1000;
const SLIPPAGE_TICKS_PER_SIDE = Math.max(0, Number(process.env.KRONOS_SLIPPAGE_TICKS_PER_SIDE ?? 1));
const COMMISSION_PCT_PER_SIDE = Math.max(0, Number(process.env.KRONOS_COMMISSION_PCT_PER_SIDE ?? 0));
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
const PA_VARIANTS = [
  { key: "retest_15", label: "Break + confirmed retest / 15 min exit", setup: "retest", maxHoldMinutes: 15 },
  { key: "retest_30", label: "Break + confirmed retest / 30 min exit", setup: "retest", maxHoldMinutes: 30 },
  { key: "retest_60", label: "Break + confirmed retest / 60 min exit", setup: "retest", maxHoldMinutes: 60 },
  { key: "rejection_15", label: "Confirmed rejection / 15 min exit", setup: "rejection", maxHoldMinutes: 15 },
  { key: "rejection_30", label: "Confirmed rejection / 30 min exit", setup: "rejection", maxHoldMinutes: 30 },
  { key: "rejection_60", label: "Confirmed rejection / 60 min exit", setup: "rejection", maxHoldMinutes: 60 },
];

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
  const confirmedM15BullStructure = new Uint8Array(n);
  const confirmedM15BearStructure = new Uint8Array(n);
  confirmedM15Ema20.fill(Number.NaN);
  confirmedM15Ema50.fill(Number.NaN);
  let groupCursor = 0;
  for (let i = 0; i < n; i += 1) {
    const currentBucket = Math.floor(bars[i].time / m15Ms);
    while (groupCursor < m15Groups.length && m15Groups[groupCursor].bucket < currentBucket) groupCursor += 1;
    const completedGroup = groupCursor - 1;
    if (completedGroup >= 0) {
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
  const { opens, highs, lows, closes, avgRange, hi30, lo30 } = data;
  if (i >= closes.length || !Number.isFinite(avgRange[i])) return { finalDirection: 0, signal: null };
  return stepPriceActionScalp({
    bar: { open: opens[i], high: highs[i], low: lows[i], close: closes[i] },
    previousBar: { open: opens[i - 1], high: highs[i - 1], low: lows[i - 1], close: closes[i - 1] },
    index: i,
    averageRange: avgRange[i],
    support: lo30[i - 1],
    resistance: hi30[i - 1],
    setup: runConfig.setup,
    setupState: runConfig.setupState,
    tickSize: runConfig.tickSize,
    spreadPct: runConfig.spreadPct,
    commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
  });
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
  const setupState = { direction: 0, level: Number.NaN, index: -1 };

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
      const risk = pendingEntry.direction === 1
        ? entry - pendingEntry.stop
        : pendingEntry.stop - entry;
      const entrySpreadPct = config.spreadPctByTime?.get(bar.time) ?? config.spreadPct;
      const roundTripCost = entry * entrySpreadPct / 100
        + entry * 2 * COMMISSION_PCT_PER_SIDE / 100
        + config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2;
      const stopStillValid = risk > 0 && risk <= pendingEntry.averageRange * PA_MAX_STOP_RANGE_MULTIPLIER;
      const costsStillValid = risk > 0 && roundTripCost / risk <= PA_MAX_COST_R;
      if (stopStillValid && costsStillValid) {
        position = {
          direction: pendingEntry.direction,
          entry,
          spreadPct: entrySpreadPct,
          stop: pendingEntry.stop,
          risk,
          tp1: entry + pendingEntry.direction * risk * TP1_R,
          tp2: entry + pendingEntry.direction * risk * TP2_R,
          entryIndex: i,
          tp1Taken: false,
        };
        openedPositionThisBar = true;
      }
      pendingEntry = null;
    }
    if (position && i >= position.entryIndex) {
      const long = position.direction === 1;
      const effectiveStop = position.tp1Taken && variant.breakevenAfterTp1 ? position.entry : position.stop;
      const stopHit = long ? bar.low <= effectiveStop : bar.high >= effectiveStop;
      const tp1Hit = long ? bar.high >= position.tp1 : bar.low <= position.tp1;
      const tp2Hit = long ? bar.high >= position.tp2 : bar.low <= position.tp2;
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
        finishTrade(i, grossR, position.tp1Taken && variant.breakevenAfterTp1 ? "BE_AFTER_TP1" : "SL");
      } else if (tp2Hit) {
        finishTrade(i, TP1_R * 0.5 + TP2_R * 0.5, "TP2");
      } else if (tp1Hit && !position.tp1Taken) {
        position.tp1Taken = true;
      }
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
    if (!position && !hadPositionAtBarStart && !openedPositionThisBar && evaluated.signal) {
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

function summarize(trades, spreadMultiple) {
  if (!trades.length) {
    return { trades: 0, winRatePct: 0, avgR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, maxDrawdownPct: 0, maxLossStreak: 0 };
  }
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
  const meta = JSON.parse(readFileSync(join(DATA_DIR, "deriv-mt5-ytd-2026-metadata.json"), "utf8"));
  const instrument = meta.pairs[pair];
  if (!instrument) return { pair, error: "Instrument metadata missing." };
  const runConfig = { ...config, tickSize: instrument.point, spreadPct: spread.p75Pct, spreadPctByTime };
  const result = walkForward(pair, bars, runConfig, PA_VARIANTS[0], intervalMinutes);
  const variantResults = {};
  for (const variant of PA_VARIANTS) {
    const variantResult = variant.key === PA_VARIANTS[0].key ? result : walkForward(pair, bars, runConfig, variant, intervalMinutes);
    variantResults[variant.key] = {
      label: variant.label,
      folds: variantResult.folds.map((trades, index) => ({
        fold: index + 1,
        byCost: SPREAD_CASES.map((cost) => ({ spread: cost.label, ...summarize(trades, cost.multiple) })),
      })),
      overallByCost: SPREAD_CASES.map((cost) => ({ spread: cost.label, ...summarize(variantResult.folds.flat(), cost.multiple) })),
    };
  }
  return {
    pair,
    timeframe: "M" + intervalMinutes,
    data: {
      bidFile: config.bidFile,
      askFile: config.askFile,
      bars: result.bars,
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

const report = {
  experiment: "KRONOS Price Action scalp v2 / robustness research",
  rules: {
    chartTimeframes: ["M1", "M5", "M15"],
    entry: "Two separate setups: close breakout then retest/reclaim within 8 bars, or confirmed rejection at a support/resistance from the prior 30 bars. Signal at close; fill at next bar open.",
    stop: "Behind the level and confirmation candle extreme with max(0.10 x 14-bar average range, 2 ticks); reject risk above 3 x average range.",
    exit: "50% at +1R, 50% at +1.6R; compare 15, 30 and 60 minute time stops.",
    riskForCompounding: RISK_PCT + "% du solde courant par trade (illustration en R)",
    costs: {
      source: "Deriv MT5 Demo, spread historique par bougie fourni dans les rates MT5; spreads p50/p75/p90 calcules par paire et timeframe",
      baseline: "spread MT5 variable a la barre d'entree; couts du meme trade stresses a 1.5x et 2x",
      commissionAssumption: "0% per side, matching the public Deriv MT5 Standard account description; the attached terminal was Deriv-Demo and did not expose the live account type",
      sensitivity: SPREAD_CASES.map((value) => value.label),
      slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
      commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    },
    method: "Price Action only. One open position. Entry is skipped if estimated round-trip spread, commission and slippage exceed 0.15R.",
    variants: PA_VARIANTS.map(({ key, label }) => ({ key, label })),
    sessionDefinition: "No session-time filter was tested in these variants.",
    m15Structure: "No M15 direction filter; setup uses only closed candles from the tested chart timeframe.",
    validation: WARMUP_DAYS + " jours de chauffe puis " + FOLD_COUNT + " plis chronologiques de " + FOLD_DAYS + " jours; aucun réglage choisi sur les plis",
    candleAmbiguity: "si stop et objectif sont touchés dans la même bougie M1, le stop est pris en premier",
    limits: [
      "M1/M5 OHLC does not show exact intrabar price order",
      "le spread historique de la bougie d'entree sert d'estimation du cout de round-trip; le stress 1.5x/2x revalorise les memes trades sans recalculer le filtre",
      "le test R ne connaît pas le lot minimum, le levier, les exigences de marge, le swap ni les rejets du courtier",
      "le moteur local reproduit les règles Pine, mais n'est pas le moteur Strategy Tester de TradingView",
    ],
  },
  pairs: Object.fromEntries(Object.entries(PAIRS).map(([pair, config]) => [pair, {
    M1: runPair(pair, config, 1),
    M5: runPair(pair, config, 5),
    M15: runPair(pair, config, 15),
  }])),
};

report.experiment = "KRONOS Price Action scalp v2 / Deriv MT5 Demo / break-retest vs level rejection";
report.rules.engineVersion = KRONOS_PRICE_ACTION_VERSION;
report.rules.siteIntegration = "The no-screenshot Price Action scalp diagnostic uses the same deterministic setup detector; it displays research candidates only and does not issue executable orders.";
report.rules.executionBoundary = "Backtest fills at the next bar open. The site diagnostic marks the signal close and theoretical levels, with no order execution; do not compare those display prices to simulated fill prices.";
report.rules.entry = "Close breakout through prior 30-bar level then retest/reclaim within 8 bars, or confirmed wick/engulf rejection at prior 30-bar support/resistance; signal at bar close, fill at next bar open, one position at a time.";
report.rules.candleAmbiguity = "Si stop et objectif sont touchés dans la même bougie M1 ou M5, le stop est pris en premier.";

const outputTag = String(process.env.KRONOS_PA_OUTPUT_TAG || "").replace(/[^a-z0-9_-]/gi, "");
const outputSuffix = outputTag ? `-${outputTag}` : "";
const outputPath = join(DATA_DIR, `kronos-price-action-deriv-ytd-2026${outputSuffix}-results.json`);
writeFileSync(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
const md = [
  "# KRONOS Price Action scalp - Deriv MT5 Demo - backtest 2026 YTD",
  "",
  `Bougies: ${(() => { const sample = Object.values(report.pairs).flatMap((pair) => Object.values(pair)).find((value) => value.data); return sample ? `${sample.data.from} a ${sample.data.to}` : "plage de donnees indisponible"; })()} UTC. Source: Deriv-Demo dans MT5. M5/M15 sont reconstruits depuis M1; les barres incompletes sont exclues.`,
  "",
  `Moteur partage avec le diagnostic du site: ${report.rules.engineVersion}. Le site affiche uniquement des candidats de recherche, sans ordre executable. Le backtest prend le signal a la cloture et simule le fill a l'ouverture suivante; ses prix d'entree ne sont donc pas les niveaux affiches par le diagnostic.`,
  "Le cout de spread varie selon le spread MT5 enregistre sur chaque bougie; le p75 affiche est descriptif. Les colonnes de stress revalorisent les memes trades a 1.5x et 2x le spread observe.",
  "",
  "| Marche | UT | Setup (sortie) | Spread p75 (%) | Trades | Gagnants (%) | R moyen | PF | R total | DD max (%) | R moyen, spread 2x |",
  "|---|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const [pair, timeframes] of Object.entries(report.pairs)) {
  for (const timeframe of ["M1", "M5", "M15"]) {
    const result = timeframes[timeframe];
    if (result.error) {
      md.push(`| ${pair} | ${timeframe} | ERROR: ${result.error} | - | - | - | - | - | - | - | - |`);
      continue;
    }
    for (const key of ["retest_30", "rejection_30"]) {
      const variant = result.variants[key];
      const base = variant.overallByCost[0];
      const stress = variant.overallByCost.find((value) => value.spread === "Deriv bar spread 2.0x");
      md.push(`| ${pair} | ${timeframe} | ${variant.label} | ${result.spread.p75Pct.toFixed(6)} | ${base.trades} | ${base.winRatePct} | ${base.avgR} | ${base.profitFactor} | ${base.totalR} | ${base.maxDrawdownPct} | ${stress?.avgR ?? "-"} |`);
    }
  }
}
const cases = [];
for (const [pair, timeframes] of Object.entries(report.pairs)) {
  for (const timeframe of ["M1", "M5", "M15"]) {
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
const consistentPositive = cases.filter((value) => value.positiveFolds >= 4);
md.push(
  "",
  "## Lecture quantitative",
  "",
  `- ${cases.length} combinaisons (8 marches x 3 UT x 6 variantes) ont ete evaluees. ${positiveBase.length} ont un R moyen positif avec les spreads Deriv observes; ${positiveStress.length} le restent avec le spread double.`,
  `- Parmi les ${atLeast100.length} combinaisons avec au moins 100 trades, ${highSamplePositive.length} seulement sont positives avec les spreads observes et aucune ne reste positive au spread double.`,
  `- Seulement ${consistentPositive.length}/${cases.length} variantes sont positives dans au moins 4 des 5 plis chronologiques.`,
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
  "- Le JSON associe contient les variantes 15/30/60 min, 3 niveaux de cout et les resultats par pli.",
  "",
  "## Limites",
  "",
  "- OHLC ne revele pas l'ordre intrabar. Ce moteur local ne correspond pas exactement au simulateur TradingView ou au courtier.",
  "- Le spread MT5 par barre est applique au moment d'entree comme estimation du cout aller-retour; l'OHLC et spread M1 ne reconstituent pas exactement chaque bid/ask intrabar. Le stress de cout revalorise les trades de base sans recalculer le filtre d'entree.",
  "- Les cotations viennent du serveur Deriv-Demo, pas du serveur live; le type de compte du terminal n'a pas ete confirme. Le champ MT5 spread est conserve par barre et l'ASK OHLC est reconstruit a partir du BID et de ce spread.",
  "- La simulation en R ne modelise pas lot minimum, levier, marge, swaps, rejets ni commissions reelles du compte.",
  "",
  "## Insuffisances et priorites de recherche",
  "",
  "1. La methode actuelle n'a pas d'avantage net robuste apres couts. Verifier le type de compte et la commission, puis affiner l'execution des spreads et du slippage Deriv au niveau de chaque entree/sortie.",
  "2. Le rejet est defini largement autour d'un niveau des 30 barres precedentes. Tester une definition PA plus selective: prise de liquidite au-dela du swing, cloture de reprise, puis deplacement confirme; mesurer combien de trades sont filtres et le R obtenu.",
  "3. Aucune plage horaire ni structure M15 n'est utilisee comme contexte. Tester separement les sessions liquides et l'alignement avec la structure des swings M15; comparer contre le meme jeu de base sans ajouter plusieurs filtres a la fois.",
  "4. Les resultats M1 montrent une sensibilite importante au cout et a la faible taille d'echantillon. Eviter de choisir un reglage gagnant sur quelques trades; exiger une stabilite par plis, couts stresses, puis une periode future tenue a l'ecart.",
  "5. Cette conclusion porte sur l'encodage mecanique Price Action v2 teste ici, pas sur toute analyse Price Action discretionary ou sur une execution en direct.",
  "",
);
const markdownPath = join(DATA_DIR, `KRONOS_PRICE_ACTION_DERIV_YTD_2026${outputSuffix ? `_${outputTag.toUpperCase()}` : ""}_REPORT.md`);
writeFileSync(markdownPath, md.join("\n"), "utf8");
console.log("Readable report: " + markdownPath);
console.log("Résultats écrits dans " + outputPath);
