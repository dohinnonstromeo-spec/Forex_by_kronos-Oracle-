// Fixed-rule XAUUSD study on Deriv-Demo M1 bid/ask history.
// Adds one price-action/SMC condition at a time; all variants share identical
// trade management, costs, session, and chronological folds.
// Run: node scripts/backtest-kronos-smc-ablation-xauusd-2026.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeKronosSmc } from "../smc-engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const DAY = 86_400_000;
const POINT = 0.01;
const SLIPPAGE = POINT;
const LOOKBACK = 20;
const PIVOT_SPAN = 2;
const ATR_PERIOD = 14;
const SETUP_TTL = 5;
const ZONE_TTL = 12;
const MAX_HOLD_MINUTES = 60;
const TARGET_R = 1.5;
const MAX_STOP_ATR = 3;
const MAX_COST_R = 0.15;
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 17;
const WARMUP_DAYS = 30;
const FOLD_DAYS = 50;
const FOLD_COUNT = 5;
const SPREAD_MULTIPLIERS = [1, 1.5, 2];

const VARIANTS = [
  { key: "sweep", label: "1. Sweep + reprise", stage: 1 },
  { key: "sweep_m15", label: "2. + biais M15 confirmé", stage: 2 },
  { key: "sweep_m15_structure", label: "3. + cassure du pivot opposé", stage: 3 },
  { key: "sweep_m15_choch_fvg", label: "4. + déplacement et FVG (entrée à la création)", stage: 4 },
  { key: "sweep_m15_fvg_retest", label: "5. + retest confirmé du milieu de FVG", stage: 5 },
  { key: "sweep_m15_fvg_ob_retest", label: "6. FVG ou OB de repli + retest", stage: 6 },
];

function readCsv(name) {
  const rows = readFileSync(join(DIR, name), "utf8").trim().split(/\r?\n/);
  const columns = Object.fromEntries(rows.shift().split(",").map((key, index) => [key, index]));
  return rows.map((row) => {
    const cells = row.split(",");
    return {
      time: Date.parse(cells[columns.timestamp]),
      open: Number(cells[columns.open]),
      high: Number(cells[columns.high]),
      low: Number(cells[columns.low]),
      close: Number(cells[columns.close]),
      volume: Number(cells[columns.volume] ?? 0),
    };
  }).filter((bar) => Number.isFinite(bar.time)
    && [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
}

const bidByTime = new Map(readCsv("XAUUSD_M1_bid.csv").map((bar) => [bar.time, bar]));
const askByTime = new Map(readCsv("XAUUSD_M1_ask.csv").map((bar) => [bar.time, bar]));
const m1 = [...bidByTime.entries()].flatMap(([time, bid]) => {
  const ask = askByTime.get(time);
  if (!ask) return [];
  return [{ time, bid, ask, spread: Math.max(0, ask.close - bid.close) }];
}).sort((a, b) => a.time - b.time);

function resample(minutes) {
  const interval = minutes * MINUTE;
  const groups = new Map();
  for (const item of m1) {
    const start = Math.floor(item.time / interval) * interval;
    const group = groups.get(start) ?? [];
    group.push(item);
    groups.set(start, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, group]) => {
    if (group.length !== minutes || group.some((item, index) => item.time !== time + index * MINUTE)) return [];
    return [{ time, endTime: time + minutes * MINUTE, open: group[0].bid.open,
      high: Math.max(...group.map((item) => item.bid.high)),
      low: Math.min(...group.map((item) => item.bid.low)), close: group.at(-1).bid.close }];
  });
}

const m5 = resample(5);
const m15 = resample(15);

function ema(bars, period) {
  const out = Array(bars.length).fill(Number.NaN);
  const alpha = 2 / (period + 1);
  for (let i = 0; i < bars.length; i += 1) {
    out[i] = i ? alpha * bars[i].close + (1 - alpha) * out[i - 1] : bars[i].close;
  }
  return out;
}

function atr(bars, period) {
  const out = Array(bars.length).fill(Number.NaN);
  let sum = 0;
  let previous = Number.NaN;
  for (let i = 0; i < bars.length; i += 1) {
    const tr = i === 0 ? bars[i].high - bars[i].low : Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close));
    if (i < period) {
      sum += tr;
      if (i === period - 1) out[i] = previous = sum / period;
    } else {
      previous = (previous * (period - 1) + tr) / period;
      out[i] = previous;
    }
  }
  return out;
}

