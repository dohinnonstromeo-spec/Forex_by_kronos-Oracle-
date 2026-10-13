// Fixed, offline walk-forward test of a scalp sequence:
// confirmed M15 trend -> M5 liquidity sweep -> M5 structure break ->
// FVG/OB retest -> rejection candle. No parameter optimization is performed.
//
// Run: node scripts/backtest-kronos-scalp-zone-retest.mjs

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data-backtest");
const DAY = 86_400_000;
const WARMUP_DAYS = 60;
const FOLD_DAYS = 60;
const FOLD_COUNT = 5;
const TREND_FAST = 20;
const TREND_SLOW = 50;
const LIQUIDITY_LOOKBACK = 8;
const PIVOT_SPAN = 2;
const SETUP_TTL_BARS = 12;
const OB_LOOKBACK = 12;
const ATR_PERIOD = 14;
const STOP_BUFFER_ATR = 0.1;
const MAX_STOP_ATR = 2.5;
const TARGET_R = 1.25;
const MAX_COST_R = 0.15;
const MAX_HOLD_MINUTES = 60;
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 17;
const SLIPPAGE_TICKS_PER_SIDE = 1;
const COMMISSION_PCT_PER_SIDE = 0;
const RISK_PCT = 0.5;
const INITIAL_EQUITY = 1000;
const PAIRS = {
  GBPUSD: { file: "GBPUSD_M1_365d.csv", spreadPct: 0.0037, tickSize: 0.00001 },
  XAUUSD: { file: "XAUUSD_M1_365d.csv", spreadPct: 0.0039, tickSize: 0.001 },
};

function n(value) {
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function readM1(file) {
  const path = join(DATA, file);
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").trim().split(/\r?\n/);
  const header = rows.shift().split(",");
  const ix = Object.fromEntries(header.map((name, index) => [name, index]));
  return rows.map((row) => {
    const cells = row.split(",");
    return {
      time: Date.parse(cells[ix.timestamp]),
      open: n(cells[ix.open]),
      high: n(cells[ix.high]),
      low: n(cells[ix.low]),
      close: n(cells[ix.close]),
    };
  }).filter((bar) => Number.isFinite(bar.time)
    && bar.open != null && bar.high != null && bar.low != null && bar.close != null);
}

function aggregate(m1, minutes) {
  const interval = minutes * 60_000;
  const output = [];
  for (const [index, bar] of m1.entries()) {
    const bucket = Math.floor(bar.time / interval) * interval;
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
    } else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.endIndex = index;
    }
  }
  return output;
}

function completedIndexAt(bars, minuteIndex) {
  let low = 0;
  let high = bars.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (bars[middle].endIndex <= minuteIndex) {
      found = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
}

function emaAt(bars, end, period) {
  const start = Math.max(0, end - period * 4 + 1);
  if (end - start + 1 < period) return Number.NaN;
  const alpha = 2 / (period + 1);
  let value = bars[start].close;
  for (let i = start + 1; i <= end; i += 1) value = bars[i].close * alpha + value * (1 - alpha);
  return value;
}

function atrAt(bars, end, period) {
  if (end < period) return Number.NaN;
  let total = 0;
  for (let i = end - period + 1; i <= end; i += 1) {
    const bar = bars[i];
    const priorClose = bars[i - 1]?.close ?? bar.close;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - priorClose), Math.abs(bar.low - priorClose));
  }
  return total / period;
}

function findZone(bars, index, direction) {
  const current = bars[index];
  const firstGap = bars[index - 2];
  if (firstGap) {
    if (direction === 1 && firstGap.high < current.low) {
      return { top: current.low, bottom: firstGap.high, type: "FVG" };
    }
    if (direction === -1 && firstGap.low > current.high) {
      return { top: firstGap.low, bottom: current.high, type: "FVG" };
    }
  }
  for (let back = 1; back <= OB_LOOKBACK && index - back >= 0; back += 1) {
    const candle = bars[index - back];
    if (direction === 1 && candle.close < candle.open) {
      return { top: candle.high, bottom: candle.low, type: "OB" };
    }
    if (direction === -1 && candle.close > candle.open) {
      return { top: candle.high, bottom: candle.low, type: "OB" };
    }
  }
  return null;
}

