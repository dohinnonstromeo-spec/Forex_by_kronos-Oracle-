// Realistic historical evaluation for the evidence engines.
//
// The signal is calculated on completed daily candles, exactly like the swing
// engine. The entry and exit are then replayed on the following M1 candles so
// TP1, SL, and the staged trailing stop are not treated as daily close events.
// This remains an offline research script: it never calls a broker or provider.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStyleSignal } from "../strategy-engines.mjs";
import {
  SWING_TRAILING_PARAMS_BY_PAIR,
  computeTrailingStopPrice,
} from "../trading-exit-rules.mjs";

const root = process.cwd();
const FORWARD_DAYS = 10;
const WARMUP_DAYS = 90;
const TRAIN_DAYS = 120;
const TEST_DAYS = 60;
const STEP_DAYS = 60;
const COST_R = Number.isFinite(Number(process.env.BACKTEST_COST_R))
  ? Math.max(0, Math.min(1, Number(process.env.BACKTEST_COST_R)))
  : 0.10;
const MINIMUM_DAILY_BARS = TRAIN_DAYS + TEST_DAYS;
const PAIRS = {
  "GBP/USD": "GBPUSD_M1_365d.csv",
  "USD/JPY": "USDJPY_M1.csv",
  "XAU/USD": "XAUUSD_M1_365d.csv",
  "EUR/USD": "EURUSD_M1.csv",
};
const STYLES = ["price_action", "ichimoku", "smc", "wyckoff", "mixte"];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function parseCsv(file) {
  return readFileSync(join(root, "data-backtest", file), "utf8")
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(","))
    .map(([timestamp, open, high, low, close, volume]) => ({
      timestamp: new Date(timestamp),
      open: finite(open),
      high: finite(high),
      low: finite(low),
      close: finite(close),
      volume: finite(volume),
    }))
    .filter((bar) => !Number.isNaN(bar.timestamp.getTime())
      && bar.open != null && bar.high != null && bar.low != null && bar.close != null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function aggregateDaily(rows) {
  const daily = [];
  for (const [index, row] of rows.entries()) {
    const day = row.timestamp.toISOString().slice(0, 10);
    const current = daily.at(-1);
    if (!current || current.day !== day) {
      daily.push({
        day,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.volume || 0,
        m1Start: index,
        m1End: index,
      });
      continue;
    }
    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume += row.volume || 0;
    current.m1End = index;
  }
  return daily;
}

function summarize(trades) {
  if (!trades.length) {
    return {
      trades: 0,
      wins: 0,
      winRate: 0,
      totalR: 0,
      avgR: 0,
      maxDrawdownR: 0,
      maxLossStreak: 0,
      profitFactor: 0,
      exitReasons: {},
    };
  }
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let lossStreak = 0;
  let maxLossStreak = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const exitReasons = {};
  for (const trade of trades) {
    equity += trade.rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    lossStreak = trade.rMultiple < 0 ? lossStreak + 1 : 0;
    maxLossStreak = Math.max(maxLossStreak, lossStreak);
    if (trade.rMultiple > 0) grossWin += trade.rMultiple;
    if (trade.rMultiple < 0) grossLoss += Math.abs(trade.rMultiple);
    exitReasons[trade.reason] = (exitReasons[trade.reason] || 0) + 1;
  }
  const wins = trades.filter((trade) => trade.rMultiple > 0).length;
  return {
    trades: trades.length,
    wins,
    winRate: round((wins / trades.length) * 100),
    totalR: round(equity),
    avgR: round(equity / trades.length),
    maxDrawdownR: round(maxDrawdown),
    maxLossStreak,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : grossWin > 0 ? null : 0,
    exitReasons,
  };
}

function finishTrade(signal, entryFill, exitPrice, reason, firstBar, lastBar) {
  const risk = Math.abs(signal.entree - signal.sl);
  const buy = signal.direction === "ACHAT";
  const grossR = buy
    ? (exitPrice - entryFill) / risk
    : (entryFill - exitPrice) / risk;
  const fillGapR = buy
    ? (entryFill - signal.entree) / risk
    : (signal.entree - entryFill) / risk;
  return {
    rMultiple: round(grossR - COST_R),
    reason,
    entryFill: round(entryFill),
    fillGapR: round(fillGapR),
    barsHeld: lastBar - firstBar + 1,
  };
}

function simulateExit(signal, pair, m1Rows, startIndex, endIndex) {
  const risk = Math.abs(signal.entree - signal.sl);
  if (!(risk > 0) || startIndex > endIndex || !m1Rows[startIndex]) return null;
  const buy = signal.direction === "ACHAT";
  const entryFill = m1Rows[startIndex].open;
  const trailingParams = SWING_TRAILING_PARAMS_BY_PAIR[pair] || null;
  const target = trailingParams ? null : Number(signal.tp1);
  let stop = Number(signal.sl);
  let bestFavorablePrice = Number(signal.entree);

  for (let index = startIndex; index <= endIndex; index += 1) {
    const bar = m1Rows[index];
    const stopHit = buy ? bar.low <= stop : bar.high >= stop;
    if (stopHit) return finishTrade(signal, entryFill, stop, "SL_OR_TRAILING", startIndex, index);

    if (target != null) {
      const targetHit = buy ? bar.high >= target : bar.low <= target;
      if (targetHit) return finishTrade(signal, entryFill, target, "TP1", startIndex, index);
      continue;
    }

    const favorablePrice = buy ? bar.high : bar.low;
    bestFavorablePrice = buy
      ? Math.max(bestFavorablePrice, favorablePrice)
      : Math.min(bestFavorablePrice, favorablePrice);
    const candidate = computeTrailingStopPrice(
      signal.entree,
      signal.direction,
      risk,
      bestFavorablePrice,
      trailingParams,
    );
    if (candidate != null) stop = buy ? Math.max(stop, candidate) : Math.min(stop, candidate);
  }

  const closePrice = m1Rows[endIndex]?.close;
  if (!Number.isFinite(closePrice)) return null;
  return finishTrade(signal, entryFill, closePrice, "TIMEOUT", startIndex, endIndex);
}

function foldStarts(dailyBarCount) {
  const starts = [];
  for (let start = 0; start + MINIMUM_DAILY_BARS <= dailyBarCount; start += STEP_DAYS) starts.push(start);
  return starts;
}

function evaluateStyle(style, pair, dailyBars, m1Rows) {
  const starts = foldStarts(dailyBars.length);
  if (!starts.length) {
    return {
      status: "insufficient_data",
      exitMode: SWING_TRAILING_PARAMS_BY_PAIR[pair] ? "production_trailing" : "production_tp1",
      folds: [],
      overall: summarize([]),
    };
  }

  const folds = [];
  const allTrades = [];
  for (const foldStart of starts) {
    const testStart = foldStart + TRAIN_DAYS;
    const testEnd = testStart + TEST_DAYS;
    const trades = [];
    let signalCount = 0;
    const firstSignal = Math.max(WARMUP_DAYS, testStart);
    const lastSignal = Math.min(testEnd - FORWARD_DAYS, dailyBars.length - FORWARD_DAYS);
    for (let index = firstSignal; index < lastSignal; index += 1) {
      const signal = buildStyleSignal(
        style,
        pair,
        { price: dailyBars[index].close },
        dailyBars.slice(0, index),
      );
      if (!signal?.direct) continue;
      signalCount += 1;
      const startIndex = dailyBars[index].m1End + 1;
      const endIndex = dailyBars[index + FORWARD_DAYS].m1End;
      const trade = simulateExit(signal, pair, m1Rows, startIndex, endIndex);
      if (trade) trades.push(trade);
    }
    allTrades.push(...trades);
    folds.push({
      testFrom: dailyBars[testStart]?.day || null,
      testTo: dailyBars[testEnd - 1]?.day || null,
      signalCount,
      ...summarize(trades),
    });
  }
  return {
    status: "ok",
    exitMode: SWING_TRAILING_PARAMS_BY_PAIR[pair] ? "production_trailing" : "production_tp1",
    folds,
    overall: summarize(allTrades),
  };
}

const report = {
  assumptions: {
    source: "local M1 data, with completed D1 signal candles",
    protocol: "rolling held-out windows: 120 D1 history, 60 D1 test, step 60 D1",
    forwardDays: FORWARD_DAYS,
    warmupDays: WARMUP_DAYS,
    transactionCostR: COST_R,
    sameCandleRule: "stop first; M1 OHLC cannot reveal tick order",
    entryRule: "next available M1 open after the completed signal day",
    pnlRule: "P/L uses the next M1 open fill; R risk remains the analytical entry-to-SL distance",
    exitRule: "production TP1 or production staged trailing stop by pair",
  },
  pairs: {},
};

for (const [pair, file] of Object.entries(PAIRS)) {
  const m1Rows = parseCsv(file);
  const dailyBars = aggregateDaily(m1Rows);
  const styles = {};
  for (const style of STYLES) styles[style] = evaluateStyle(style, pair, dailyBars, m1Rows);
  report.pairs[pair] = {
    sourceFile: file,
    m1Bars: m1Rows.length,
    dailyBars: dailyBars.length,
    minimumDailyBars: MINIMUM_DAILY_BARS,
    status: dailyBars.length >= MINIMUM_DAILY_BARS ? "ok" : "insufficient_data",
    styles,
  };
}

console.log(JSON.stringify(report, null, 2));
