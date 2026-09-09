// Walk-forward test for the four evidence engines.
// Input is local Dukascopy M1 data; no provider or database call is made.
// This is intentionally separate from the server so a backtest cannot open
// an order or consume the production API quota.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStyleSignal } from "../strategy-engines.mjs";

const root = process.cwd();
const COST_R = 0.10;
const FORWARD_BARS = 10;
const WARMUP_BARS = 90;
const PAIRS = {
  "GBP/USD": "GBPUSD_M1_365d.csv",
  "USD/JPY": "USDJPY_M1.csv",
  "XAU/USD": "XAUUSD_M1_365d.csv",
};
const STYLES = ["price_action", "ichimoku", "smc", "wyckoff", "mixte"];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseCsv(file) {
  const rows = readFileSync(join(root, "data-backtest", file), "utf8")
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
    .filter((bar) => !Number.isNaN(bar.timestamp.getTime()) && bar.close != null && bar.high != null && bar.low != null);
  return rows;
}

function aggregateDaily(rows) {
  const byDay = new Map();
  for (const row of rows) {
    const day = row.timestamp.toISOString().slice(0, 10);
    const current = byDay.get(day);
    if (!current) {
      byDay.set(day, { ...row, day });
      continue;
    }
    current.high = Math.max(current.high, row.high);
    current.low = Math.min(current.low, row.low);
    current.close = row.close;
    current.volume = (current.volume || 0) + (row.volume || 0);
  }
  return [...byDay.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function outcome(signal, bars, index) {
  const risk = Math.abs(signal.entree - signal.sl);
  if (!(risk > 0)) return null;
  const target = signal.direction === "ACHAT" ? signal.tp1 : signal.tp1;
  for (const bar of bars.slice(index + 1, index + 1 + FORWARD_BARS)) {
    const stopHit = signal.direction === "ACHAT" ? bar.low <= signal.sl : bar.high >= signal.sl;
    const targetHit = signal.direction === "ACHAT" ? bar.high >= target : bar.low <= target;
    // When both levels fall inside one candle, count the stop first. This is
    // the conservative choice because daily data cannot reveal tick order.
    if (stopHit) return -1 - COST_R;
    if (targetHit) return 1.6 - COST_R;
  }
  const last = bars[Math.min(index + FORWARD_BARS, bars.length - 1)].close;
  const move = signal.direction === "ACHAT" ? last - signal.entree : signal.entree - last;
  return move / risk - COST_R;
}

function summarize(results) {
  if (!results.length) return { trades: 0, wins: 0, winRate: 0, avgR: 0, maxDrawdownR: 0 };
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const result of results) {
    equity += result;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const wins = results.filter((result) => result > 0).length;
  return {
    trades: results.length,
    wins,
    winRate: Math.round((wins / results.length) * 1000) / 10,
    avgR: Math.round((equity / results.length) * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdown * 1000) / 1000,
  };
}

function testStyle(style, bars) {
  const split = Math.floor(bars.length * 0.7);
  const results = [];
  for (let index = WARMUP_BARS; index < bars.length - FORWARD_BARS; index += 1) {
    const signal = buildStyleSignal(style, "BACKTEST", { price: bars[index].close }, bars.slice(0, index));
    if (!signal?.direct) continue;
    const r = outcome(signal, bars, index);
    if (r != null && Number.isFinite(r)) results.push({ index, r });
  }
  return {
    train: summarize(results.filter((result) => result.index < split).map((result) => result.r)),
    test: summarize(results.filter((result) => result.index >= split).map((result) => result.r)),
  };
}

const report = {
  assumptions: {
    source: "local data-backtest M1 aggregated to D1",
    split: "70% train / 30% held-out test",
    forwardBars: FORWARD_BARS,
    transactionCostR: COST_R,
    sameCandleRule: "stop first",
  },
  pairs: {},
};

for (const [pair, file] of Object.entries(PAIRS)) {
  const daily = aggregateDaily(parseCsv(file));
  report.pairs[pair] = { sourceFile: file, dailyBars: daily.length, styles: {} };
  for (const style of STYLES) report.pairs[pair].styles[style] = testStyle(style, daily);
}

console.log(JSON.stringify(report, null, 2));
