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
  BASELINE_PARAMS,
  { ...BASELINE_PARAMS, name: "+ volume soft (confluence facultative)", volumeMode: "soft" },
  { ...BASELINE_PARAMS, name: "+ volume hard (bloque si volume faible)", volumeMode: "hard" },
  { ...BASELINE_PARAMS, name: "+ MTF hebdo soft (confluence facultative)", mtfMode: "soft" },
  { ...BASELINE_PARAMS, name: "+ MTF hebdo hard (bloque si conflit)", mtfMode: "hard" },
  { ...BASELINE_PARAMS, name: "+ volume hard + MTF hard (combiné)", volumeMode: "hard", mtfMode: "hard" },
  { ...BASELINE_PARAMS, name: "+ volume soft + MTF soft (combiné)", volumeMode: "soft", mtfMode: "soft" },
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
    volume: Number(quote.volume?.[i]),
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
    volume: Number(bar[5]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

// Monday-anchored weekly resample, used for the multi-timeframe filter. Only ever
// called on bars[0..i] (the same lookahead-safe window evaluateSignalAt already
// uses), so the last weekly bucket is naturally "this week so far" -- real
// compounding, not a peek at the future.
function resampleWeekly(dailyBars) {
  const weeks = new Map();
  for (const bar of dailyBars) {
    const d = new Date(`${bar.date}T00:00:00Z`);
    const day = d.getUTCDay();
    const mondayOffset = day === 0 ? -6 : 1 - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + mondayOffset);
    const key = monday.toISOString().slice(0, 10);
    const existing = weeks.get(key);
    if (!existing) {
      weeks.set(key, { date: key, close: bar.close, high: bar.high, low: bar.low });
    } else {
      existing.close = bar.close;
      existing.high = Math.max(existing.high, bar.high);
      existing.low = Math.min(existing.low, bar.low);
    }
  }
  return [...weeks.values()];
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

// volumeMode: "off" (default, no change from shipped behavior) | "soft" (one more
// confluence vote, confluenceMin unchanged so it's easier to satisfy) | "hard"
// (must be confirmed or the signal is dropped, independent of confluence count).
function volumeConfirmed(window) {
  const sample = window.slice(-21);
  if (sample.length < 21) return null; // not enough volume history to judge yet
  const volumes = sample.map((bar) => Number(bar.volume));
  if (!volumes.every(Number.isFinite) || volumes.some((v) => v <= 0)) return null; // provider didn't give real volume (e.g. most FX spot feeds)
  const current = volumes.at(-1);
  const priorAvg = average(volumes.slice(0, -1));
  return priorAvg > 0 ? current >= priorAvg * 1.0 : null;
}

// mtfMode: "off" | "soft" (confluence vote) | "hard" (block on outright weekly
// disagreement, neutral/insufficient weekly data does not block).
function weeklyDirection(window) {
  const weekly = resampleWeekly(window);
  if (weekly.length < 30) return null;
  const closes = weekly.map((w) => w.close);
  const sma10 = average(closes.slice(-10));
  const sma30 = average(closes.slice(-30));
  if (!(sma30 > 0)) return null;
  const momentum = ((sma10 - sma30) / sma30) * 100;
  if (Math.abs(momentum) < 0.1) return "neutral";
  return momentum >= 0 ? "ACHAT" : "VENTE";
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
  const direction = momentum >= 0 ? "ACHAT" : "VENTE";

  const volMode = params.volumeMode || "off";
  const volOk = volMode === "off" ? null : volumeConfirmed(window);
  if (volMode === "hard" && volOk === false) return null;

  const mtfMode = params.mtfMode || "off";
  const weekly = mtfMode === "off" ? null : weeklyDirection(window);
  const mtfConflict = weekly && weekly !== "neutral" && weekly !== direction;
  if (mtfMode === "hard" && mtfConflict) return null;

  const confluenceFactors = [trendAligned, volatilityOk, true, Math.abs(move) >= 0.05];
  if (volMode === "soft" && volOk !== null) confluenceFactors.push(volOk);
  if (mtfMode === "soft" && weekly !== null) confluenceFactors.push(!mtfConflict);
  const confluence = confluenceFactors.filter(Boolean).length;

  const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;
  if (strength < params.strengthMin || confluence < params.confluenceMin || !trendAligned) return null;
  const risk = Math.max(atr * (params.riskAtrMultiplier ?? 1.2), last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.6 : entry - risk * 1.6;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.5 : entry - risk * 2.5;
  return { direction, entry, sl, tp1, tp2, risk };
}

function simulateForward(bars, signalIndex, signal) {
  const buy = signal.direction === "ACHAT";
  const tp1R = Math.abs(signal.tp1 - signal.entry) / signal.risk;
  const tp2R = Math.abs(signal.tp2 - signal.entry) / signal.risk;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp2 = buy ? bar.high >= signal.tp2 : bar.low <= signal.tp2;
    const hitTp1 = buy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;
    // Conservative ordering when both could technically fall inside the same bar: SL first.
    if (hitSl) return { result: "loss", rMultiple: -1 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp2) return { result: "win", rMultiple: tp2R - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp1) return { result: "win", rMultiple: tp1R - COST_DRAG_R, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy
    ? (expiryClose - signal.entry) / signal.risk
    : (signal.entry - expiryClose) / signal.risk;
  return { result: "expired", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

function backtestSymbol(pair, bars, params, evaluator = evaluateSignalAt) {
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const trades = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const signal = evaluator(bars, i, params);
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

// Mean-reversion alternative: fade RSI extremes stretched away from the SMA30 mean,
// betting on a snap-back instead of following momentum. Classic counter-strategy to
// try when a trend-following approach has no edge on a choppy/volatile instrument.
function evaluateMeanReversionSignalAt(bars, i, params) {
  if (i < 60) return null;
  const window = bars.slice(0, i + 1);
  const closes = window.map((bar) => bar.close);
  const last = closes.at(-1);
  const sma30 = average(closes.slice(-30));
  const atr = average(window.slice(-14).map((bar) => Math.max(0, bar.high - bar.low))) || last * 0.004;
  const rsi = calculateRsi(closes.slice(-100));
  if (!Number.isFinite(last) || !Number.isFinite(rsi) || !Number.isFinite(sma30) || !sma30) return null;
  const stretchPct = Math.abs((last - sma30) / sma30) * 100;
  let direction = null;
  if (rsi <= params.oversold && stretchPct >= params.minStretch) direction = "ACHAT"; // oversold + stretched below mean: bet on a bounce
  if (rsi >= params.overbought && stretchPct >= params.minStretch) direction = "VENTE"; // overbought + stretched above mean: bet on a pullback
  if (!direction) return null;
  if (atr / last < params.volatilityMin) return null;
  const risk = Math.max(atr * (params.riskAtrMultiplier ?? 1.0), last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * params.tp1R : entry - risk * params.tp1R;
  const tp2 = direction === "ACHAT" ? entry + risk * params.tp2R : entry - risk * params.tp2R;
  return { direction, entry, sl, tp1, tp2, risk };
}

const MEAN_REVERSION_VARIANTS = [
  { name: "MR: RSI 25/75, tp 1.2R/2.0R", oversold: 25, overbought: 75, minStretch: 0.3, volatilityMin: 0.0008, riskAtrMultiplier: 1.0, tp1R: 1.2, tp2R: 2.0 },
  { name: "MR: RSI 20/80, tp 1.2R/2.0R", oversold: 20, overbought: 80, minStretch: 0.3, volatilityMin: 0.0008, riskAtrMultiplier: 1.0, tp1R: 1.2, tp2R: 2.0 },
  { name: "MR: RSI 25/75, tp 1.0R/1.6R (sortie rapide)", oversold: 25, overbought: 75, minStretch: 0.3, volatilityMin: 0.0008, riskAtrMultiplier: 1.0, tp1R: 1.0, tp2R: 1.6 },
  { name: "MR: RSI 25/75, stretch min 0.6%", oversold: 25, overbought: 75, minStretch: 0.6, volatilityMin: 0.0008, riskAtrMultiplier: 1.0, tp1R: 1.2, tp2R: 2.0 },
];

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

  console.log("\n\n=== Recherche cross JPY: retour à la moyenne vs suivi de tendance ===");
  const jpyPairs = [
    { pair: "GBP/JPY", yahooSymbol: "GBPJPY=X" },
    { pair: "EUR/JPY", yahooSymbol: "EURJPY=X" },
    { pair: "USD/JPY", yahooSymbol: "USDJPY=X" },
  ];
  const jpyDatasets = [];
  for (const { pair, yahooSymbol } of jpyPairs) {
    const existing = datasets.find((d) => d.pair === pair);
    if (existing) { jpyDatasets.push(existing); continue; }
    try {
      const bars = await fetchYahooDaily(yahooSymbol);
      if (bars.length >= 90) jpyDatasets.push({ pair, bars });
      else console.log(`  ${pair}: historique insuffisant -- ignoré.`);
    } catch (error) {
      console.log(`  ${pair}: échec de récupération (${error.message}) -- ignoré.`);
    }
  }

  console.log("\n-- Suivi de tendance (production actuelle) --");
  for (const { pair, bars } of jpyDatasets) {
    const trades = backtestSymbol(pair, bars, BASELINE_PARAMS);
    const train = trades.filter((t) => t.split === "train");
    const test = trades.filter((t) => t.split === "test");
    console.log(`  ${pair.padEnd(10)} | train: ${fmt(summarize(train))}  ||  test: ${fmt(summarize(test))}`);
  }

  for (const mrVariant of MEAN_REVERSION_VARIANTS) {
    console.log(`\n-- ${mrVariant.name} --`);
    const allTrain = [];
    const allTest = [];
    for (const { pair, bars } of jpyDatasets) {
      const trades = backtestSymbol(pair, bars, mrVariant, evaluateMeanReversionSignalAt);
      const train = trades.filter((t) => t.split === "train");
      const test = trades.filter((t) => t.split === "test");
      allTrain.push(...train);
      allTest.push(...test);
      console.log(`  ${pair.padEnd(10)} | train: ${fmt(summarize(train))}  ||  test: ${fmt(summarize(test))}`);
    }
    console.log(`  ${"GLOBAL".padEnd(10)} | train: ${fmt(summarize(allTrain))}  ||  test: ${fmt(summarize(allTest))}`);
  }
  console.log("\n  n=3 paires JPY seulement -- indicatif, pas une preuve statistique définitive sur \"les cross JPY\" en général.");
}

main();