const m5Atr = atr(m5, ATR_PERIOD);
const m15Ema20 = ema(m15, 20);
const m15Ema50 = ema(m15, 50);
const m15Bias = m15.map((bar, i) => bar.close > m15Ema20[i] && m15Ema20[i] > m15Ema50[i]
  ? 1 : bar.close < m15Ema20[i] && m15Ema20[i] < m15Ema50[i] ? -1 : 0);

function confirmedM15Index(time) {
  let low = 0;
  let high = m15.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (m15[mid].endTime <= time) { found = mid; low = mid + 1; }
    else high = mid - 1;
  }
  return found;
}

function updatePivots(index, state) {
  const center = index - PIVOT_SPAN;
  if (center < PIVOT_SPAN) return;
  let isHigh = true;
  let isLow = true;
  for (let j = center - PIVOT_SPAN; j <= index; j += 1) {
    if (m5[center].high < m5[j].high) isHigh = false;
    if (m5[center].low > m5[j].low) isLow = false;
  }
  if (isHigh) { state.high = m5[center].high; state.highIndex = center; }
  if (isLow) { state.low = m5[center].low; state.lowIndex = center; }
}

function isDisplacement(bar, range, direction) {
  if (!(range > 0)) return false;
  const body = Math.abs(bar.close - bar.open);
  const candleRange = Math.max(bar.high - bar.low, POINT);
  if (direction === 1) return bar.close > bar.open && body >= range * 0.6
    && bar.close >= bar.low + candleRange * 0.75;
  return bar.close < bar.open && body >= range * 0.6
    && bar.close <= bar.high - candleRange * 0.75;
}

function findOppositeCandle(index, direction) {
  for (let back = 1; back <= 5 && index - back >= 0; back += 1) {
    const bar = m5[index - back];
    if ((direction === 1 && bar.close < bar.open) || (direction === -1 && bar.close > bar.open)) {
      return { low: bar.low, high: bar.high, type: "OB", index: index - back };
    }
  }
  return null;
}

