// Walk-forward backtest of the signal logic used in buildDeterministicSignals()
// (server.mjs), replayed against real historical bars pulled from free, no-API-key
// sources (Yahoo Finance daily chart for FX/metals/index, Binance public klines for
// crypto). Also doubles as a parameter-search harness: pass variants below and it
// reports train vs. held-out test performance for each, so a threshold change only
// ships if it generalizes instead of just curve-fitting this one historical window.
//
// Standalone on purpose (does not import server.mjs, which starts an HTTP server as
// a side effect on load). Run with: node scripts/backtest.mjs
//
// What this is: a signal-quality check on one strategy variant, on the history that
// happens to be reachable without paid data. What this is NOT: a claim about future
// performance, a full portfolio simulation (trades are evaluated independently, not
// with realistic concurrent position sizing), or a precise cost model (spread/slippage
// is approximated as a flat R haircut, not per-instrument order-book reality).

const SYMBOLS = [
  { pair: "EUR/USD", kind: "yahoo", yahooSymbol: "EURUSD=X" },
  { pair: "XAU/USD", kind: "yahoo", yahooSymbol: "GC=F" }, // gold futures used as a spot-XAU/USD proxy: no free spot-gold history without a key
  { pair: "GBP/JPY", kind: "yahoo", yahooSymbol: "GBPJPY=X" },
  { pair: "US500", kind: "yahoo", yahooSymbol: "^GSPC" },
  { pair: "BTC/USD", kind: "binance", binanceSymbol: "BTCUSDT" },
  { pair: "ETH/USD", kind: "binance", binanceSymbol: "ETHUSDT" },
];

const LOOKAHEAD_BARS = 20; // ~1 trading month on daily bars: how long a signal is given to hit TP/SL before being marked "expired"
const COST_DRAG_R = 0.05; // flat spread/slippage haircut applied to every trade's realized R, in R units
const TRAIN_RATIO = 0.7; // first 70% of each symbol's history = train (used to pick a variant), last 30% = held-out test (used only to confirm)

const PRE_FIX_PARAMS = {
  name: "pré-correctif (avant ce backtest)",
  rsiUp: 52,
  rsiDown: 48,
  momentumMin: 0, // no floor: any momentum sign + RSI alignment counted, however tiny
  volatilityMin: 0.0008,
  confluenceMin: 3,
  strengthMin: 0.18,
};

// What buildDeterministicSignals() actually ships today -- confluence 4/4 and a 0.04
// momentum floor, both validated against this same held-out test split. Used as the
// base for further research below (e.g. the GBP/JPY section) so those tests build on
// top of production, not on the older config.
const BASELINE_PARAMS = { ...PRE_FIX_PARAMS, name: "production actuelle (momentum 0.04 + confluence 4/4)", momentumMin: 0.04, confluenceMin: 4 };

const VARIANTS = [
  PRE_FIX_PARAMS,
  BASELINE_PARAMS,
];

