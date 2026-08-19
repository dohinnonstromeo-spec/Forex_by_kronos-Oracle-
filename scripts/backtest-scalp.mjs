// Honest research question, not a shipped feature: does a short-term
// (1-minute-bar) momentum/breakout signal have any real, cost-adjusted edge at
// scalping timescales (profit target hit within minutes, or force-exit)? The
// existing engine (buildDeterministicSignals in server.mjs, validated by
// scripts/backtest.mjs) is backtested specifically on daily bars for swing-style
// setups -- there is no evidence its edge, or the same crossover logic run
// faster, survives at 1-minute granularity. This script does NOT get imported
// by server.mjs and nothing here is wired to real execution; it exists purely to
// answer "is there a real edge here" before any of it touches a real account.
//
// Data reality, stated up front rather than glossed over: real, long-history
// 1-minute bars are only freely available (no API key, no paid plan) for crypto
// via Binance's public klines endpoint -- it serves full history with no
// intraday lookback limit. Free FX/metals/index minute data does NOT exist at
// this depth: Yahoo Finance's free intraday endpoint only serves the last ~7
// days of 1-minute bars, nowhere near enough for a walk-forward train/test
// split with real statistical weight. So this backtest only covers BTC/USD and
// ETH/USD -- a real answer for XAU/USD, EUR/USD, GBP/JPY, US500 would need a
// paid minute-level data source, which is out of scope until asked for.
//
// Cost model: Binance spot taker fee, ~0.1% per side = ~0.2% round trip
// (approximate -- actual fee depends on the account's VIP tier/BNB discount,
// stated as a reasonable default, not a guarantee). Crucially, cost is
// expressed IN R (risk multiples) per trade, not a flat haircut like the daily
// backtest uses -- because a tighter stop (needed for a tiny profit target)
// makes the SAME percentage cost a much bigger bite out of R. That's the
// mechanism behind why "sans risque" doesn't hold for micro-scalping: the cost
// is fixed in price-% terms, but R shrinks with the stop, so cost-in-R grows.
//
// Run with: node scripts/backtest-scalp.mjs

const SYMBOLS = [
  { pair: "BTC/USD", binanceSymbol: "BTCUSDT" },
  { pair: "ETH/USD", binanceSymbol: "ETHUSDT" },
];

const HISTORY_DAYS = 60; // real 1-minute bars, ~86,400 per symbol
const TRAIN_RATIO = 0.7;
const TAKER_FEE_PCT = 0.1; // per side, %; ~0.2% round trip -- see header