function buildSignals(variant) {
  if (variant.stage === 6) {
    const study = analyzeKronosSmc({
      pair: "XAU/USD",
      setupBars: m5,
      contextBars: m15,
      setupTimeframe: "M5",
      contextTimeframe: "M15",
      setupSource: "deriv_ws:5min",
      contextSource: "deriv_ws:15min",
      strategy: "Scalping",
      now: m1.at(-1).time + MINUTE,
      includeResearchSignals: true,
    });
    const signals = new Map(study.researchSignals.map((signal) => [signal.signalTime, {
      direction: signal.direction,
      stopReference: signal.stopReference,
      signalRange: signal.signalRange,
      signalEndTime: signal.signalEndTime,
      zoneType: signal.zoneType,
    }]));
    return { signals, diagnostics: study.diagnostics };
  }
  const signals = new Map();
  const pivotState = { high: Number.NaN, highIndex: -1, low: Number.NaN, lowIndex: -1 };
  let setup = null;
  let zone = null;
  let nextM15Pointer = -1;
  const diagnostics = { sweeps: 0, m15AlignedSweeps: 0, structureBreaks: 0,
    displacementFvgs: 0, fvgRetests: 0, obRetests: 0 };
  const emitSignal = (time, signal, directionBias) => {
    if (variant.stage >= 2 && directionBias !== signal.direction) return false;
    signals.set(time, signal);
    return true;
  };

  for (let i = 0; i < m5.length; i += 1) {
    const bar = m5[i];
    updatePivots(i, pivotState);
    while (nextM15Pointer + 1 < m15.length && m15[nextM15Pointer + 1].endTime <= bar.endTime) nextM15Pointer += 1;
    const directionBias = nextM15Pointer >= 0 ? m15Bias[nextM15Pointer] : 0;
    const range = m5Atr[i];
    if (!(range > 0)) continue;
    const hour = new Date(bar.time).getUTCHours();
    if (hour < SESSION_START_UTC || hour >= SESSION_END_UTC) {
      if (setup && i - setup.index > SETUP_TTL) setup = null;
      if (zone && i > zone.expires) zone = null;
      continue;
    }

    if (zone && (i > zone.expires
      || (zone.direction === 1 && bar.close < zone.low)
      || (zone.direction === -1 && bar.close > zone.high))) zone = null;

    if (zone && i > zone.index) {
      const touches = bar.low <= zone.high && bar.high >= zone.low;
      const midpoint = (zone.low + zone.high) / 2;
      const rejected = zone.direction === 1
        ? bar.close > bar.open && bar.close > midpoint
        : bar.close < bar.open && bar.close < midpoint;
      if (touches && rejected) {
        if (emitSignal(bar.endTime - MINUTE, {
          direction: zone.direction, stopReference: zone.sweepExtreme,
          signalRange: range, signalEndTime: bar.endTime, zoneType: zone.type,
        }, directionBias)) {
          diagnostics[zone.type === "FVG" ? "fvgRetests" : "obRetests"] += 1;
          zone = null;
          setup = null;
          continue;
        }
      }
    }

    if (setup && i > setup.index) {
      if (i > setup.expires || (setup.direction === 1 && bar.low < setup.extreme)
        || (setup.direction === -1 && bar.high > setup.extreme)) {
        setup = null;
        zone = null;
      } else {
        const brokePivot = setup.direction === 1 ? bar.close > setup.breakLevel : bar.close < setup.breakLevel;
        if (brokePivot && setup.chochIndex == null) {
          diagnostics.structureBreaks += 1;
          setup.chochIndex = i;
        }
        const structureHeld = setup.direction === 1 ? bar.close > setup.breakLevel : bar.close < setup.breakLevel;
        if (setup.chochIndex != null && variant.stage === 3 && structureHeld) {
          if (emitSignal(bar.endTime - MINUTE, {
            direction: setup.direction, stopReference: setup.extreme,
            signalRange: range, signalEndTime: bar.endTime, zoneType: "none",
          }, directionBias)) {
            setup = null;
            continue;
          }
        }

        if (setup.chochIndex != null && structureHeld && i >= setup.chochIndex
          && i - setup.chochIndex <= SETUP_TTL) {
          const prior2 = m5[i - 2];
          const displacement = isDisplacement(bar, range, setup.direction);
          const hasFvg = prior2 && displacement && (setup.direction === 1
            ? prior2.high < bar.low : prior2.low > bar.high);
          if (hasFvg) {
            diagnostics.displacementFvgs += 1;
            const fvg = setup.direction === 1
              ? { low: prior2.high, high: bar.low, type: "FVG" }
              : { low: bar.high, high: prior2.low, type: "FVG" };
            if (variant.stage === 4) {
              if (emitSignal(bar.endTime - MINUTE, {
                direction: setup.direction, stopReference: setup.extreme,
                signalRange: range, signalEndTime: bar.endTime, zoneType: "FVG",
              }, directionBias)) {
                setup = null;
                continue;
              }
            }
            zone = { ...fvg, direction: setup.direction, sweepExtreme: setup.extreme,
              index: i, expires: i + ZONE_TTL };
            setup = null;
            continue;
          }
          if (variant.stage >= 6 && displacement) {
            const ob = findOppositeCandle(i, setup.direction);
            if (ob) {
              zone = { ...ob, direction: setup.direction, sweepExtreme: setup.extreme,
                index: i, expires: i + ZONE_TTL };
              setup = null;
              continue;
            }
          }
        }
      }
    }

    const prior = m5.slice(Math.max(0, i - LOOKBACK), i);
    if (prior.length < LOOKBACK) continue;
    const priorLow = Math.min(...prior.map((item) => item.low));
    const priorHigh = Math.max(...prior.map((item) => item.high));
    let direction = 0;
    let extreme = Number.NaN;
    if (bar.low < priorLow && bar.close > priorLow && bar.close > bar.open) {
      direction = 1; extreme = bar.low;
    } else if (bar.high > priorHigh && bar.close < priorHigh && bar.close < bar.open) {
      direction = -1; extreme = bar.high;
    }
    if (!direction) continue;
    diagnostics.sweeps += 1;
    if (variant.stage >= 2 && directionBias !== direction) continue;
    if (variant.stage >= 2) diagnostics.m15AlignedSweeps += 1;

    if (variant.stage <= 2) {
      emitSignal(bar.endTime - MINUTE, {
        direction, stopReference: extreme, signalRange: range,
        signalEndTime: bar.endTime, zoneType: "none",
      }, directionBias);
      continue;
    }

    const breakLevel = direction === 1 ? pivotState.high : pivotState.low;
    const pivotIndex = direction === 1 ? pivotState.highIndex : pivotState.lowIndex;
    if (Number.isFinite(breakLevel) && pivotIndex >= 0 && pivotIndex < i) {
      setup = { direction, extreme, breakLevel, index: i, expires: i + SETUP_TTL, chochIndex: null };
    }
  }
  return { signals, diagnostics };
}

