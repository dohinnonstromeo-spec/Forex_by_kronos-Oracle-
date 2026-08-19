// FX/metals counterpart to backtest-scalp.mjs -- same research question (does a
// short-term momentum signal survive real transaction costs at scalping
// timescales?), same evaluation logic, but reading real M1 bars downloaded via
// scripts/download_dukascopy_data.py instead of Binance klines, since Yahoo's
// free intraday feed can't provide enough FX/metals history for a real
// walk-forward split (see backtest-scalp.mjs's header for why that mattered).
//
// Cost model: REAL spread observed live against the actual connected broker
// account this session (see PAIR_SPREAD_PCT below), not a guess -- the round-trip
// cost of entering and exiting at market is exactly the spread.
//
// Run with: node scripts/backtest-scalp-fx.mjs
// Requires data-backtest/<PAIR>_M1.csv from download_dukascopy_data.py first.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data-backtest");

// Real bid/ask fetched live from the connected MetaApi demo account this
// session -- round-trip cost = the spread, same reasoning as backtest-scalp.mjs.
const PAIR_SPREAD_PCT = {
  XAUUSD: 0.0039,
  EURUSD: 0.0095,
  GBPUSD: 0.0037,
  USDJPY: 0.0107,
};

const TRAIN_RATIO = 0.7;

function loadCsv(pair) {
  const path = join(DATA_DIR, `${pair}_M1.csv`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const header = lines[0].split(",");
  const idx = {
    close: header.indexOf("close"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    volume: header.indexOf("volume"),
  };
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const close = Number(cols[idx.close]);
    const high = Number(cols[idx.high]);
    const low = Number(cols[idx.low]);
    const volume = Number(cols[idx.volume]);
    if (Number.isFinite(close) && Number.isFinite(high) && Number.isFinite(low)) {
      bars.push({ close, high, low, volume });
    }
  }
  return bars;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : NaN;
}

function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// bars/closes are the FULL series, precomputed once by the caller -- every slice
// below is bounded to a fixed small window ending at i, never the whole prefix,
// so this stays O(window) per call instead of O(i). The original version sliced
// bars.slice(0, i+1) on every single one of ~90,000 iterations, which is O(n)
// copies each time = O(n^2) overall -- confirmed live: that version was still
// running after 30+ minutes of CPU time on one pair/variant combination before
// being killed and replaced with this.
function evaluateScalpSignalAt(bars, closes, i, params) {
  if (i < params.slowPeriod + 20) return null;
  const last = closes[i];
  const smaFast = average(closes.slice(i + 1 - params.fastPeriod, i + 1));
  const smaSlow = average(closes.slice(i + 1 - params.slowPeriod, i + 1));
  const atr = average(bars.slice(i + 1 - 14, i + 1).map((bar) => Math.max(0, bar.high - bar.low))) || last * 0.0004;
  const rsi = calculateRsi(closes.slice(Math.max(0, i + 1 - 100), i + 1));
  if (!Number.isFinite(last) || !Number.isFinite(smaFast) || !Number.isFinite(smaSlow) || !Number.isFinite(rsi) || !smaSlow) return null;
  const momentumPct = ((smaFast - smaSlow) / smaSlow) * 100;
  if (Math.abs(momentumPct) < params.momentumMinPct) return null;
  const volatilityPct = (atr / last) * 100;
  if (volatilityPct < params.volatilityMinPct) return null;
  if (volatilityPct > params.volatilityMaxPct) return null;
  const direction = momentumPct >= 0 ? "ACHAT" : "VENTE";
  const trendAligned = direction === "ACHAT" ? rsi >= params.rsiUp : rsi <= params.rsiDown;
  if (!trendAligned) return null;
  const risk = atr * params.riskAtrMultiplier;
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp = direction === "ACHAT" ? entry + risk * params.tpR : entry - risk * params.tpR;
  return { direction, entry, sl, tp, risk };
}

function simulateScalpForward(bars, signalIndex, signal, params, spreadPct) {
  const buy = signal.direction === "ACHAT";
  const tpR = params.tpR;
  const costInR = (signal.entry * (spreadPct / 100)) / signal.risk;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + params.maxHoldBars, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp = buy ? bar.high >= signal.tp : bar.low <= signal.tp;
    if (hitSl) return { result: "loss", rMultiple: -1 - costInR, barsHeld: j - signalIndex, costInR };
    if (hitTp) return { result: "win", rMultiple: tpR - costInR, barsHeld: j - signalIndex, costInR };
  }
  const expiryIndex = Math.min(signalIndex + params.maxHoldBars, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - costInR, barsHeld: expiryIndex - signalIndex, costInR };
}

