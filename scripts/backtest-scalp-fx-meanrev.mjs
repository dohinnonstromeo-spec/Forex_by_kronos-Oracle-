// Different hypothesis from backtest-scalp-fx.mjs/backtest-scalp-fx-refine.mjs
// (both momentum/trend-following -- exhaustively tested, no edge survived
// train/test on any pair or duration). This tests the OPPOSITE bet:
// mean-reversion -- fade an RSI extreme stretched away from its own moving
// average, betting on a snap-back rather than continuation. Adapted from
// evaluateMeanReversionSignalAt in scripts/backtest.mjs (already a validated
// pattern shape at daily granularity, just run here at M1 to see whether the
// same contrarian logic has a short-term edge once real spread cost is
// counted -- short-term price action is often noisier/more mean-reverting than
// daily swings, which is exactly why this is worth testing on its own merits,
// not because it's "the same search again".
//
// Same real M1 bars, same real observed spread cost model, same strict
// train/test-both-positive bar for calling anything a real edge, as every
// other backtest this session.
//
// Run with: node scripts/backtest-scalp-fx-meanrev.mjs [suffix] [pairs]
//   suffix: appended to the CSV filename before loading, e.g. "_365d" to read
//     data-backtest/GBPUSD_M1_365d.csv instead of the default 90-day file --
//     used to re-verify a promising zone found on 90 days against a full year.
//   pairs: comma-separated subset to run, default all four.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data-backtest");
const TRAIN_RATIO = 0.7;
const FILE_SUFFIX = process.argv[2] || "";
const PAIRS_FILTER = process.argv[3] ? process.argv[3].split(",") : null;

// Real spreads observed live against the connected broker (same as the other
// FX backtests this session).
const PAIR_SPREAD_PCT_ALL = { XAUUSD: 0.0039, EURUSD: 0.0095, GBPUSD: 0.0037, USDJPY: 0.0107 };
const PAIR_SPREAD_PCT = PAIRS_FILTER
  ? Object.fromEntries(PAIRS_FILTER.map((p) => [p, PAIR_SPREAD_PCT_ALL[p]]))
  : PAIR_SPREAD_PCT_ALL;