function summarize(trades) {
  if (!trades.length) return { trades: 0, winsPct: 0, avgR: 0, totalR: 0,
    profitFactor: 0, maxDrawdownR: 0, positiveFolds: 0, folds: [] };
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let gains = 0;
  let losses = 0;
  for (const trade of trades) {
    equity += trade.r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.r > 0) gains += trade.r;
    else losses += Math.abs(trade.r);
  }
  return {
    trades: trades.length,
    winsPct: Math.round(trades.filter((trade) => trade.r > 0).length / trades.length * 1000) / 10,
    avgR: Math.round(equity / trades.length * 1000) / 1000,
    totalR: Math.round(equity * 100) / 100,
    profitFactor: Math.round((losses ? gains / losses : gains) * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdown * 100) / 100,
    averageHoldMinutes: Math.round(trades.reduce((sum, trade) => sum + trade.holdMinutes, 0) / trades.length * 10) / 10,
  };
}

const researchStart = m1[0].time + WARMUP_DAYS * DAY;
const researchEnd = Math.min(researchStart + FOLD_COUNT * FOLD_DAYS * DAY, m1.at(-1).time + MINUTE);

function simulate(variant, spreadMultiple) {
  const { signals, diagnostics } = buildSignals(variant);
  const trades = [];
  let pending = null;
  let position = null;
  let previous = null;
  for (const item of m1) {
    const { time, bid } = item;
    const extraSpread = item.spread * (spreadMultiple - 1);
    const ask = {
      open: item.ask.open + extraSpread, high: item.ask.high + extraSpread,
      low: item.ask.low + extraSpread, close: item.ask.close + extraSpread,
    };

    let closedThisBar = false;
    if (position && previous && time - previous.time > 10 * MINUTE) {
      const priorAskClose = previous.ask.close + previous.spread * (spreadMultiple - 1);
      const fill = position.direction === 1 ? previous.bid.close - SLIPPAGE : priorAskClose + SLIPPAGE;
      const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
      trades.push({ r: pnl / position.risk, entryTime: position.entryTime,
        exitTime: previous.time, holdMinutes: (previous.time - position.entryTime) / MINUTE,
        reason: "data-gap", zoneType: position.zoneType });
      position = null;
      closedThisBar = true;
    }

    if (pending) {
      if (time > pending.signalEndTime) pending = null;
      else if (time === pending.signalEndTime) {
        const entry = pending.direction === 1 ? ask.open + SLIPPAGE : bid.open - SLIPPAGE;
        const stop = pending.direction === 1
          ? pending.stopReference - Math.max(pending.signalRange * 0.1, 2 * POINT)
          : pending.stopReference + Math.max(pending.signalRange * 0.1, 2 * POINT);
        const risk = Math.abs(entry - stop);
        const cost = item.spread * spreadMultiple + 2 * SLIPPAGE;
        if (risk > 0 && risk <= pending.signalRange * MAX_STOP_ATR && cost / risk <= MAX_COST_R) {
          position = { direction: pending.direction, entry, stop,
            target: entry + pending.direction * risk * TARGET_R,
            risk, entryTime: time, entryIndex: trades.length,
            zoneType: pending.zoneType };
        }
        pending = null;
      }
    }

    if (position) {
      const stopHit = position.direction === 1 ? bid.low <= position.stop : ask.high >= position.stop;
      const targetHit = position.direction === 1 ? bid.high >= position.target : ask.low <= position.target;
      if (stopHit) {
        const fill = position.direction === 1
          ? Math.min(position.stop, bid.open) - SLIPPAGE
          : Math.max(position.stop, ask.open) + SLIPPAGE;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, holdMinutes: (time - position.entryTime) / MINUTE,
          reason: "SL", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      } else if (targetHit) {
        const fill = position.direction === 1 ? position.target - SLIPPAGE : position.target + SLIPPAGE;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, holdMinutes: (time - position.entryTime) / MINUTE,
          reason: "TP", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      } else if (time - position.entryTime >= MAX_HOLD_MINUTES * MINUTE) {
        const fill = position.direction === 1 ? bid.close - SLIPPAGE : ask.close + SLIPPAGE;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, holdMinutes: (time - position.entryTime) / MINUTE,
          reason: "TIME", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      }
    }

    if (!position && !pending && !closedThisBar && signals.has(time)) pending = signals.get(time);
    previous = item;
  }

  if (position && previous) {
    const finalAskClose = previous.ask.close + previous.spread * (spreadMultiple - 1);
    const fill = position.direction === 1 ? previous.bid.close - SLIPPAGE : finalAskClose + SLIPPAGE;
    const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
    trades.push({ r: pnl / position.risk, entryTime: position.entryTime,
      exitTime: previous.time, holdMinutes: (previous.time - position.entryTime) / MINUTE,
      reason: "end-of-data", zoneType: position.zoneType });
  }

  const kept = trades.filter((trade) => trade.entryTime >= researchStart && trade.entryTime < researchEnd);
  const folds = Array.from({ length: FOLD_COUNT }, (_, index) => {
    const from = researchStart + index * FOLD_DAYS * DAY;
    const to = from + FOLD_DAYS * DAY;
    const foldTrades = kept.filter((trade) => trade.entryTime >= from && trade.entryTime < to);
    return { fold: index + 1, from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10), ...summarize(foldTrades) };
  });
  const overall = summarize(kept);
  overall.positiveFolds = folds.filter((fold) => fold.avgR > 0 && fold.trades > 0).length;
  return { ...overall, folds, diagnostics,
    fvgTrades: kept.filter((trade) => trade.zoneType === "FVG").length,
    obTrades: kept.filter((trade) => trade.zoneType === "OB").length,
    stressTrades: kept };
}