function backtestSymbol(pair, bars, params, spreadPct) {
  const closes = bars.map((bar) => bar.close);
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  let cooldownUntil = -1;
  for (let i = params.slowPeriod + 20; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const signal = evaluateScalpSignalAt(bars, closes, i, params);
    if (!signal) continue;
    const outcome = simulateScalpForward(bars, i, signal, params, spreadPct);
    trades.push({ pair, split: i < trainCutoff ? "train" : "test", direction: signal.direction, ...outcome });
    cooldownUntil = i + outcome.barsHeld;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null, avgCostInR: null, totalR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return {
    count: trades.length,
    winRate: Math.round((wins / trades.length) * 1000) / 10,
    avgR: Math.round((totalR / trades.length) * 1000) / 1000,
    avgCostInR: Math.round(average(trades.map((t) => t.costInR)) * 1000) / 1000,
    totalR: Math.round(totalR * 100) / 100,
  };
}

// Wider ATR multipliers / R targets than the crypto script -- FX/metals spread
// is far tighter in % terms (0.004-0.011% here vs crypto's 0.2%), so it's worth
// checking whether that alone is enough to flip the cost/risk math, not just
// reusing the exact crypto parameter set.
const VARIANTS = [
  { name: "SMA5/20, tp 1.5R, hold 15min", fastPeriod: 5, slowPeriod: 20, momentumMinPct: 0.015, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.0, tpR: 1.5, maxHoldBars: 15 },
  { name: "SMA5/20, tp 1.0R, hold 10min", fastPeriod: 5, slowPeriod: 20, momentumMinPct: 0.015, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.0, tpR: 1.0, maxHoldBars: 10 },
  { name: "SMA3/12, tp 1.0R, hold 5min (rapide)", fastPeriod: 3, slowPeriod: 12, momentumMinPct: 0.01, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, rsiUp: 53, rsiDown: 47, riskAtrMultiplier: 0.8, tpR: 1.0, maxHoldBars: 5 },
  { name: "SMA8/34, tp 2.0R, hold 30min (lent)", fastPeriod: 8, slowPeriod: 34, momentumMinPct: 0.025, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.2, tpR: 2.0, maxHoldBars: 30 },
  { name: "SMA10/40, tp 2.5R, hold 60min (encore plus lent)", fastPeriod: 10, slowPeriod: 40, momentumMinPct: 0.03, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.3, tpR: 2.5, maxHoldBars: 60 },
];

async function main() {
  console.log(`=== Backtest scalp FX/metaux -- donnees M1 reelles (Dukascopy), cout = spread reel observe ===\n`);
  const bySymbol = {};
  for (const pair of Object.keys(PAIR_SPREAD_PCT)) {
    const bars = loadCsv(pair);
    if (!bars) {
      console.log(`[${pair}] Fichier data-backtest/${pair}_M1.csv introuvable, ignore.`);
      continue;
    }
    bySymbol[pair] = bars;
    console.log(`[${pair}] ${bars.length} bougies chargees (spread reel: ${PAIR_SPREAD_PCT[pair]}%)`);
  }
  console.log("");

  for (const variant of VARIANTS) {
    console.log(`\n--- Variante: ${variant.name} ---`);
    for (const pair of Object.keys(bySymbol)) {
      const bars = bySymbol[pair];
      const trades = backtestSymbol(pair, bars, variant, PAIR_SPREAD_PCT[pair]);
      const trainStats = summarize(trades.filter((t) => t.split === "train"));
      const testStats = summarize(trades.filter((t) => t.split === "test"));
      console.log(
        `  ${pair}: train n=${trainStats.count} winrate=${trainStats.winRate}% avgR=${trainStats.avgR} (cout moyen ${trainStats.avgCostInR}R) ` +
        `| test n=${testStats.count} winrate=${testStats.winRate}% avgR=${testStats.avgR} (cout moyen ${testStats.avgCostInR}R)`,
      );
    }
  }
}

main().catch((error) => {
  console.error("ERROR", error);
  process.exitCode = 1;
});
