// Cross-market validation of the production Kronos SMC M5/M15 engine.
// Fixed rules, Deriv Demo paired M1 bid/ask data, no parameter optimization.
// Run: node scripts/backtest-kronos-smc-multipair-2026.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeKronosSmc } from "../smc-engine.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const DAY = 86_400_000;
const SLIPPAGE_TICKS = 1;
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
const PAIRS = [
  { symbol: "EURUSD", pair: "EUR/USD", point: 0.00001 },
  { symbol: "USDJPY", pair: "USD/JPY", point: 0.001 },
  { symbol: "GBPUSD", pair: "GBP/USD", point: 0.00001 },
  { symbol: "AUDUSD", pair: "AUD/USD", point: 0.00001 },
  { symbol: "USDCAD", pair: "USD/CAD", point: 0.00001 },
  { symbol: "USDCHF", pair: "USD/CHF", point: 0.00001 },
  { symbol: "NZDUSD", pair: "NZD/USD", point: 0.00001 },
  { symbol: "XAUUSD", pair: "XAU/USD", point: 0.01 },
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

function loadPair(config) {
  const bidByTime = new Map(readCsv(`${config.symbol}_M1_bid.csv`).map((bar) => [bar.time, bar]));
  const askByTime = new Map(readCsv(`${config.symbol}_M1_ask.csv`).map((bar) => [bar.time, bar]));
  const m1 = [...bidByTime.entries()].flatMap(([time, bid]) => {
    const ask = askByTime.get(time);
    if (!ask) return [];
    return [{ time, bid, ask,
      openSpread: Math.max(0, ask.open - bid.open),
      highSpread: Math.max(0, ask.high - bid.high),
      lowSpread: Math.max(0, ask.low - bid.low),
      closeSpread: Math.max(0, ask.close - bid.close) }];
  }).sort((a, b) => a.time - b.time);
  const resample = (minutes) => {
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
      return [{ open: group[0].bid.open, high: Math.max(...group.map((item) => item.bid.high)),
        low: Math.min(...group.map((item) => item.bid.low)), close: group.at(-1).bid.close,
        datetime: new Date(time).toISOString() }];
    });
  };
  const m5 = resample(5);
  const m15 = resample(15);
  const end = m1.at(-1)?.time + MINUTE;
  const study = analyzeKronosSmc({
    pair: config.pair,
    setupBars: m5,
    contextBars: m15,
    setupTimeframe: "M5",
    contextTimeframe: "M15",
    setupSource: "deriv_ws:5min",
    contextSource: "deriv_ws:15min",
    strategy: "Scalping",
    now: end,
    includeResearchSignals: true,
  });
  const signals = new Map((study.researchSignals || []).map((signal) => [signal.signalTime, signal]));
  return { ...config, m1, m5, m15, signals, diagnostics: study.diagnostics || {} };
}

const pairData = PAIRS.map(loadPair).filter((data) => data.m1.length && data.m5.length && data.m15.length);
const commonStart = Math.max(...pairData.map((data) => data.m1[0].time));
const commonEnd = Math.max(...pairData.map((data) => data.m1.at(-1).time + MINUTE));
const researchStart = commonStart + WARMUP_DAYS * DAY;
const researchEnd = Math.min(researchStart + FOLD_COUNT * FOLD_DAYS * DAY, commonEnd);

function summarize(trades) {
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  if (!sorted.length) return { trades: 0, winsPct: 0, avgR: 0, totalR: 0, profitFactor: 0, maxDrawdownR: 0, positiveFolds: 0 };
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let gains = 0;
  let losses = 0;
  for (const trade of sorted) {
    equity += trade.r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    if (trade.r > 0) gains += trade.r;
    else losses += Math.abs(trade.r);
  }
  return {
    trades: sorted.length,
    winsPct: Math.round(sorted.filter((trade) => trade.r > 0).length / sorted.length * 1000) / 10,
    avgR: Math.round(equity / sorted.length * 1000) / 1000,
    totalR: Math.round(equity * 100) / 100,
    profitFactor: Math.round((losses ? gains / losses : gains) * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdown * 100) / 100,
  };
}

