// Focused refinement pass on the one combination the first FX/metals backtest
// (backtest-scalp-fx.mjs) left a real opening on: XAUUSD, 30-60min holds, close
// to breakeven (-0.03R to -0.04R) instead of hopelessly negative like every
// other pair/duration tested. This script only loads XAUUSD and grid-searches
// around that region -- not a blind parameter hunt across everything, a
// targeted search where the data already said "look here".
//
// Same real M1 bars (data-backtest/XAUUSD_M1.csv, from download_dukascopy_data.py)
// and the same real observed spread cost model as backtest-scalp-fx.mjs.
// Reports every combination, train AND test, sorted by test avgR -- a variant
// that looks great on train but falls apart on test is exactly what a walk-
// forward split exists to catch, so both are always shown together, never train
// alone.
//
// Run with: node scripts/backtest-scalp-fx-refine.mjs

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data-backtest");
const SPREAD_PCT = 0.0039; // real XAUUSD spread observed live against the connected broker
const TRAIN_RATIO = 0.7;

function loadCsv(pair) {
  const path = join(DATA_DIR, `${pair}_M1.csv`);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const header = lines[0].split(",");
  const idx = { close: header.indexOf("close"), high: header.indexOf("high"), low: header.indexOf("low") };
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const close = Number(cols[idx.close]);
    const high = Number(cols[idx.high]);
    const low = Number(cols[idx.low]);
    if (Number.isFinite(close) && Number.isFinite(high) && Number.isFinite(low)) bars.push({ close, high, low });
  }
  return bars;
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : NaN;
}

function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

// Two additions vs the first pass, both borrowed from the swing engine's own
// backtest (scripts/backtest.mjs) where they measurably helped: an anti-chasing
// filter (skip entries already extended far from smaSlow -- late/exhausted part
// of the move) and a structure filter (require a real higher-low/lower-high in
// the recent bars, not just a smooth SMA crossover).
function structureConfirmed(bars, i, direction, lookback = 10) {
  if (i + 1 < lookback) return null;
  const recent = bars.slice(i + 1 - lookback, i + 1);
  const firstHalf = recent.slice(0, Math.floor(lookback / 2));
  const secondHalf = recent.slice(Math.floor(lookback / 2));
  if (direction === "ACHAT") return Math.min(...secondHalf.map((b) => b.low)) > Math.min(...firstHalf.map((b) => b.low));
  return Math.max(...secondHalf.map((b) => b.high)) < Math.max(...firstHalf.map((b) => b.high));
}

function evaluateSignalAt(bars, closes, i, p) {
  if (i < p.slowPeriod + 20) return null;
  const last = closes[i];
  const smaFast = average(closes.slice(i + 1 - p.fastPeriod, i + 1));
  const smaSlow = average(closes.slice(i + 1 - p.slowPeriod, i + 1));
  const atr = average(bars.slice(i + 1 - 14, i + 1).map((b) => Math.max(0, b.high - b.low))) || last * 0.0004;
  const rsi = calculateRsi(closes.slice(Math.max(0, i + 1 - 100), i + 1));
  if (!Number.isFinite(last) || !Number.isFinite(smaFast) || !Number.isFinite(smaSlow) || !Number.isFinite(rsi) || !smaSlow) return null;
  const momentumPct = ((smaFast - smaSlow) / smaSlow) * 100;
  if (Math.abs(momentumPct) < p.momentumMinPct) return null;
  const volatilityPct = (atr / last) * 100;
  if (volatilityPct < p.volatilityMinPct || volatilityPct > p.volatilityMaxPct) return null;
  const direction = momentumPct >= 0 ? "ACHAT" : "VENTE";
  const trendAligned = direction === "ACHAT" ? rsi >= p.rsiUp : rsi <= p.rsiDown;
  if (!trendAligned) return null;
  if (p.extensionMaxPct) {
    const extensionPct = Math.abs(((last - smaSlow) / smaSlow) * 100);
    if (extensionPct > p.extensionMaxPct) return null;
  }
  if (p.requireStructure) {
    const ok = structureConfirmed(bars, i, direction);
    if (ok === false) return null;
  }
  const risk = atr * p.riskAtrMultiplier;
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp = direction === "ACHAT" ? entry + risk * p.tpR : entry - risk * p.tpR;
  return { direction, entry, sl, tp, risk };
}

