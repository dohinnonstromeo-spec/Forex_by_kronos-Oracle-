// Risk-of-ruin check on the two mean-reversion candidates that survived
// train/test on a full year of real data (backtest-scalp-fx-meanrev.mjs).
// Average R being positive doesn't mean the strategy is safe to run on a real,
// especially small, account -- a 12-22% winrate means real losing streaks are
// normal, not an edge case, and a string of them before the big wins arrive can
// ruin a small account even though the long-run average is genuinely positive.
// This walks the TEST-set trades in their real chronological order (the
// honest out-of-sample portion, never train) and reports: longest losing
// streak, max drawdown in R, and what that drawdown looks like in real dollars
// on a small account risking 1% per trade.
//
// Run with: node scripts/backtest-scalp-fx-drawdown.mjs

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data-backtest");
const TRAIN_RATIO = 0.7;

function loadCsv(pair, suffix) {
  const path = join(DATA_DIR, `${pair}_M1${suffix}.csv`);
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

function runTrades(bars, p, spreadPct) {
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

function analyzeDrawdown(testTrades, riskPercentOfBalance, startingBalance) {
  let cumulativeR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  let currentLossStreak = 0;
  let maxLossStreak = 0;
  let currentLossStreakR = 0;
  let worstLossStreakR = 0;

  let balance = startingBalance;
  let peakBalance = startingBalance;
  let maxDrawdownPct = 0;
  let minBalance = startingBalance;

  for (const t of testTrades) {
    cumulativeR += t.rMultiple;
    peakR = Math.max(peakR, cumulativeR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - cumulativeR);

    if (t.rMultiple < 0) {
      currentLossStreak += 1;
      currentLossStreakR += t.rMultiple;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
      worstLossStreakR = Math.min(worstLossStreakR, currentLossStreakR);
    } else {
      currentLossStreak = 0;
      currentLossStreakR = 0;
    }

    // Real-dollar simulation: risk a fixed % of the CURRENT balance each trade
    // (compounding, same as computeAutoTradeVolume's real behavior), so a
    // drawdown late in a losing streak risks less in absolute $ than one early on.
    const riskAmount = balance * (riskPercentOfBalance / 100);
    balance += riskAmount * t.rMultiple;
    peakBalance = Math.max(peakBalance, balance);
    minBalance = Math.min(minBalance, balance);
    maxDrawdownPct = Math.max(maxDrawdownPct, (peakBalance - balance) / peakBalance * 100);
  }

  return {
    finalCumulativeR: Math.round(cumulativeR * 100) / 100,
    maxDrawdownR: Math.round(maxDrawdownR * 100) / 100,
    maxLossStreak,
    worstLossStreakR: Math.round(worstLossStreakR * 100) / 100,
    finalBalance: Math.round(balance * 100) / 100,
    minBalance: Math.round(minBalance * 100) / 100,
    maxDrawdownPct: Math.round(maxDrawdownPct * 10) / 10,
  };
}

const CANDIDATES = [
  {
    label: "GBPUSD -- meilleur candidat (ma20 rsi20/80 stretch0.1% atr1 tp4R hold30)",
    pair: "GBPUSD", spreadPct: 0.0037,
    params: { maPeriod: 20, oversold: 20, overbought: 80, minStretchPct: 0.1, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, riskAtrMultiplier: 1, tpR: 4, maxHoldBars: 30 },
  },
  {
    label: "XAUUSD -- meilleur candidat (ma55 rsi20/80 stretch0.03% atr1.3 tp4R hold30)",
    pair: "XAUUSD", spreadPct: 0.0039,
    params: { maPeriod: 55, oversold: 20, overbought: 80, minStretchPct: 0.03, volatilityMinPct: 0.006, volatilityMaxPct: 0.3, riskAtrMultiplier: 1.3, tpR: 4, maxHoldBars: 30 },
  },
];

async function main() {
  for (const c of CANDIDATES) {
    const bars = loadCsv(c.pair, "_365d");
    if (!bars) { console.log(`[${c.pair}] CSV 365d introuvable.`); continue; }
    const trades = runTrades(bars, c.params, c.spreadPct);
    const testTrades = trades.filter((t) => t.split === "test");
    console.log(`\n=== ${c.label} ===`);
    console.log(`${testTrades.length} trades sur le TEST (hors-echantillon, jamais vus par la selection de parametres).`);

    for (const riskPercent of [0.5, 1, 2]) {
      const startingBalance = 100; // un "petit compte" comme demande -- $100 de depart
      const a = analyzeDrawdown(testTrades, riskPercent, startingBalance);
      console.log(`\n-- Risque ${riskPercent}% par trade, depart $${startingBalance} --`);
      console.log(`  Cumul final: ${a.finalCumulativeR}R | Drawdown max: ${a.maxDrawdownR}R`);
      console.log(`  Plus longue serie de pertes: ${a.maxLossStreak} trades d'affilee (${a.worstLossStreakR}R cumules)`);
      console.log(`  Solde: $${startingBalance} -> $${a.finalBalance} | plus bas atteint: $${a.minBalance} | drawdown max reel: ${a.maxDrawdownPct}%`);
    }
  }
}

main().catch((error) => { console.error("ERROR", error); process.exitCode = 1; });
