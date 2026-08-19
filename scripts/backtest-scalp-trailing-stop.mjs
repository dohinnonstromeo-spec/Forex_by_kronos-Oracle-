// Tests a staged trailing-stop EXIT overlay against the entry logic already
// validated and shipped to production (SCALP_PARAMS_BY_PAIR in server.mjs) --
// this does not re-search entry parameters, only compares the current fixed
// tpR=4 target against replacing it with a trailing stop, on the exact same
// signals. Requested directly: "sécuriser un peu de gains" while a position is
// open, staged as (a) once floating profit reaches activationR, move the stop
// to entry + a real cost-covering buffer (never a bare breakeven), (b) beyond
// that, trail behind the best price reached by trailR, monotonic (never
// retreats). No fixed TP once trailing is active -- the whole point is letting
// a winner run further than the fixed target would have allowed, while still
// protecting what's already been earned.
//
// Same real M1 bars, same real observed spread cost model, same strict
// train/test-both-positive bar as every other backtest this session.
//
// Run with: node scripts/backtest-scalp-trailing-stop.mjs [suffix]

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data-backtest");
const TRAIN_RATIO = 0.7;
const FILE_SUFFIX = process.argv[2] || "";

const VALIDATED = {
  GBPUSD: { spreadPct: 0.0037, maPeriod: 20, oversold: 20, overbought: 80, minStretchPct: 0.1, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, riskAtrMultiplier: 1, tpR: 4, maxHoldBars: 30 },
  XAUUSD: { spreadPct: 0.0039, maPeriod: 55, oversold: 20, overbought: 80, minStretchPct: 0.03, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, riskAtrMultiplier: 1.3, tpR: 4, maxHoldBars: 30 },
};

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
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp = direction === "ACHAT" ? Math.min(entry + risk * p.tpR, ma) : Math.max(entry - risk * p.tpR, ma);
  return { direction, entry, sl, tp, risk };
}

// Baseline: exact production exit logic (fixed SL, fixed TP).
function simulateFixedTp(bars, signalIndex, signal, p, spreadPct) {
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

// Staged trailing stop: no fixed TP. activationR/trailR/bufferR in R units.
// Checked bar-by-bar in OHLC order that assumes the worse-for-the-trade side of
// each bar's range could have been touched first (favors the stop over the
// favorable extreme within the same bar -- the same conservative ordering
// scripts/backtest.mjs already uses for SL/TP-in-the-same-bar).
function simulateTrailingStop(bars, signalIndex, signal, p, spreadPct, activationR, trailR, bufferR) {
  const buy = signal.direction === "ACHAT";
  const costInR = (signal.entry * (spreadPct / 100)) / signal.risk;
  let stop = signal.sl;
  let bestFavR = -Infinity;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + p.maxHoldBars, bars.length - 1); j++) {
    const bar = bars[j];
    // Conservative: check the stop (worse case) against this bar's range BEFORE
    // updating the stop from this same bar's favorable extreme -- a trade can't
    // both hit its stop and then also benefit from the same bar's favorable move.
    const hitStop = buy ? bar.low <= stop : bar.high >= stop;
    if (hitStop) {
      const rAtStop = buy ? (stop - signal.entry) / signal.risk : (signal.entry - stop) / signal.risk;
      return { result: rAtStop > 0 ? "win" : "loss", rMultiple: rAtStop - costInR, barsHeld: j - signalIndex };
    }
    const favExtreme = buy ? bar.high : bar.low;
    const favR = buy ? (favExtreme - signal.entry) / signal.risk : (signal.entry - favExtreme) / signal.risk;
    if (favR > bestFavR) bestFavR = favR;
    if (bestFavR >= activationR) {
      const breakevenStop = buy ? signal.entry + bufferR * signal.risk : signal.entry - bufferR * signal.risk;
      const trailedStop = bestFavR >= activationR + trailR
        ? (buy ? signal.entry + (bestFavR - trailR) * signal.risk : signal.entry - (bestFavR - trailR) * signal.risk)
        : breakevenStop;
      stop = buy ? Math.max(stop, breakevenStop, trailedStop) : Math.min(stop, breakevenStop, trailedStop);
    }
  }
  const expiryIndex = Math.min(signalIndex + p.maxHoldBars, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - costInR, barsHeld: expiryIndex - signalIndex };
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 1000) / 10, avgR: Math.round((totalR / trades.length) * 1000) / 1000 };
}