function simulate(data, spreadMultiple) {
  const trades = [];
  const slippage = data.point * SLIPPAGE_TICKS;
  let pending = null;
  let position = null;
  let previous = null;
  for (const item of data.m1) {
    const { time, bid } = item;
    const extra = (spread) => spread * (spreadMultiple - 1);
    const ask = {
      open: item.ask.open + extra(item.openSpread),
      high: item.ask.high + extra(item.highSpread),
      low: item.ask.low + extra(item.lowSpread),
      close: item.ask.close + extra(item.closeSpread),
    };
    let closedThisBar = false;
    if (position && previous && time - previous.time > 10 * MINUTE) {
      const priorAskClose = previous.ask.close + previous.closeSpread * (spreadMultiple - 1);
      const fill = position.direction === 1 ? previous.bid.close - slippage : priorAskClose + slippage;
      const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
      trades.push({ pair: data.pair, r: pnl / position.risk, entryTime: position.entryTime,
        exitTime: previous.time, reason: "data-gap", zoneType: position.zoneType });
      position = null;
      closedThisBar = true;
    }
    if (pending) {
      if (time > pending.signalEndTime) pending = null;
      else if (time === pending.signalEndTime) {
        const entry = pending.direction === 1 ? ask.open + slippage : bid.open - slippage;
        const stop = pending.direction === 1
          ? pending.stopReference - Math.max(pending.signalRange * 0.1, 2 * data.point)
          : pending.stopReference + Math.max(pending.signalRange * 0.1, 2 * data.point);
        const risk = Math.abs(entry - stop);
        const estimatedCost = item.openSpread * spreadMultiple + 2 * slippage;
        if (risk > 0 && risk <= pending.signalRange * MAX_STOP_ATR && estimatedCost / risk <= MAX_COST_R) {
          position = { direction: pending.direction, entry, stop,
            target: entry + pending.direction * risk * TARGET_R,
            risk, entryTime: time, zoneType: pending.zoneType };
        }
        pending = null;
      }
    }
    if (position) {
      const stopHit = position.direction === 1 ? bid.low <= position.stop : ask.high >= position.stop;
      const targetHit = position.direction === 1 ? bid.high >= position.target : ask.low <= position.target;
      if (stopHit) {
        const fill = position.direction === 1
          ? Math.min(position.stop, bid.open) - slippage
          : Math.max(position.stop, ask.open) + slippage;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ pair: data.pair, r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, reason: "SL", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      } else if (targetHit) {
        const fill = position.direction === 1 ? position.target - slippage : position.target + slippage;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ pair: data.pair, r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, reason: "TP", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      } else if (time - position.entryTime >= MAX_HOLD_MINUTES * MINUTE) {
        const fill = position.direction === 1 ? bid.close - slippage : ask.close + slippage;
        const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
        trades.push({ pair: data.pair, r: pnl / position.risk, entryTime: position.entryTime,
          exitTime: time, reason: "time", zoneType: position.zoneType });
        position = null;
        closedThisBar = true;
      }
    }
    if (!position && !pending && !closedThisBar && data.signals.has(time)) pending = data.signals.get(time);
    previous = item;
  }
  if (position && previous) {
    const finalAskClose = previous.ask.close + previous.closeSpread * (spreadMultiple - 1);
    const fill = position.direction === 1 ? previous.bid.close - slippage : finalAskClose + slippage;
    const pnl = position.direction === 1 ? fill - position.entry : position.entry - fill;
    trades.push({ pair: data.pair, r: pnl / position.risk, entryTime: position.entryTime,
      exitTime: previous.time, reason: "end-of-data", zoneType: position.zoneType });
  }
  const kept = trades.filter((trade) => trade.entryTime >= researchStart && trade.entryTime < researchEnd);
  const folds = Array.from({ length: FOLD_COUNT }, (_, index) => {
    const from = researchStart + index * FOLD_DAYS * DAY;
    const to = Math.min(from + FOLD_DAYS * DAY, researchEnd);
    return { fold: index + 1, from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10), ...summarize(kept.filter((trade) => trade.entryTime >= from && trade.entryTime < to)) };
  });
  const overall = summarize(kept);
  overall.positiveFolds = folds.filter((fold) => fold.avgR > 0 && fold.trades > 0).length;
  return { ...overall, folds, trades: kept, tradeCount: overall.trades,
    fvgTrades: kept.filter((trade) => trade.zoneType === "FVG").length,
    obTrades: kept.filter((trade) => trade.zoneType === "OB").length };
}