function loadCsv(pair) {
  const path = join(DATA_DIR, `${pair}_M1${FILE_SUFFIX}.csv`);
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

// Contrarian: oversold + stretched below the mean -> bet on a bounce (ACHAT).
// Overbought + stretched above -> bet on a pullback (VENTE). Opposite polarity
// from the momentum scripts on purpose.
function evaluateMeanReversionAt(bars, closes, i, p) {
  if (i < p.maPeriod + 20) return null;
  const last = closes[i];
  const ma = average(closes.slice(i + 1 - p.maPeriod, i + 1));
  const atr = average(bars.slice(i + 1 - 14, i + 1).map((b) => Math.max(0, b.high - b.low))) || last * 0.0004;
  const rsi = calculateRsi(closes.slice(Math.max(0, i + 1 - 100), i + 1));
  if (!Number.isFinite(last) || !Number.isFinite(ma) || !Number.isFinite(rsi) || !ma) return null;
  const stretchPct = Math.abs(((last - ma) / ma) * 100);
  const volatilityPct = (atr / last) * 100;
  if (volatilityPct < p.volatilityMinPct || volatilityPct > p.volatilityMaxPct) return null;
  let direction = null;
  if (rsi <= p.oversold && stretchPct >= p.minStretchPct) direction = "ACHAT";
  if (rsi >= p.overbought && stretchPct >= p.minStretchPct) direction = "VENTE";
  if (!direction) return null;
  const risk = atr * p.riskAtrMultiplier;
  const entry = last;
  // Target is the mean itself (scaled by tpR), not a fixed R multiple away from
  // entry in the trade direction -- the actual bet being made is "price returns
  // toward ma", so the target should reflect that, not an arbitrary distance.
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp = direction === "ACHAT" ? Math.min(entry + risk * p.tpR, ma) : Math.max(entry - risk * p.tpR, ma);
  return { direction, entry, sl, tp, risk };
}

function simulateForward(bars, signalIndex, signal, p, spreadPct) {
  const buy = signal.direction === "ACHAT";
  const tpR = Math.abs(signal.tp - signal.entry) / signal.risk;
  const costInR = (signal.entry * (spreadPct / 100)) / signal.risk;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + p.maxHoldBars, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp = buy ? bar.high >= signal.tp : bar.low <= signal.tp;
    if (hitSl) return { result: "loss", rMultiple: -1 - costInR, barsHeld: j - signalIndex };
    if (hitTp) return { result: "win", rMultiple: tpR - costInR, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + p.maxHoldBars, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - costInR, barsHeld: expiryIndex - signalIndex };
}

function backtest(bars, p, spreadPct) {
  const closes = bars.map((b) => b.close);
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  let cooldownUntil = -1;
  for (let i = p.maPeriod + 20; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const signal = evaluateMeanReversionAt(bars, closes, i, p);
    if (!signal) continue;
    const outcome = simulateForward(bars, i, signal, p, spreadPct);
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

const grid = [];
for (const maPeriod of [20, 34, 55, 89]) {
  for (const [oversold, overbought] of [[20, 80], [25, 75], [30, 70]]) {
    for (const minStretchPct of [0.03, 0.06, 0.1]) {
      for (const riskAtrMultiplier of [0.8, 1.0, 1.3]) {
        for (const tpR of [1.5, 2.5, 4]) {
          for (const maxHoldBars of [30, 60, 120]) {
            grid.push({
              name: `ma${maPeriod} rsi${oversold}/${overbought} stretch${minStretchPct}% atr${riskAtrMultiplier} tp${tpR}R hold${maxHoldBars}`,
              maPeriod, oversold, overbought, minStretchPct, volatilityMinPct: 0.006, volatilityMaxPct: 0.3,
              riskAtrMultiplier, tpR, maxHoldBars,
            });
          }
        }
      }
    }
  }
}

async function main() {
  console.log(`${grid.length} combinaisons mean-reversion a tester par paire.\n`);
  for (const pair of Object.keys(PAIR_SPREAD_PCT)) {
    const bars = loadCsv(pair);
    if (!bars) { console.log(`[${pair}] CSV introuvable, ignore.`); continue; }
    console.log(`=== ${pair} (${bars.length} bougies, spread reel ${PAIR_SPREAD_PCT[pair]}%) ===`);
    const results = [];
    for (const p of grid) {
      const trades = backtest(bars, p, PAIR_SPREAD_PCT[pair]);
      const train = summarize(trades.filter((t) => t.split === "train"));
      const test = summarize(trades.filter((t) => t.split === "test"));
      results.push({ name: p.name, train, test });
    }
    results.sort((a, b) => (b.test.avgR ?? -99) - (a.test.avgR ?? -99));
    console.log("Top 5 par avgR test:");
    for (const r of results.slice(0, 5)) {
      console.log(`  ${r.name}`);
      console.log(`    train: n=${r.train.count} winrate=${r.train.winRate}% avgR=${r.train.avgR} | test: n=${r.test.count} winrate=${r.test.winRate}% avgR=${r.test.avgR}`);
    }
    const positiveOnBoth = results.filter((r) => r.train.avgR > 0 && r.test.avgR > 0 && r.train.count >= 30 && r.test.count >= 15);
    console.log(`Positif sur TRAIN ET TEST (echantillon suffisant): ${positiveOnBoth.length} / ${results.length}`);
    for (const r of positiveOnBoth) console.log(`  ${r.name} -- train avgR=${r.train.avgR} (n=${r.train.count}) | test avgR=${r.test.avgR} (n=${r.test.count})`);
    console.log("");
  }
}

main().catch((error) => { console.error("ERROR", error); process.exitCode = 1; });