function generateSignals(bars, p) {
  const closes = bars.map((b) => b.close);
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const signals = [];
  let cooldownUntil = -1;
  for (let i = p.maPeriod + 20; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue;
    const signal = evaluateMeanReversionAt(bars, closes, i, p);
    if (!signal) continue;
    signals.push({ index: i, signal, split: i < trainCutoff ? "train" : "test" });
    // Cooldown matches production dedup intent -- reuse the fixed-TP hold time
    // as the spacing baseline so signal density is identical across every exit
    // variant compared below (an apples-to-apples signal set, only the exit
    // logic differs).
    cooldownUntil = i + p.maxHoldBars;
  }
  return signals;
}

async function main() {
  const activationRs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  const trailRs = [0.2, 0.3, 0.4, 0.5, 0.6, 0.75];
  const bufferR = 0.15; // covers real spread cost with room to spare -- never a bare zero-gain breakeven

  for (const [pair, p] of Object.entries(VALIDATED)) {
    const bars = loadCsv(pair);
    if (!bars) { console.log(`[${pair}] CSV introuvable, ignore.`); continue; }
    const signals = generateSignals(bars, p);
    console.log(`\n=== ${pair} (${bars.length} bougies, ${signals.length} signaux, spread reel ${p.spreadPct}%) ===`);

    const baselineTrades = signals.map((s) => ({ split: s.split, ...simulateFixedTp(bars, s.index, s.signal, p, p.spreadPct) }));
    const baselineTrain = summarize(baselineTrades.filter((t) => t.split === "train"));
    const baselineTest = summarize(baselineTrades.filter((t) => t.split === "test"));
    console.log(`BASELINE (TP fixe ${p.tpR}R, production actuelle): train avgR=${baselineTrain.avgR} (n=${baselineTrain.count}, wr=${baselineTrain.winRate}%) | test avgR=${baselineTest.avgR} (n=${baselineTest.count}, wr=${baselineTest.winRate}%)`);

    const results = [];
    for (const activationR of activationRs) {
      for (const trailR of trailRs) {
        const trades = signals.map((s) => ({ split: s.split, ...simulateTrailingStop(bars, s.index, s.signal, p, p.spreadPct, activationR, trailR, bufferR) }));
        const train = summarize(trades.filter((t) => t.split === "train"));
        const test = summarize(trades.filter((t) => t.split === "test"));
        results.push({ activationR, trailR, train, test });
      }
    }
    const sorted = [...results].sort((a, b) => (b.test.avgR ?? -99) - (a.test.avgR ?? -99));
    console.log("Top 5 stop suiveur par avgR test:");
    for (const r of sorted.slice(0, 5)) {
      const beatsBaseline = r.test.avgR > baselineTest.avgR && r.train.avgR > baselineTrain.avgR;
      console.log(`  activation=${r.activationR}R trail=${r.trailR}R -- train avgR=${r.train.avgR} (wr=${r.train.winRate}%) | test avgR=${r.test.avgR} (wr=${r.test.winRate}%) ${beatsBaseline ? "<<< BAT LA BASELINE SUR LES DEUX SPLITS" : ""}`);
    }
    const beatingBaseline = results.filter((r) => r.train.avgR > baselineTrain.avgR && r.test.avgR > baselineTest.avgR);
    console.log(`Combinaisons qui battent la baseline sur train ET test: ${beatingBaseline.length} / ${results.length}`);
    console.log("Detail pour activation=0.2R (valeur demandee) sur tous les trailR:");
    for (const r of results.filter((r) => r.activationR === 0.2)) {
      console.log(`  activation=0.2R trail=${r.trailR}R -- train avgR=${r.train.avgR} (wr=${r.train.winRate}%) | test avgR=${r.test.avgR} (wr=${r.test.winRate}%)`);
    }
  }
}

main().catch((error) => { console.error("ERROR", error); process.exitCode = 1; });