async function fetchYahooDaily(yahooSymbol, range = "5y") {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", "1d");
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`yahoo_http_${response.status}`);
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || "yahoo_no_data");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    close: Number(quote.close?.[i]),
    high: Number(quote.high?.[i]),
    low: Number(quote.low?.[i]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

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
    close: Number(bar[4]),
    high: Number(bar[2]),
    low: Number(bar[3]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : NaN;
}

// Wilder's smoothed RSI, identical formula to calculateRsi() in server.mjs.
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

// Same decision structure as buildDeterministicSignals() in server.mjs, but with the
// threshold values pulled out into `params` so variants can be tested honestly.
function evaluateSignalAt(bars, i, params) {
  if (i < 60) return null; // need enough history for SMA30 + a converged Wilder RSI
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
  const momentumOk = Math.abs(momentum) >= params.momentumMin;
  const trendAligned = momentumOk && (momentum >= 0 ? rsi >= params.rsiUp : rsi <= params.rsiDown);
  const volatilityPct = atr / last;
  const volatilityOk = volatilityPct >= params.volatilityMin;
  if (volatilityPct > (params.volatilityMax ?? Infinity)) return null; // skip signals during abnormal volatility spikes (e.g. news whipsaws)
  const confluence = [trendAligned, volatilityOk, true, Math.abs(move) >= 0.05].filter(Boolean).length;
  const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;
  if (strength < params.strengthMin || confluence < params.confluenceMin || !trendAligned) return null;
  const direction = momentum >= 0 ? "ACHAT" : "VENTE";
  const risk = Math.max(atr * (params.riskAtrMultiplier ?? 1.2), last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.6 : entry - risk * 1.6;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.5 : entry - risk * 2.5;
  return { direction, entry, sl, tp1, tp2, risk };
}

function simulateForward(bars, signalIndex, signal) {
  const buy = signal.direction === "ACHAT";
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp2 = buy ? bar.high >= signal.tp2 : bar.low <= signal.tp2;
    const hitTp1 = buy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;
    // Conservative ordering when both could technically fall inside the same bar: SL first.
    if (hitSl) return { result: "loss", rMultiple: -1 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp2) return { result: "win", rMultiple: 2.5 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp1) return { result: "win", rMultiple: 1.6 - COST_DRAG_R, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy
    ? (expiryClose - signal.entry) / signal.risk
    : (signal.entry - expiryClose) / signal.risk;
  return { result: "expired", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

function backtestSymbol(pair, bars, params) {
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const signal = evaluateSignalAt(bars, i, params);
    if (!signal) continue;
    trades.push({
      pair,
      date: bars[i].date,
      split: i < trainCutoff ? "train" : "test",
      direction: signal.direction,
      ...simulateForward(bars, i, signal),
    });
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null, totalR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return {
    count: trades.length,
    winRate: Math.round((wins / trades.length) * 1000) / 10,
    avgR: Math.round((totalR / trades.length) * 1000) / 1000,
    totalR: Math.round(totalR * 100) / 100,
  };
}

function fmt(stats) {
  if (!stats.count) return "0 trade";
  return `${stats.count} trades | winrate ${stats.winRate}% | R moyen ${stats.avgR >= 0 ? "+" : ""}${stats.avgR}`;
}

async function loadAllData() {
  const datasets = [];
  for (const symbol of SYMBOLS) {
    try {
      const bars = symbol.kind === "yahoo"
        ? await fetchYahooDaily(symbol.yahooSymbol)
        : await fetchBinanceDaily(symbol.binanceSymbol);
      if (bars.length < 90) {
        console.log(`${symbol.pair}: historique insuffisant (${bars.length} bougies) -- ignoré.`);
        continue;
      }
      datasets.push({ pair: symbol.pair, bars });
    } catch (error) {
      console.log(`${symbol.pair}: échec de récupération des données (${error.message}) -- ignoré.`);
    }
  }
  return datasets;
}

async function main() {
  console.log("Backtest walk-forward de buildDeterministicSignals() -- données réelles, sans clé API.");
  console.log(`Split train/test: ${Math.round(TRAIN_RATIO * 100)}%/${Math.round((1 - TRAIN_RATIO) * 100)}% par paire (le test n'est jamais utilisé pour choisir un seuil).\n`);

  const datasets = await loadAllData();
  if (!datasets.length) {
    console.log("Aucune donnée récupérée -- vérifie la connectivité réseau.");
    return;
  }

  for (const variant of VARIANTS) {
    console.log(`\n=== Variante: ${variant.name} ===`);
    const allTrain = [];
    const allTest = [];
    for (const { pair, bars } of datasets) {
      const trades = backtestSymbol(pair, bars, variant);
      const train = trades.filter((t) => t.split === "train");
      const test = trades.filter((t) => t.split === "test");
      allTrain.push(...train);
      allTest.push(...test);
      console.log(`  ${pair.padEnd(8)} | train: ${fmt(summarize(train))}  ||  test: ${fmt(summarize(test))}`);
    }
    console.log(`  ${"GLOBAL".padEnd(8)} | train: ${fmt(summarize(allTrain))}  ||  test: ${fmt(summarize(allTest))}`);
  }

  console.log("\nLecture: une variante ne vaut la peine d'être expédiée que si le R moyen s'améliore (ou reste");
  console.log("stable) À LA FOIS sur train ET sur test hors-échantillon. Une amélioration seulement sur train");
  console.log("est du sur-apprentissage sur cette fenêtre historique précise, pas un vrai edge.");
  console.log("\nLimites: échantillon borné par l'historique gratuit disponible, pas de gestion de portefeuille");
  console.log("(trades évalués indépendamment), coûts approximés par un haircut fixe plutôt qu'un carnet d'ordres réel.");

  const gbpjpy = datasets.find((d) => d.pair === "GBP/JPY");
  if (gbpjpy) {
    console.log("\n\n=== Recherche ciblée GBP/JPY (n=1 paire JPY dans l'échantillon -- ne pas généraliser à toutes les paires JPY) ===");
    const jpyVariants = [
      { ...BASELINE_PARAMS, name: "baseline (SL atr*1.2)", riskAtrMultiplier: 1.2 },
      { ...BASELINE_PARAMS, name: "SL plus large (atr*1.6)", riskAtrMultiplier: 1.6 },
      { ...BASELINE_PARAMS, name: "SL plus large (atr*2.0)", riskAtrMultiplier: 2.0 },
      { ...BASELINE_PARAMS, name: "plafond volatilité (skip si ATR>1.5%)", volatilityMax: 0.015 },
      { ...BASELINE_PARAMS, name: "SL atr*1.6 + plafond volatilité 1.5%", riskAtrMultiplier: 1.6, volatilityMax: 0.015 },
    ];
    for (const variant of jpyVariants) {
      const trades = backtestSymbol("GBP/JPY", gbpjpy.bars, variant);
      const train = trades.filter((t) => t.split === "train");
      const test = trades.filter((t) => t.split === "test");
      console.log(`  ${variant.name.padEnd(42)} | train: ${fmt(summarize(train))}  ||  test: ${fmt(summarize(test))}`);
    }
    console.log("\n  (baseline ci-dessus utilise déjà confluence 4/4 + momentum floor 0.04, la config expédiée en prod)");
  }
}

main();