function simulate(m1, signal, config) {
  const lastIndex = Math.min(signal.entryIndex + MAX_HOLD_MINUTES - 1, m1.length - 1);
  for (let i = signal.entryIndex; i <= lastIndex; i += 1) {
    const bar = m1[i];
    const stopHit = signal.direction === 1 ? bar.low <= signal.stop : bar.high >= signal.stop;
    const targetHit = signal.direction === 1 ? bar.high >= signal.target : bar.low <= signal.target;
    if (stopHit) {
      const stopFill = signal.direction === 1 ? Math.min(signal.stop, bar.open) : Math.max(signal.stop, bar.open);
      const grossR = signal.direction === 1
        ? (stopFill - signal.entry) / signal.risk
        : (signal.entry - stopFill) / signal.risk;
      return { exitIndex: i, grossR, reason: "SL" };
    }
    if (targetHit) return { exitIndex: i, grossR: TARGET_R, reason: "TP" };
  }
  const exitIndex = lastIndex;
  const close = m1[exitIndex].close;
  const grossR = signal.direction === 1
    ? (close - signal.entry) / signal.risk
    : (signal.entry - close) / signal.risk;
  return { exitIndex, grossR, reason: "TIME" };
}

function buildSignals(pair, m1, config) {
  const m5 = aggregate(m1, 5);
  const m15 = aggregate(m1, 15);
  const folds = Array.from({ length: FOLD_COUNT }, () => []);
  const researchStart = m1[0].time + WARMUP_DAYS * DAY;
  let lastHigh = null;
  let priorHigh = null;
  let lastHighIndex = -1;
  let priorHighIndex = -1;
  let lastLow = null;
  let priorLow = null;
  let lastLowIndex = -1;
  let priorLowIndex = -1;
  let state = 0;
  let direction = 0;
  let stateBar = -1;
  let breakLevel = Number.NaN;
  let sweepExtreme = Number.NaN;
  let zone = null;
  let zoneBar = -1;
  let nextAvailableMinute = 0;

  for (let i = 0; i < m5.length; i += 1) {
    const current = m5[i];
    const m15Index = completedIndexAt(m15, current.endIndex);
    if (i >= PIVOT_SPAN * 2) {
      const center = i - PIVOT_SPAN;
      let isHigh = true;
      let isLow = true;
      for (let j = center - PIVOT_SPAN; j <= i; j += 1) {
        if (m5[center].high < m5[j].high) isHigh = false;
        if (m5[center].low > m5[j].low) isLow = false;
      }
      if (isHigh) {
        priorHigh = lastHigh;
        priorHighIndex = lastHighIndex;
        lastHigh = m5[center].high;
        lastHighIndex = center;
      }
      if (isLow) {
        priorLow = lastLow;
        priorLowIndex = lastLowIndex;
        lastLow = m5[center].low;
        lastLowIndex = center;
      }
    }

    if (m15Index < TREND_SLOW || current.endIndex < nextAvailableMinute) continue;
    const fast = emaAt(m15, m15Index, TREND_FAST);
    const slow = emaAt(m15, m15Index, TREND_SLOW);
    const closedM15 = m15[m15Index].close;
    const trend = fast > slow && closedM15 > slow ? 1 : fast < slow && closedM15 < slow ? -1 : 0;
    const hourUTC = new Date(current.time).getUTCHours();
    const inSession = hourUTC >= SESSION_START_UTC && hourUTC < SESSION_END_UTC;
    const pivotsReady = lastHigh != null && lastLow != null
      && lastHighIndex >= 0 && lastLowIndex >= 0
      && i - lastHighIndex <= 90 && i - lastLowIndex <= 90;

    if (!trend || !inSession) {
      state = 0;
      zone = null;
      continue;
    }
    if (state && i - stateBar > SETUP_TTL_BARS) {
      state = 0;
      zone = null;
    }

    const priorRange = m5.slice(Math.max(0, i - LIQUIDITY_LOOKBACK), i);
    if (priorRange.length < LIQUIDITY_LOOKBACK || !pivotsReady) continue;
    const priorLow8 = Math.min(...priorRange.map((bar) => bar.low));
    const priorHigh8 = Math.max(...priorRange.map((bar) => bar.high));
    const bullSweep = trend === 1 && current.low < Math.min(lastLow, priorLow8) * 0.9998
      && current.close > Math.min(lastLow, priorLow8) && current.close > current.open;
    const bearSweep = trend === -1 && current.high > Math.max(lastHigh, priorHigh8) * 1.0002
      && current.close < Math.max(lastHigh, priorHigh8) && current.close < current.open;

    if (bullSweep && priorHigh != null) {
      state = 1;
      direction = 1;
      stateBar = i;
      breakLevel = lastHigh;
      sweepExtreme = current.low;
      zone = null;
    } else if (bearSweep && priorLow != null) {
      state = 1;
      direction = -1;
      stateBar = i;
      breakLevel = lastLow;
      sweepExtreme = current.high;
      zone = null;
    } else if (state === 1 && i > stateBar) {
      const brokeStructure = direction === 1 ? current.close > breakLevel : current.close < breakLevel;
      if (brokeStructure) {
        zone = findZone(m5, i, direction);
        if (zone) {
          state = 2;
          stateBar = i;
          zoneBar = i;
        } else state = 0;
      }
    } else if (state === 2 && i > zoneBar) {
      const touches = current.low <= zone.top && current.high >= zone.bottom;
      const rejected = direction === 1
        ? current.close > current.open && current.close > zone.top
        : current.close < current.open && current.close < zone.bottom;
      const invalidated = direction === 1 ? current.close < zone.bottom : current.close > zone.top;
      if (invalidated) {
        state = 0;
        zone = null;
      } else if (touches && rejected) {
        const atr = atrAt(m5, i, ATR_PERIOD);
        const entryIndex = current.endIndex + 1;
        const entryBar = m1[entryIndex];
        if (atr > 0 && entryBar) {
          const stop = direction === 1
            ? sweepExtreme - atr * STOP_BUFFER_ATR
            : sweepExtreme + atr * STOP_BUFFER_ATR;
          const risk = Math.abs(entryBar.open - stop);
          const costDollars = entryBar.open * config.spreadPct / 100
            + config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2
            + entryBar.open * COMMISSION_PCT_PER_SIDE * 2 / 100;
          const costR = risk > 0 ? costDollars / risk : Number.POSITIVE_INFINITY;
          if (risk > 0 && risk <= atr * MAX_STOP_ATR && costR <= MAX_COST_R) {
            const signal = {
              direction,
              entryIndex,
              entry: entryBar.open,
              stop,
              risk,
              target: entryBar.open + direction * risk * TARGET_R,
            };
            const trade = simulate(m1, signal, config);
            const fold = Math.floor((m1[entryIndex].time - researchStart) / (FOLD_DAYS * DAY));
            if (fold >= 0 && fold < FOLD_COUNT) {
              folds[fold].push({
                ...trade,
                entryTime: m1[entryIndex].time,
                barsHeld: trade.exitIndex - entryIndex + 1,
                risk,
                spreadDollars: entryBar.open * config.spreadPct / 100,
                commissionDollars: entryBar.open * COMMISSION_PCT_PER_SIDE * 2 / 100,
                slipDollars: config.tickSize * SLIPPAGE_TICKS_PER_SIDE * 2,
                zoneType: zone.type,
              });
              nextAvailableMinute = trade.exitIndex + 1;
            }
          }
        }
        state = 0;
        zone = null;
      }
    }
  }
  return { m1Bars: m1.length, m5Bars: m5.length, m15Bars: m15.length, researchStart, folds };
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
  let zonesFvg = 0;
  const values = trades.map((trade) => {
    const cost = trade.spreadDollars + trade.commissionDollars + trade.slipDollars;
    return trade.grossR - cost / trade.risk;
  });
  for (let i = 0; i < trades.length; i += 1) {
    const value = values[i];
    equity += value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    holds += trades[i].barsHeld;
    if (trades[i].zoneType === "FVG") zonesFvg += 1;
    if (value > 0) {
      grossWins += value;
      lossStreak = 0;
    } else {
      if (value < 0) grossLosses += Math.abs(value);
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
  }
  return {
    trades: trades.length,
    winRate: Math.round(values.filter((value) => value > 0).length / values.length * 1000) / 10,
    avgR: Math.round(equity / trades.length * 1000) / 1000,
    totalR: Math.round(equity * 100) / 100,
    profitFactor: Math.round((grossLosses > 0 ? grossWins / grossLosses : grossWins) * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdown * 100) / 100,
    maxLossStreak,
    averageHoldMinutes: Math.round(holds / trades.length * 10) / 10,
    fvgEntriesPct: Math.round(zonesFvg / trades.length * 1000) / 10,
  };
}

function runPair(pair, config) {
  const m1 = readM1(config.file);
  if (!m1.length) return { pair, error: "Fichier de données absent." };
  const run = buildSignals(pair, m1, config);
  const folds = run.folds.map((trades, index) => ({
    fold: index + 1,
    from: trades[0] ? new Date(trades[0].entryTime).toISOString().slice(0, 10) : null,
    to: trades.at(-1) ? new Date(trades.at(-1).entryTime).toISOString().slice(0, 10) : null,
    ...summarize(trades),
  }));
  const overall = summarize(run.folds.flat());
  return {
    pair,
    data: {
      file: config.file,
      bars: run.m1Bars,
      from: new Date(m1[0].time).toISOString(),
      to: new Date(m1.at(-1).time).toISOString(),
      warmupThrough: new Date(run.researchStart).toISOString(),
    },
    folds,
    overall,
    validated: folds.every((fold) => fold.trades >= 10 && fold.avgR > 0) && overall.profitFactor > 1.1,
  };
}

console.log(JSON.stringify({
  experiment: "M15 bias + M5 liquidity sweep + CHoCH + FVG/OB retest",
  assumptions: {
    trend: "last closed M15 EMA20/EMA50 with close on the same side of EMA50",
    sweep: "M5 pierces the prior eight-bar range and a confirmed swing, then closes back through it",
    choch: "M5 close crosses the last confirmed opposite pivot within 12 M5 bars",
    zone: "three-bar wick FVG preferred, otherwise latest opposite full-wick candle as OB",
    retest: "later M5 candle touches the zone and closes away from it in the trade direction",
    entry: "next M1 open after the confirmed M5 retest candle",
    stop: "past the original sweep extreme plus/minus 0.1 M5 ATR(14); reject above 2.5 ATR",
    target: TARGET_R + "R full exit; forced close after " + MAX_HOLD_MINUTES + " minutes",
    sessionUtc: SESSION_START_UTC + ":00-" + SESSION_END_UTC + ":00",
    maxCostR: MAX_COST_R,
    validation: WARMUP_DAYS + " warm-up days plus " + FOLD_COUNT + " chronological " + FOLD_DAYS + "-day folds; fixed rules, no optimization",
    sameCandleRule: "stop first",
    costs: {
      source: "static spreads already in the repository scalp backtests",
      spreadPct: Object.fromEntries(Object.entries(PAIRS).map(([name, item]) => [name, item.spreadPct])),
      slippageTicksPerSide: SLIPPAGE_TICKS_PER_SIDE,
      commissionPctPerSide: COMMISSION_PCT_PER_SIDE,
    },
    limitations: [
      "M1 OHLC does not reveal the exact intrabar path",
      "spread is constant; no historical spread changes or actual broker commission",
      "no lot minimum, margin, swap, or broker rejection model",
      "local simulator is not TradingView Strategy Tester",
    ],
  },
  pairs: Object.entries(PAIRS).map(([name, config]) => runPair(name, config)),
}, null, 2));