const results = [];
for (const spreadMultiple of SPREAD_MULTIPLIERS) {
  const pairRuns = pairData.map((data) => ({ pair: data.pair, ...simulate(data, spreadMultiple) }));
  const allTrades = pairRuns.flatMap((run) => run.trades);
  const aggregate = summarize(allTrades);
  const folds = Array.from({ length: FOLD_COUNT }, (_, index) => {
    const from = researchStart + index * FOLD_DAYS * DAY;
    const to = Math.min(from + FOLD_DAYS * DAY, researchEnd);
    return { fold: index + 1, from: new Date(from).toISOString().slice(0, 10),
      to: new Date(to).toISOString().slice(0, 10), ...summarize(allTrades.filter((trade) => trade.entryTime >= from && trade.entryTime < to)) };
  });
  results.push({ spreadMultiple, ...aggregate,
    positiveFolds: folds.filter((fold) => fold.avgR > 0 && fold.trades > 0).length,
    folds, fvgTrades: allTrades.filter((trade) => trade.zoneType === "FVG").length,
    obTrades: allTrades.filter((trade) => trade.zoneType === "OB").length,
    pairs: pairRuns.map(({ trades: ignored, ...summary }) => ({
      ...summary,
      trades: summary.tradeCount,
    })) });
}

const output = {
  source: "Deriv-Demo MT5 paired M1 bid/ask; same Kronos analyzeKronosSmc engine as site; M5 setup / M15 context",
  period: { dataFrom: new Date(commonStart).toISOString(), dataTo: new Date(commonEnd).toISOString(),
    researchStart: new Date(researchStart).toISOString(), researchEnd: new Date(researchEnd).toISOString() },
  data: pairData.map((data) => ({ pair: data.pair, m1Bars: data.m1.length, m5Bars: data.m5.length,
    m15Bars: data.m15.length, signalEvents: data.signals.size, diagnostics: data.diagnostics,
    from: new Date(data.m1[0].time).toISOString(), to: new Date(data.m1.at(-1).time).toISOString() })),
  protocol: {
    rules: "Production engine: confirmed M5/M15 OHLC; 20-bar sweep/reclaim; M15 EMA20/EMA50 bias; confirmed opposite pivot; displacement >=0.6 ATR; FVG or fallback OB; retest and rejection.",
    execution: `Next M1 bar open after confirmed M5 retest; structural stop beyond sweep extreme + 0.1 ATR (minimum 2 ticks); fixed ${TARGET_R}R target; ${MAX_HOLD_MINUTES}-minute time exit; one position per pair; same M1 bar resolves SL first.`,
    costs: `Observed per-minute Deriv bid/ask, ${SLIPPAGE_TICKS} tick slippage each side; spread stress 1x/1.5x/2x using each minute's quote spread; reject estimated entry cost above ${MAX_COST_R}R. No commission/swap.`,
    folds: `${WARMUP_DAYS}-day warm-up then chronological ${FOLD_DAYS}-day folds; fixed rules, no parameter optimization.`,
  },
  results,
  limitations: [
    "Historical sample from one Deriv Demo feed; the XAUUSD spread uses the observed feed and contract assumptions can differ from another account.",
    "OHLC cannot reveal intrabar path; when stop and target touch in the same minute, stop is counted first.",
    "Spread, slippage, commission, swap, order rejection, liquidity, margin, and news-event execution are incompletely modeled.",
    "Positive historical results would still require a separate untouched forward/paper sample; results are not a probability or guarantee.",
  ],
};

