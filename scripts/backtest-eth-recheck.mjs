// Dedicated re-check of ETH/USD's entry edge, requested after the engine
// audit flagged that DETERMINISTIC_ENGINE_STATS_BY_PAIR's own comment already
// warns "bon sur train mais quasi nul sur test -- signe classique de
// sur-apprentissage" for this pair, yet nothing in the code actually acts on
// that warning -- it's still tradable as a "direct" signal like every other
// validated pair. Same unchanged production entry logic (evaluateSignalAt /
// BASELINE_PARAMS) and exit (fixed TP1 1.6R/TP2 2.5R -- ETH/USD isn't one of
// the 3 trailing-stop pairs), same two-independent-period discipline as every
// other backtest this session, this time reporting win rate alongside avgR
// for a complete picture. BTC/USD run alongside for direct comparison (same
// asset class, same limited ~2.7y Binance history window).

const SYMBOLS = [
  { pair: "ETH/USD", binanceSymbol: "ETHUSDT" },
  { pair: "BTC/USD", binanceSymbol: "BTCUSDT" },
];

const LOOKAHEAD_BARS = 20;
const COST_DRAG_R = 0.05;
const TRAIN_RATIO = 0.7;
const BASELINE_PARAMS = { rsiUp: 52, rsiDown: 48, momentumMin: 0.04, volatilityMin: 0.0008, confluenceMin: 4, strengthMin: 0.18 };

async function fetchBinanceDaily(binanceSymbol) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", binanceSymbol);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("limit", "1000");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`binance_http_${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("binance_invalid");
  return data.map((bar) => ({
    date: new Date(bar[0]).toISOString().slice(0, 10),
    close: Number(bar[4]), high: Number(bar[2]), low: Number(bar[3]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && bar.close > 0 && bar.high > 0 && bar.low > 0);
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
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
}

function evaluateSignalAt(bars, i, params) {
  if (i < 60) return null;
  const window = bars.slice(0, i + 1);
  const closes = window.map((bar) => bar.close);
  const last = closes.at(-1);
  const sma10 = average(closes.slice(-10));
  const sma30 = average(closes.slice(-30));
  const atr = average(window.slice(-14).map((bar) => Math.max(0, bar.high - bar.low))) || last * 0.004;
  const momentum = ((sma10 - sma30) / sma30) * 100;
  const rsi = calculateRsi(closes.slice(-100));
  const prevClose = closes.at(-2);
  const move = Number.isFinite(prevClose) && prevClose ? ((last - prevClose) / prevClose) * 100 : 0;
  if (!Number.isFinite(last) || !Number.isFinite(momentum) || !Number.isFinite(rsi)) return null;
  const trendAligned = Math.abs(momentum) >= params.momentumMin && (momentum >= 0 ? rsi >= params.rsiUp : rsi <= params.rsiDown);
  const volatilityOk = (atr / last) >= params.volatilityMin;
  const direction = momentum >= 0 ? "ACHAT" : "VENTE";
  const confluence = [trendAligned, volatilityOk, true, Math.abs(move) >= 0.05].filter(Boolean).length;
  const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;
  if (strength < params.strengthMin || confluence < params.confluenceMin || !trendAligned) return null;
  const risk = Math.max(atr * 1.2, last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  return { direction, entry, sl, risk };
}

function simulateFixedTp(bars, signalIndex, signal) {
  const buy = signal.direction === "ACHAT";
  const tp1 = buy ? signal.entry + signal.risk * 1.6 : signal.entry - signal.risk * 1.6;
  const tp2 = buy ? signal.entry + signal.risk * 2.5 : signal.entry - signal.risk * 2.5;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp2 = buy ? bar.high >= tp2 : bar.low <= tp2;
    const hitTp1 = buy ? bar.high >= tp1 : bar.low <= tp1;
    if (hitSl) return { result: "loss", rMultiple: -1 - COST_DRAG_R };
    if (hitTp2) return { result: "win", rMultiple: 2.5 - COST_DRAG_R };
    if (hitTp1) return { result: "win", rMultiple: 1.6 - COST_DRAG_R };
  }
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: markToMarketR > 0 ? "win" : "loss", rMultiple: markToMarketR - COST_DRAG_R };
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 1000) / 10, avgR: Math.round((totalR / trades.length) * 1000) / 1000 };
}

function generateSignals(bars) {
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const signals = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const signal = evaluateSignalAt(bars, i, BASELINE_PARAMS);
    if (!signal) continue;
    signals.push({ index: i, signal, split: i < trainCutoff ? "train" : "test" });
  }
  return signals;
}

async function main() {
  for (const symbolDef of SYMBOLS) {
    const bars = await fetchBinanceDaily(symbolDef.binanceSymbol);
    console.log(`\n=== ${symbolDef.pair} (${bars.length} bougies, ${bars[0].date} -> ${bars.at(-1).date}) ===`);
    const mid = Math.floor(bars.length / 2);
    const periods = [
      { label: "periode ancienne", bars: bars.slice(0, mid) },
      { label: "periode recente", bars: bars.slice(mid) },
    ];
    let positiveCells = 0;
    let totalCells = 0;
    for (const p of periods) {
      const signals = generateSignals(p.bars);
      const trades = signals.map((s) => ({ split: s.split, ...simulateFixedTp(p.bars, s.index, s.signal) }));
      const train = summarize(trades.filter((t) => t.split === "train"));
      const test = summarize(trades.filter((t) => t.split === "test"));
      console.log(`  [${p.label}] train: avgR=${train.avgR} winRate=${train.winRate}% (n=${train.count}) | test: avgR=${test.avgR} winRate=${test.winRate}% (n=${test.count})`);
      for (const s of [train, test]) { totalCells++; if (s.avgR > 0) positiveCells++; }
    }
    console.log(`  >>> Cellules positives (train+test x 2 periodes = 4 au total): ${positiveCells}/${totalCells} -- ${positiveCells === totalCells ? "EDGE ROBUSTE" : "EDGE NON ROBUSTE, ne passe pas la barre"}`);
  }
}

main().catch((error) => { console.error("Erreur fatale:", error); process.exit(1); });