const results = [];
for (const variant of VARIANTS) {
  for (const spreadMultiple of SPREAD_MULTIPLIERS) {
    const run = simulate(variant, spreadMultiple);
    const { stressTrades, ...summary } = run;
    results.push({ ...variant, spreadMultiple, ...summary });
  }
}

const output = {
  source: "Deriv-Demo MT5 XAUUSD M1 bid/ask, resampled to complete M5/M15 candles",
  period: { dataFrom: new Date(m1[0].time).toISOString(), dataTo: new Date(m1.at(-1).time).toISOString(),
    researchStart: new Date(researchStart).toISOString(), researchEnd: new Date(researchEnd).toISOString() },
  data: { m1Bars: m1.length, m5CompleteBars: m5.length, m15CompleteBars: m15.length,
    medianSpread: [...m1].sort((a, b) => a.spread - b.spread)[Math.floor(m1.length * 0.5)]?.spread,
    p75Spread: [...m1].sort((a, b) => a.spread - b.spread)[Math.floor(m1.length * 0.75)]?.spread },
  protocol: {
    sessionUtc: `${SESSION_START_UTC}:00-${SESSION_END_UTC}:00`,
    baseline: "M5 takes prior 20-bar high/low, closes back inside, and closes in the reclaim direction.",
    mtf: "Only the last completed M15 candle is used; close and EMA20 must be on the same side of EMA50.",
    structure: "After the sweep, M5 close crosses the last confirmed opposite pivot (two bars on each side).",
    fvg: "After that break, a directional body >= 0.6 M5 ATR14 in the top/bottom quarter and a three-candle gap.",
    ob: "If the FVG condition does not form, use the nearest opposite-color M5 candle in the previous five bars as an OB candidate.",
    retest: "Later M5 overlaps the zone midpoint and closes directionally beyond its midpoint; zone expires after 12 M5 bars.",
    tradeManagement: `Same for every variant: structural stop past sweep extreme + 0.1 ATR (min 0.02 USD), 1.5R target, max hold ${MAX_HOLD_MINUTES} minutes, one open position, stop-first on same M1 candle.`,
    costs: "Actual paired Deriv bid/ask bars, one XAU point (0.01 USD) slippage each side, no commission; spread stress 1x/1.5x/2x. Cost filter rejects estimated spread+slippage above 0.15R.",
    validation: `${WARMUP_DAYS} warm-up days then ${FOLD_COUNT} chronological ${FOLD_DAYS}-day folds; no parameter optimization.`,
  },
  results,
  limitations: [
    "Stage 6 uses the same deterministic SMC engine as the site's analysis console. Stages 1-5 remain standalone ablation benchmarks; none reproduces the proprietary MDT indicator.",
    "M1 OHLC cannot resolve the exact intrabar price path; if SL and TP occur in one bar, SL is counted first.",
    "Spread stress scales the observed per-minute spread; real future spread, commission, swap, liquidity, rejected orders, and lot/margin rules are not simulated.",
    "The five folds are historical validation, not an untouched future sample. Small trade counts do not establish a reliable edge.",
  ],
};