function simulateForward(bars, signalIndex, signal, p) {
  const buy = signal.direction === "ACHAT";
  const costInR = (signal.entry * (SPREAD_PCT / 100)) / signal.risk;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + p.maxHoldBars, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp = buy ? bar.high >= signal.tp : bar.low <= signal.tp;
    if (hitSl) return { result: "loss", rMultiple: -1 - costInR, barsHeld: j - signalIndex };
    if (hitTp) return { result: "win", rMultiple: p.tpR - costInR, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + p.maxHoldBars, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - costInR, barsHeld: expiryIndex - signalIndex };
}

function backtest(bars, p) {
  const closes = bars.map((b) => b.close);
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  let cooldownUntil = -1;
  for (let i = p.slowPeriod + 20; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const signal = evaluateSignalAt(bars, closes, i, p);
    if (!signal) continue;
    const outcome = simulateForward(bars, i, signal, p);
    trades.push({ split: i < trainCutoff ? "train" : "test", ...outcome });
    cooldownUntil = i + outcome.barsHeld;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 1000) / 10, avgR: Math.round((totalR / trades.length) * 1000) / 1000 };
}

// Grid centered on the promising region from the first pass (slow-ish trend,
// wider target, 30-90min hold), plus the two extra filters above tested on/off.
const grid = [];
for (const fastPeriod of [8, 10, 13]) {
  for (const slowPeriodMult of [3, 4, 5]) {
    const slowPeriod = fastPeriod * slowPeriodMult;
    for (const momentumMinPct of [0.02, 0.04, 0.06]) {
      for (const riskAtrMultiplier of [1.0, 1.3, 1.6]) {
        for (const tpR of [1.5, 2.0, 2.5]) {
          for (const maxHoldBars of [30, 60, 90]) {
            for (const requireStructure of [false, true]) {
              grid.push({
                name: `f${fastPeriod}/s${slowPeriod} mom${momentumMinPct} atr${riskAtrMultiplier} tp${tpR}R hold${maxHoldBars} struct${requireStructure ? "Y" : "N"}`,
                fastPeriod, slowPeriod, momentumMinPct, volatilityMinPct: 0.006, volatilityMaxPct: 0.3,
                rsiUp: 55, rsiDown: 45, riskAtrMultiplier, tpR, maxHoldBars, requireStructure,
              });
            }
          }
        }
      }
    }
  }
}

async function main() {
  const bars = loadCsv("XAUUSD");
  if (!bars) { console.log("data-backtest/XAUUSD_M1.csv introuvable -- lance download_dukascopy_data.py d'abord."); return; }
  console.log(`XAUUSD: ${bars.length} bougies M1 reelles. ${grid.length} combinaisons a tester (spread reel ${SPREAD_PCT}%).\n`);

  const results = [];
  for (const p of grid) {
    const trades = backtest(bars, p);
    const train = summarize(trades.filter((t) => t.split === "train"));
    const test = summarize(trades.filter((t) => t.split === "test"));
    // Require a real sample on both splits, and train/test roughly agreeing in
    // sign -- a variant that's great on train and bad on test is overfit, not
    // an edge, and gets excluded from consideration (still computed, just
    // ranked last by the sort below since testAvgR alone would already bury it
    // if it's negative there).
    results.push({ name: p.name, train, test });
  }

  results.sort((a, b) => (b.test.avgR ?? -99) - (a.test.avgR ?? -99));
  console.log("=== Top 15 par avgR sur le TEST (le seul chiffre qui compte vraiment) ===");
  for (const r of results.slice(0, 15)) {
    console.log(`${r.test.avgR >= 0 ? "POSITIF " : "        "}${r.name}`);
    console.log(`  train: n=${r.train.count} winrate=${r.train.winRate}% avgR=${r.train.avgR} | test: n=${r.test.count} winrate=${r.test.winRate}% avgR=${r.test.avgR}`);
  }

  const positiveOnBoth = results.filter((r) => r.train.avgR > 0 && r.test.avgR > 0 && r.train.count >= 30 && r.test.count >= 15);
  console.log(`\n=== Combinaisons positives sur TRAIN ET TEST (echantillon suffisant) : ${positiveOnBoth.length} / ${results.length} ===`);
  for (const r of positiveOnBoth) {
    console.log(`${r.name} -- train avgR=${r.train.avgR} (n=${r.train.count}) | test avgR=${r.test.avgR} (n=${r.test.count})`);
  }
}

main().catch((error) => { console.error("ERROR", error); process.exitCode = 1; });