async function fetchBinanceMinuteKlines(binanceSymbol, days) {
  const bars = [];
  const end = Date.now();
  const start = end - days * 24 * 60 * 60 * 1000;
  let cursor = start;
  while (cursor < end) {
    const url = new URL("https://api.binance.com/api/v3/klines");
    url.searchParams.set("symbol", binanceSymbol);
    url.searchParams.set("interval", "1m");
    url.searchParams.set("startTime", String(cursor));
    url.searchParams.set("limit", "1000");
    const response = await fetch(url);
    if (!response.ok) throw new Error(`binance_http_${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data) || !data.length) break;
    for (const bar of data) {
      bars.push({ time: bar[0], close: Number(bar[4]), high: Number(bar[2]), low: Number(bar[3]), volume: Number(bar[5]) });
    }
    const last = data.at(-1)[0];
    if (last <= cursor) break; // safety against an infinite loop if Binance ever returns a non-advancing page
    cursor = last + 60000;
    process.stdout.write(".");
  }
  console.log("");
  return bars.filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
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

// Fast/slow SMA crossover + RSI alignment + a volatility floor (skip dead
// stretches where the spread/fee would dominate any real move) -- the same
// decision shape as evaluateSignalAt() in backtest.mjs, just with much shorter
// windows so it reacts on a 1-minute chart instead of a daily one.
// bars/closes are the FULL series, precomputed once by the caller -- every
// slice below is bounded to a fixed small window ending at i, never the whole
// prefix (bars.slice(0, i+1) on every iteration was an O(n) copy each time,
// O(n^2) overall across ~86,000 bars -- confirmed live: still running after 30+
// minutes on the FX/metals counterpart of this script before being rewritten).
function evaluateScalpSignalAt(bars, closes, i, params) {
  if (i < params.slowPeriod + 20) return null;
  const last = closes[i];
  const smaFast = average(closes.slice(i + 1 - params.fastPeriod, i + 1));
  const smaSlow = average(closes.slice(i + 1 - params.slowPeriod, i + 1));
  const atr = average(bars.slice(i + 1 - 14, i + 1).map((bar) => Math.max(0, bar.high - bar.low))) || last * 0.0006;
  const rsi = calculateRsi(closes.slice(Math.max(0, i + 1 - 100), i + 1));
  if (!Number.isFinite(last) || !Number.isFinite(smaFast) || !Number.isFinite(smaSlow) || !Number.isFinite(rsi) || !smaSlow) return null;
  const momentumPct = ((smaFast - smaSlow) / smaSlow) * 100;
  if (Math.abs(momentumPct) < params.momentumMinPct) return null;
  const volatilityPct = (atr / last) * 100;
  if (volatilityPct < params.volatilityMinPct) return null; // too flat, cost would dominate
  if (volatilityPct > params.volatilityMaxPct) return null; // news-spike whipsaw risk
  const direction = momentumPct >= 0 ? "ACHAT" : "VENTE";
  const trendAligned = direction === "ACHAT" ? rsi >= params.rsiUp : rsi <= params.rsiDown;
  if (!trendAligned) return null;
  const risk = atr * params.riskAtrMultiplier;
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp = direction === "ACHAT" ? entry + risk * params.tpR : entry - risk * params.tpR;
  return { direction, entry, sl, tp, risk };
}

// Force-exits at maxHoldBars regardless of P&L -- models the real
// scalp_max_hold_seconds mechanism (checkScalpTimeouts in server.mjs), not just
// "wait forever for TP/SL". costInR is computed per-trade (not a flat haircut)
// because a tighter stop makes the same %-cost eat a bigger share of R -- the
// whole point of this research.
function simulateScalpForward(bars, signalIndex, signal, params) {
  const buy = signal.direction === "ACHAT";
  const tpR = params.tpR;
  const roundTripCostPct = TAKER_FEE_PCT * 2;
  const costInR = (signal.entry * (roundTripCostPct / 100)) / signal.risk;
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

function backtestSymbol(pair, bars, params) {
  const closes = bars.map((bar) => bar.close);
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  let cooldownUntil = -1;
  for (let i = params.slowPeriod + 20; i < bars.length - 1; i++) {
    if (i < cooldownUntil) continue; // don't re-signal while a "position" is still open in this simulation
    const signal = evaluateScalpSignalAt(bars, closes, i, params);
    if (!signal) continue;
    const outcome = simulateScalpForward(bars, i, signal, params);
    trades.push({ pair, split: i < trainCutoff ? "train" : "test", direction: signal.direction, ...outcome });
    cooldownUntil = i + outcome.barsHeld;
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null, avgCostInR: null, totalR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  const avgCostInR = average(trades.map((t) => t.costInR));
  return {
    count: trades.length,
    winRate: Math.round((wins / trades.length) * 1000) / 10,
    avgR: Math.round((totalR / trades.length) * 1000) / 1000,
    avgCostInR: Math.round(avgCostInR * 1000) / 1000,
    totalR: Math.round(totalR * 100) / 100,
  };
}

const VARIANTS = [
  { name: "SMA5/20, tp 1.5R, hold 15min", fastPeriod: 5, slowPeriod: 20, momentumMinPct: 0.03, volatilityMinPct: 0.02, volatilityMaxPct: 0.5, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.0, tpR: 1.5, maxHoldBars: 15 },
  { name: "SMA5/20, tp 1.0R, hold 10min", fastPeriod: 5, slowPeriod: 20, momentumMinPct: 0.03, volatilityMinPct: 0.02, volatilityMaxPct: 0.5, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.0, tpR: 1.0, maxHoldBars: 10 },
  { name: "SMA3/12, tp 1.0R, hold 5min (plus rapide)", fastPeriod: 3, slowPeriod: 12, momentumMinPct: 0.02, volatilityMinPct: 0.02, volatilityMaxPct: 0.5, rsiUp: 53, rsiDown: 47, riskAtrMultiplier: 0.8, tpR: 1.0, maxHoldBars: 5 },
  { name: "SMA8/34, tp 2.0R, hold 30min (plus lent)", fastPeriod: 8, slowPeriod: 34, momentumMinPct: 0.05, volatilityMinPct: 0.02, volatilityMaxPct: 0.5, rsiUp: 55, rsiDown: 45, riskAtrMultiplier: 1.2, tpR: 2.0, maxHoldBars: 30 },
  { name: "SMA5/20, tp 1.5R, hold 15min, momentum 0.06 (plus selectif)", fastPeriod: 5, slowPeriod: 20, momentumMinPct: 0.06, volatilityMinPct: 0.02, volatilityMaxPct: 0.5, rsiUp: 58, rsiDown: 42, riskAtrMultiplier: 1.0, tpR: 1.5, maxHoldBars: 15 },
];

async function main() {
  console.log(`=== Backtest scalp -- ${HISTORY_DAYS}j de bougies 1min réelles (Binance), coût ${TAKER_FEE_PCT * 2}% aller-retour ===\n`);
  const bySymbol = {};
  for (const s of SYMBOLS) {
    console.log(`Récupération ${s.pair} (${s.binanceSymbol})...`);
    bySymbol[s.pair] = await fetchBinanceMinuteKlines(s.binanceSymbol, HISTORY_DAYS);
    console.log(`  ${bySymbol[s.pair].length} bougies récupérées.\n`);
  }

  for (const variant of VARIANTS) {
    console.log(`\n--- Variante: ${variant.name} ---`);
    for (const s of SYMBOLS) {
      const bars = bySymbol[s.pair];
      if (!bars.length) continue;
      const trades = backtestSymbol(s.pair, bars, variant);
      const trainTrades = trades.filter((t) => t.split === "train");
      const testTrades = trades.filter((t) => t.split === "test");
      const trainStats = summarize(trainTrades);
      const testStats = summarize(testTrades);
      console.log(
        `  ${s.pair}: train n=${trainStats.count} winrate=${trainStats.winRate}% avgR=${trainStats.avgR} (coût moyen ${trainStats.avgCostInR}R) ` +
        `| test n=${testStats.count} winrate=${testStats.winRate}% avgR=${testStats.avgR} (coût moyen ${testStats.avgCostInR}R)`,
      );
    }
  }

  console.log(`\n=== Rappel ===`);
  console.log(`- EUR/USD, XAU/USD, GBP/JPY, US500 : pas de données minute réelles gratuites disponibles sur assez d'historique -- ce backtest ne peut rien dire sur ces paires-là pour l'instant.`);
  console.log(`- avgR positif ET cohérent train/test = signe d'un edge réel après coûts. avgR proche de 0 ou négatif = pas d'edge une fois le coût réel compté, même si le winrate brut a l'air correct.`);
}

main().catch((error) => {
  console.error("ERROR", error);
  process.exitCode = 1;
});