const jsonPath = join(DIR, "kronos-smc-ablation-xauusd-2026-results.json");
const reportPath = join(DIR, "KRONOS_SMC_ABLATION_XAUUSD_2026_REPORT.md");
writeFileSync(jsonPath, JSON.stringify(output, null, 2) + "\n", "utf8");

const report = [
  "# KRONOS XAUUSD — ablation SMC/Price Action — Deriv Demo 2026",
  "",
  `Données: ${output.period.dataFrom} à ${output.period.dataTo}; période de test après chauffe: ${output.period.researchStart} à ${output.period.researchEnd}. ${m1.length} bougies M1 appariées, ${m5.length} M5 et ${m15.length} M15 complètes. Spread médian $${output.data.medianSpread.toFixed(3)}, p75 $${output.data.p75Spread.toFixed(3)}.`,
  "",
  "Chaque étape ajoute une règle à la précédente. La gestion des trades reste identique afin d'isoler l'effet des filtres. Les variantes sont comparées à 1x, 1,5x et 2x le spread observé.",
  "",
  "| Variante | Spread | Trades | Gagnants | R/trade | Total R | PF | DD max R | Plis positifs | FVG | OB |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const result of results) report.push(`| ${result.label} | ${result.spreadMultiple}x | ${result.trades} | ${result.winsPct}% | ${result.avgR} | ${result.totalR} | ${result.profitFactor} | ${result.maxDrawdownR} | ${result.positiveFolds}/5 | ${result.fvgTrades} | ${result.obTrades} |`);
report.push("", "## Plis chronologiques — spread 1x", "", "| Variante | Pli 1 | Pli 2 | Pli 3 | Pli 4 | Pli 5 |", "|---|---:|---:|---:|---:|---:|");
for (const variant of VARIANTS) {
  const result = results.find((item) => item.key === variant.key && item.spreadMultiple === 1);
  report.push(`| ${variant.label} | ${result.folds.map((fold) => `${fold.trades} / ${fold.avgR}R`).join(" | ")} |`);
}
report.push("", "## Définitions et limites", "", ...Object.entries(output.protocol).map(([key, value]) => `- **${key}**: ${value}`), "", ...output.limitations.map((item) => `- ${item}`), "");
writeFileSync(reportPath, report.join("\n"), "utf8");
console.log(JSON.stringify({ jsonPath, reportPath, period: output.period, data: output.data,
  results: results.map(({ key, label, spreadMultiple, trades, winsPct, avgR, totalR,
    profitFactor, maxDrawdownR, positiveFolds, folds, fvgTrades, obTrades }) => ({ key, label,
    spreadMultiple, trades, winsPct, avgR, totalR, profitFactor, maxDrawdownR,
    positiveFolds, folds: folds.map(({ trades: n, avgR: foldR }) => ({ trades: n, avgR: foldR })),
    fvgTrades, obTrades })) }, null, 2));
