// Offline walk-forward experiment for the default KRONOS Mixte scalp settings.
// This mirrors the Pine v1 signal/stop formulas on local Dukascopy M1 OHLCV,
// then simulates 50% exits at 1R and 1.6R. It never accesses a broker or network.
//
// Run: node scripts/backtest-kronos-mixte-scalp.mjs
//
// Historical entry rules are fixed before execution. The data is split into a
// 60-day warm-up followed by five chronological 60-day test folds. No parameter
// search or optimization is performed on these folds.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = join(ROOT, "data-backtest");
const DAY_MS = 86_400_000;
const WARMUP_DAYS = 60;
const FOLD_DAYS = 60;
const FOLD_COUNT = 5;
const STOP_RANGE_MULTIPLIER = 1.15;
const MIN_STOP_PRICE_PCT = 0.12;
const MAX_STOP_PRICE_PCT = 2.5;
const TP1_R = 1.0;
const TP2_R = 1.6;
const TP1_SIZE_PCT = 50;
const MAX_HOLD_MINUTES = 60;
const RISK_PCT = 0.5;
const INITIAL_EQUITY = 1000;
const SLIPPAGE_TICKS_PER_SIDE = Math.max(0, Number(process.env.KRONOS_SLIPPAGE_TICKS_PER_SIDE ?? 1));
const COMMISSION_PCT_PER_SIDE = Math.max(0, Number(process.env.KRONOS_COMMISSION_PCT_PER_SIDE ?? 0));
const PAIRS = {
  GBPUSD: {
    file: "GBPUSD_M1_365d.csv",
    spreadPct: 0.0037,
    tickSize: 0.00001,
  },
  XAUUSD: {
    file: "XAUUSD_M1_365d.csv",
    spreadPct: 0.0039,
    tickSize: 0.001,
  },
};
const SPREAD_CASES = [
  { label: "Spread 1.0x", multiple: 1 },
  { label: "Spread 1.5x", multiple: 1.5 },
  { label: "Spread 2.0x", multiple: 2 },
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
  return {
    opens,
    highs,
    lows,
    closes,
    volumes,
    avgRange: sma(ranges, 14),
    smaClose10: sma(closes, 10),
    smaClose30: sma(closes, 30),
    smaVolume29: sma(volumes, 29),
    hi5: rollingExtreme(highs, 5, true),
    lo5: rollingExtreme(lows, 5, false),
    hi9: rollingExtreme(highs, 9, true),
    lo9: rollingExtreme(lows, 9, false),
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

function evaluateSignal(data, i, pivots, previousFinalDirection) {
  const {
    opens, highs, lows, closes, volumes, avgRange,
    smaClose10, smaClose30, smaVolume29,
    hi5, lo5, hi9, lo9, hi26, lo26, hi30, lo30, hi40, lo40, hi52, lo52, minVolume30,
  } = data;
  const close = closes[i];
  const averageRange = avgRange[i];
  if (!(averageRange > 0) || i < 77) return { finalDirection: 0, signal: null };

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
  const paTrendBull = smaClose10[i] >= smaClose30[i];
  const paBullEvidence = Number(paBullBreak) + Number(paBullEngulf) + Number(paBullReject) + Number(paTrendBull);
  const paBearEvidence = Number(paBearBreak) + Number(paBearEngulf) + Number(paBearReject) + Number(!paTrendBull);
  const paLong = i >= 34
    && (paBullBreak || paBullEngulf || paBullReject)
    && paBullEvidence >= 2 && paBullEvidence >= paBearEvidence;
  const paShort = i >= 34
    && (paBearBreak || paBearEngulf || paBearReject)
    && paBearEvidence >= 2 && paBearEvidence > paBullEvidence;
  const paDirection = paLong ? 1 : paShort ? -1 : 0;

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

function walkForward(pair, bars, config) {
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

  function finishTrade(index, grossR, reason) {
    const fold = Math.floor((bars[position.entryIndex].time - researchStart) / (FOLD_DAYS * DAY_MS));
    if (fold >= 0 && fold < FOLD_COUNT) {
      const spreadDollars = position.entry * config.spreadPct / 100;
      const commissionDollars = position.entry * 2 * COMMISSION_PCT_PER_SIDE / 100;
      const slipDollars = config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2;
      foldTrades[fold].push({
        pair,
        direction: position.direction,
        entryTime: bars[position.entryIndex].time,
        exitTime: bars[index].time,
        barsHeld: index - position.entryIndex,
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
    if (position && i > position.entryIndex) {
      const long = position.direction === 1;
      const stopHit = long ? bar.low <= position.stop : bar.high >= position.stop;
      const tp1Hit = long ? bar.high >= position.tp1 : bar.low <= position.tp1;
      const tp2Hit = long ? bar.high >= position.tp2 : bar.low <= position.tp2;
      // M1 candles do not show intrabar path. If a stop and target share a bar,
      // assume the stop filled first, consistently favoring the conservative side.
      if (stopHit) {
        const stopFill = long
          ? Math.min(position.stop, bar.open)
          : Math.max(position.stop, bar.open);
        const remainingR = long
          ? (stopFill - position.entry) / position.risk
          : (position.entry - stopFill) / position.risk;
        const grossR = position.tp1Taken
          ? (TP1_R * TP1_SIZE_PCT / 100) + (remainingR * (1 - TP1_SIZE_PCT / 100))
          : remainingR;
        finishTrade(i, grossR, "SL");
      } else if (tp2Hit) {
        finishTrade(i, TP1_R * 0.5 + TP2_R * 0.5, "TP2");
      } else if (tp1Hit && !position.tp1Taken) {
        position.tp1Taken = true;
      }
      if (position && i - position.entryIndex >= MAX_HOLD_MINUTES) {
        const closeR = long
          ? (bar.close - position.entry) / position.risk
          : (position.entry - bar.close) / position.risk;
        const grossR = position.tp1Taken ? TP1_R * 0.5 + closeR * 0.5 : closeR;
        finishTrade(i, grossR, "TIME");
      }
    }

    const evaluated = evaluateSignal(data, i, pivots, previousFinalDirection);
    if (!position && evaluated.signal) {
      position = {
        ...evaluated.signal,
        entryIndex: i,
        tp1Taken: false,
      };
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
  for (let i = 0; i < trades.length; i += 1) {
    const value = netR[i];
    const trade = trades[i];
    totalR += value;
    peakR = Math.max(peakR, totalR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - totalR);
    const costR = trade.grossR - value;
    totalCostR += costR;
    totalHold += trade.barsHeld;
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
  };
}

function runPair(pair, config) {
  const bars = loadBars(config.file);
  if (!bars.length) return { pair, error: "Fichier de données absent." };
  const result = walkForward(pair, bars, config);
  return {
    pair,
    data: {
      file: config.file,
      bars: result.bars,
      from: result.from,
      to: result.to,
      warmupThrough: result.warmupThrough,
    },
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
  };
}

const report = {
  experiment: "KRONOS Pine v1 · Mixte par défaut · scalping",
  rules: {
    chartTimeframe: "M1",
    entry: "signal Mixte confirmé à la clôture, au plus une position ouverte",
    stop: "max(range moyen 14 × 1,15 ; prix × 0,12%), référence structurelle si plus large et <= 2,5%",
    exit: "50% à +1R, 50% à +1,6R, stop commun, clôture forcée à 60 minutes",
    riskForCompounding: RISK_PCT + "% du solde courant par trade (illustration en R)",
    costs: {
      source: "spreads statiques déjà présents dans scripts/backtest-scalp-fx.mjs",
      spreadPct: Object.fromEntries(Object.entries(PAIRS).map(([pair, value]) => [pair, value.spreadPct])),
      sensitivity: SPREAD_CASES.map((value) => value.label),
      slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
      commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    },
    validation: WARMUP_DAYS + " jours de chauffe puis " + FOLD_COUNT + " plis chronologiques de " + FOLD_DAYS + " jours; aucun réglage choisi sur les plis",
    candleAmbiguity: "si stop et objectif sont touchés dans la même bougie M1, le stop est pris en premier",
    limits: [
      "OHLC M1 ne révèle pas l'ordre exact des prix intrabar",
      "les spreads sont constants et ne couvrent pas les changements historiques ni les commissions réelles sauf paramètre ajouté",
      "le test R ne connaît pas le lot minimum, le levier, les exigences de marge, le swap ni les rejets du courtier",
      "le moteur local reproduit les règles Pine, mais n'est pas le moteur Strategy Tester de TradingView",
    ],
  },
  pairs: Object.fromEntries(Object.entries(PAIRS).map(([pair, config]) => [pair, runPair(pair, config)])),
};

console.log(JSON.stringify(report, null, 2));