const jsonPath = join(DIR, "kronos-smc-multipair-2026-results.json");
const reportPath = join(DIR, "KRONOS_SMC_MULTIPAIR_2026_REPORT.md");
writeFileSync(jsonPath, JSON.stringify(output, null, 2) + "\n", "utf8");
const report = [
  "# KRONOS SMC M5/M15 — backtest multi-paires Deriv Demo 2026",
  "",
  `Période couverte: ${output.period.dataFrom} à ${output.period.dataTo}; test après chauffe: ${output.period.researchStart} à ${output.period.researchEnd}. Même moteur SMC que la console, règles fixes, sans optimisation. Les dates de fin diffèrent selon la paire; voir le tableau de couverture.`,
  "",
  "## Couverture",
  "",
  "| Paire | M1 appariées | M5 complètes | M15 complètes | Événements de retest | Début | Fin |",
  "|---|---:|---:|---:|---:|---|---|",
  ...output.data.map((item) => `| ${item.pair} | ${item.m1Bars} | ${item.m5Bars} | ${item.m15Bars} | ${item.signalEvents} | ${item.from.slice(0, 10)} | ${item.to.slice(0, 10)} |`),
  "",
  "## Résultats agrégés",
  "",
  "| Spread | Trades | Gagnants | R/trade | Total R | PF | DD max R | Plis positifs | FVG | OB |",
  "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...results.map((item) => `| ${item.spreadMultiple}x | ${item.trades} | ${item.winsPct}% | ${item.avgR} | ${item.totalR} | ${item.profitFactor} | ${item.maxDrawdownR} | ${item.positiveFolds}/5 | ${item.fvgTrades} | ${item.obTrades} |`),
  "",
  "Les scénarios de spread appliquent aussi le filtre maximal de coût de 0,15R; le nombre de trades peut donc varier d'un scénario à l'autre.",
  "",
  "## Résultats par paire — spread 1x",
  "",
  "| Paire | Trades | Gagnants | R/trade | Total R | PF | DD max R | Plis positifs |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  ...results[0].pairs.map((item) => `| ${item.pair} | ${item.trades} | ${item.winsPct}% | ${item.avgR} | ${item.totalR} | ${item.profitFactor} | ${item.maxDrawdownR} | ${item.positiveFolds}/5 |`),
  "",
  "## Plis agrégés — spread 1x",
  "",
  "| Pli | Période | Trades | R/trade | Total R | PF |",
  "|---:|---|---:|---:|---:|---:|",
  ...results[0].folds.map((fold) => `| ${fold.fold} | ${fold.from} à ${fold.to} | ${fold.trades} | ${fold.avgR} | ${fold.totalR} | ${fold.profitFactor} |`),
  "",
  "## Protocole et limites",
  "",
  ...Object.entries(output.protocol).map(([key, value]) => `- **${key}** : ${value}`),
  ...output.limitations.map((item) => `- ${item}`),
  "- Le R total agrège des transactions de plusieurs paires; il ne représente pas le rendement d'un compte avec une allocation de risque donnée.",
  "",
];
writeFileSync(reportPath, report.join("\n"), "utf8");
console.log(JSON.stringify({ jsonPath, reportPath, period: output.period, data: output.data.map(({ pair, m1Bars, m5Bars, m15Bars, signalEvents }) => ({ pair, m1Bars, m5Bars, m15Bars, signalEvents })),
  results: results.map(({ spreadMultiple, trades, winsPct, avgR, totalR, profitFactor, maxDrawdownR, positiveFolds, folds, pairs }) => ({ spreadMultiple, trades, winsPct, avgR, totalR, profitFactor, maxDrawdownR, positiveFolds,
    folds: folds.map(({ trades: n, avgR: foldR }) => ({ trades: n, avgR: foldR })), pairs: pairs.map(({ pair, trades: n, avgR: pairR, profitFactor: pf }) => ({ pair, trades: n, avgR: pairR, profitFactor: pf })) })) }, null, 2));
