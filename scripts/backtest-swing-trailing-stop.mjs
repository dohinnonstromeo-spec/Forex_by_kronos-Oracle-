// Same question as scripts/backtest-scalp-trailing-stop.mjs -- does a staged
// trailing stop beat the fixed TP1/TP2 the swing engine actually ships with --
// but against buildDeterministicSignals()'s own entry logic instead of the
// scalp mean-reversion one. Deliberately does NOT touch the entry side (same
// evaluateSignalAt/BASELINE_PARAMS already validated in scripts/backtest.mjs,
// copied here rather than imported since that script starts fetching on load
// and isn't designed as a module) -- only the exit mechanism is under test.
//
// Real difference from the scalp version, called out explicitly rather than
// glossed over: this runs on DAILY bars (Yahoo Finance / Binance daily
// klines), not M1. A trailing stop here reacts once per day, at daily
// high/low resolution -- coarser than the scalp version's minute-by-minute
// reaction, and the OHLC-only data means intra-day path between a bar's open
// and its high/low/close is unknown, same conservative "stop-side-of-the-bar-
// checked-first" assumption scripts/backtest.mjs already uses for SL/TP.
//
// Run with: node scripts/backtest-swing-trailing-stop.mjs [yahooRange]
//   yahooRange: Yahoo history window, default "5y" -- pass "max" (or "10y" if
//   Yahoo rejects max for a given symbol) to independently re-verify a finding
//   against a second, non-overlapping period (see the periodLabel split below),
//   same "two real windows must agree" bar the scalp backtest used.

const SYMBOLS = [
  { pair: "EUR/USD", kind: "yahoo", yahooSymbol: "EURUSD=X" },
  { pair: "XAU/USD", kind: "yahoo", yahooSymbol: "GC=F" },
  { pair: "GBP/JPY", kind: "yahoo", yahooSymbol: "GBPJPY=X" },
  { pair: "US500", kind: "yahoo", yahooSymbol: "^GSPC" },
  { pair: "BTC/USD", kind: "binance", binanceSymbol: "BTCUSDT" },
  { pair: "ETH/USD", kind: "binance", binanceSymbol: "ETHUSDT" },
  { pair: "USD/JPY", kind: "yahoo", yahooSymbol: "USDJPY=X" },
  { pair: "USD/CHF", kind: "yahoo", yahooSymbol: "USDCHF=X" },
];

const LOOKAHEAD_BARS = 20;
const COST_DRAG_R = 0.05;
const TRAIN_RATIO = 0.7;

// Exactly what buildDeterministicSignals() ships today -- unchanged from
// scripts/backtest.mjs's own BASELINE_PARAMS, so the entry signals compared
// here are the real production ones, not a research variant.
const BASELINE_PARAMS = {
  rsiUp: 52, rsiDown: 48, momentumMin: 0.04, volatilityMin: 0.0008, confluenceMin: 4, strengthMin: 0.18,
};

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
  })).filter(isValidBar);
}

// Yahoo's free FX feed returns literal zero-value OHLC bars on several
// low-liquidity holiday dates (confirmed on USD/CHF: 2025-01-01, 2025-04-17
// Good Friday, 2025-12-25, 2026-01-01, and likely the same dates on every
// other FX pair from the same feed) -- a bar reading close=0 looks like a
// fake 100% crash, and the NEXT real bar then looks like an "infinite" bounce
// back. Caught specifically because USD/CHF's trailing-stop result (avgR
// 7+, wildly out of line with every other pair's 0.1-1.5 range) was suspicious
// enough to investigate before trusting it -- confirmed live via a raw fetch
// showing exactly those zero bars. Filtering them out here, not silently
// leaving them for evaluateSignalAt to choke on.
function isValidBar(bar) {
  return Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low)
    && bar.close > 0 && bar.high > 0 && bar.low > 0;
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
  })).filter(isValidBar);
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

// Identical decision logic to evaluateSignalAt in scripts/backtest.mjs, with
// volume/mtf/structure/anti-chasing filters left at their shipped-off default
// (BASELINE_PARAMS never sets them) -- this is exactly what's live today.
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
  const momentumOk = Math.abs(momentum) >= params.momentumMin;
  const trendAligned = momentumOk && (momentum >= 0 ? rsi >= params.rsiUp : rsi <= params.rsiDown);
  const volatilityPct = atr / last;
  const volatilityOk = volatilityPct >= params.volatilityMin;
  const direction = momentum >= 0 ? "ACHAT" : "VENTE";
  const confluenceFactors = [trendAligned, volatilityOk, true, Math.abs(move) >= 0.05];
  const confluence = confluenceFactors.filter(Boolean).length;
  const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;
  if (strength < params.strengthMin || confluence < params.confluenceMin || !trendAligned) return null;
  const risk = Math.max(atr * 1.2, last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  return { direction, entry, sl, risk };
}

// Baseline: production TP1=1.6R/TP2=2.5R, whichever is touched first (TP2
// checked first if both are technically in the same bar's range, matching
// scripts/backtest.mjs's own simulateForward exactly).
function simulateFixedTp(bars, signalIndex, signal) {
  const buy = signal.direction === "ACHAT";
  const tp1 = buy ? signal.entry + signal.risk * 1.6 : signal.entry - signal.risk * 1.6;
  const tp2 = buy ? signal.entry + signal.risk * 2.5 : signal.entry - signal.risk * 2.5;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp2 = buy ? bar.high >= tp2 : bar.low <= tp2;
    const hitTp1 = buy ? bar.high >= tp1 : bar.low <= tp1;
    if (hitSl) return { result: "loss", rMultiple: -1 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp2) return { result: "win", rMultiple: 2.5 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp1) return { result: "win", rMultiple: 1.6 - COST_DRAG_R, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "expired", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

// Same staged mechanism as the scalp version: untouched below activationR,
// entry+buffer at activationR, trails bestFavR-trailR beyond activationR+trailR.
function simulateTrailingStop(bars, signalIndex, signal, activationR, trailR, bufferR) {
  const buy = signal.direction === "ACHAT";
  let stop = signal.sl;
  let bestFavR = -Infinity;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitStop = buy ? bar.low <= stop : bar.high >= stop;
    if (hitStop) {
      const rAtStop = buy ? (stop - signal.entry) / signal.risk : (signal.entry - stop) / signal.risk;
      return { result: rAtStop > 0 ? "win" : "loss", rMultiple: rAtStop - COST_DRAG_R, barsHeld: j - signalIndex };
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
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

// Hybrid experiment: retain the production TP1 while the validated staged
// trailing stop protects the position before that target is reached. The stop
// is checked before the target on each OHLC bar, keeping the same conservative
// path assumption as the two existing exit simulations above. Production stays
// trailing-only until the user explicitly enables the dashboard option.
function simulateHybridTpTrailingStop(bars, signalIndex, signal, activationR, trailR, bufferR) {
  const buy = signal.direction === "ACHAT";
  const tp1 = buy ? signal.entry + signal.risk * 1.6 : signal.entry - signal.risk * 1.6;
  let stop = signal.sl;
  let bestFavR = -Infinity;
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitStop = buy ? bar.low <= stop : bar.high >= stop;
    if (hitStop) {
      const rAtStop = buy ? (stop - signal.entry) / signal.risk : (signal.entry - stop) / signal.risk;
      return { result: rAtStop > 0 ? "win" : "loss", rMultiple: rAtStop - COST_DRAG_R, barsHeld: j - signalIndex };
    }
    const hitTp1 = buy ? bar.high >= tp1 : bar.low <= tp1;
    if (hitTp1) return { result: "win", rMultiple: 1.6 - COST_DRAG_R, barsHeld: j - signalIndex };
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
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
  return { result: "timeout", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 1000) / 10, avgR: Math.round((totalR / trades.length) * 1000) / 1000 };
}

function detailedSummary(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null, totalR: 0, maxDrawdownR: 0 };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const trade of [...trades].sort((a, b) => a.signalIndex - b.signalIndex)) {
    equity += trade.rMultiple;
    peak = Math.max(peak, equity);
    maxDrawdownR = Math.max(maxDrawdownR, peak - equity);
  }
  return {
    count: trades.length,
    winRate: Math.round((wins / trades.length) * 1000) / 10,
    avgR: Math.round((totalR / trades.length) * 1000) / 1000,
    totalR: Math.round(totalR * 1000) / 1000,
    maxDrawdownR: Math.round(maxDrawdownR * 1000) / 1000,
  };
}

function timeKey(dateValue, period) {
  const date = new Date(dateValue || "");
  if (!Number.isFinite(date.getTime())) return null;
  const year = String(date.getUTCFullYear());
  if (period === "year") return year;
  if (period === "month") return `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${year}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function bucketTrades(trades, period) {
  const buckets = new Map();
  for (const trade of trades) {
    const key = timeKey(trade.signalTimestamp, period);
    if (!key) continue;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(trade);
  }
  return buckets;
}

function shortStats(trades) {
  const stats = detailedSummary(trades);
  return `n=${stats.count} avgR=${stats.avgR >= 0 ? "+" : ""}${stats.avgR} totalR=${stats.totalR >= 0 ? "+" : ""}${stats.totalR} wr=${stats.winRate}%`;
}

function printTemporalBreakdown(pair, bars, methods) {
  const first = bars[0]?.date || "inconnu";
  const last = bars.at(-1)?.date || "inconnu";
  console.log(`\nTEMPORAL ${pair}: ${first} -> ${last} (signal date, sorties simulees sur chaque bougie journaliere)`);
  for (const method of methods) {
    const stats = detailedSummary(method.trades);
    const daily = [...bucketTrades(method.trades, "day").values()].map(detailedSummary);
    const positiveDays = daily.filter((d) => d.totalR > 0).length;
    const negativeDays = daily.filter((d) => d.totalR < 0).length;
    const bestDay = daily.length ? Math.max(...daily.map((d) => d.totalR)) : 0;
    const worstDay = daily.length ? Math.min(...daily.map((d) => d.totalR)) : 0;
    console.log(`  ${method.name} GLOBAL ${shortStats(method.trades)} maxDD=${stats.maxDrawdownR}R`);
    console.log(`  ${method.name} JOURS actifs=${daily.length} positifs=${positiveDays} negatifs=${negativeDays} meilleur=${bestDay >= 0 ? "+" : ""}${Math.round(bestDay * 1000) / 1000}R pire=${Math.round(worstDay * 1000) / 1000}R`);
  }
  for (const period of ["month", "year"]) {
    const keys = new Set();
    const maps = methods.map((method) => bucketTrades(method.trades, period));
    for (const map of maps) for (const key of map.keys()) keys.add(key);
    console.log(`  ${period.toUpperCase()}:`);
    for (const key of [...keys].sort()) {
      const values = methods.map((_, index) => shortStats(maps[index].get(key) || []));
      console.log(`    ${key} | ${methods.map((method, index) => `${method.name} ${values[index]}`).join(" | ")}`);
    }
  }
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

const ACTIVATION_RS = [0.2, 0.4, 0.6, 0.8, 1.0];
const TRAIL_RS = [0.3, 0.5, 0.75, 1.0];
const BUFFER_R = 0.15;

// These are the exact trailing settings currently shipped for the three swing
// pairs. Other pairs are intentionally not assigned a hybrid result here.
const CURRENT_TRAILING_PARAMS = {
  "EUR/USD": { activationR: 0.2, trailR: 0.3, bufferR: 0.15 },
  "XAU/USD": { activationR: 1, trailR: 0.5, bufferR: 0.15 },
  "USD/CHF": { activationR: 0.2, trailR: 0.3, bufferR: 0.15 },
};

// One pair, one already-fetched slice of bars (a whole history, OR one half of
// it for the two-independent-periods check) -- returns the baseline, the full
// grid, and which combos beat baseline on both its own train and test splits.
function analyzePeriod(pair, bars) {
  const signals = generateSignals(bars);
  if (!signals.length) return null;
  const baselineTrades = signals.map((s) => ({ split: s.split, ...simulateFixedTp(bars, s.index, s.signal) }));
  const baselineTrain = summarize(baselineTrades.filter((t) => t.split === "train"));
  const baselineTest = summarize(baselineTrades.filter((t) => t.split === "test"));
  const currentTrailing = CURRENT_TRAILING_PARAMS[pair];
  const hybridTrades = currentTrailing
    ? signals.map((s) => ({ split: s.split, ...simulateHybridTpTrailingStop(bars, s.index, s.signal, currentTrailing.activationR, currentTrailing.trailR, currentTrailing.bufferR) }))
    : [];
  const hybridTrain = summarize(hybridTrades.filter((t) => t.split === "train"));
  const hybridTest = summarize(hybridTrades.filter((t) => t.split === "test"));
  const results = [];
  for (const activationR of ACTIVATION_RS) {
    for (const trailR of TRAIL_RS) {
      const trades = signals.map((s) => ({ split: s.split, ...simulateTrailingStop(bars, s.index, s.signal, activationR, trailR, BUFFER_R) }));
      const train = summarize(trades.filter((t) => t.split === "train"));
      const test = summarize(trades.filter((t) => t.split === "test"));
      results.push({ activationR, trailR, train, test, beatsBaseline: train.avgR > baselineTrain.avgR && test.avgR > baselineTest.avgR });
    }
  }
  return { barCount: bars.length, signalCount: signals.length, baselineTrain, baselineTest, hybridTrain, hybridTest, results };
}

async function main() {
  const yahooRange = process.argv[2] || "5y";
  console.log(`Fenetre Yahoo demandee: ${yahooRange} -- Binance reste toujours limite a ses 1000 dernieres bougies journalieres (~2.7 ans), non ajustable ici.\n`);

  for (const symbolDef of SYMBOLS) {
    let bars;
    try {
      bars = symbolDef.kind === "yahoo" ? await fetchYahooDaily(symbolDef.yahooSymbol, yahooRange) : await fetchBinanceDaily(symbolDef.binanceSymbol);
    } catch (error) {
      console.log(`[${symbolDef.pair}] fetch echouee (${error.message}), ignore.`);
      continue;
    }
    if (bars.length < 400) { console.log(`[${symbolDef.pair}] pas assez de bougies (${bars.length}) pour couper en deux periodes independantes, ignore.`); continue; }
    console.log(`\n=== ${symbolDef.pair} (${bars.length} bougies journalieres, ${bars[0].date} -> ${bars.at(-1).date}) ===`);

    const currentTrailing = CURRENT_TRAILING_PARAMS[symbolDef.pair];
    if (currentTrailing) {
      const allSignals = generateSignals(bars);
      const fullBaselineTrades = allSignals.map((s) => ({ signalIndex: s.index, signalTimestamp: bars[s.index]?.date, ...simulateFixedTp(bars, s.index, s.signal) }));
      const fullTrailingTrades = allSignals.map((s) => ({ signalIndex: s.index, signalTimestamp: bars[s.index]?.date, ...simulateTrailingStop(bars, s.index, s.signal, currentTrailing.activationR, currentTrailing.trailR, currentTrailing.bufferR) }));
      const fullHybridTrades = allSignals.map((s) => ({ signalIndex: s.index, signalTimestamp: bars[s.index]?.date, ...simulateHybridTpTrailingStop(bars, s.index, s.signal, currentTrailing.activationR, currentTrailing.trailR, currentTrailing.bufferR) }));
      printTemporalBreakdown(symbolDef.pair, bars, [
        { name: "TP_FIXE", trades: fullBaselineTrades },
        { name: "TRAILING", trades: fullTrailingTrades },
        { name: "HYBRIDE", trades: fullHybridTrades },
      ]);
    }

    // Split into two genuinely separate, non-overlapping historical periods --
    // same "two real windows must independently agree" bar the scalp backtest
    // used (90d vs 365d there), adapted here since this is one continuous daily
    // pull rather than two separately-downloaded files: first half = the older
    // period, second half = the more recent one.
    const mid = Math.floor(bars.length / 2);
    const periods = [
      { label: "periode ancienne", bars: bars.slice(0, mid) },
      { label: "periode recente", bars: bars.slice(mid) },
    ];

    const periodAnalyses = periods.map((p) => ({ label: p.label, dates: `${p.bars[0]?.date} -> ${p.bars.at(-1)?.date}`, analysis: analyzePeriod(symbolDef.pair, p.bars) }));
    for (const { label, dates, analysis } of periodAnalyses) {
      if (!analysis) { console.log(`  [${label}] aucun signal genere.`); continue; }
      console.log(`  [${label}, ${dates}] BASELINE train avgR=${analysis.baselineTrain.avgR} (n=${analysis.baselineTrain.count}) | test avgR=${analysis.baselineTest.avgR} (n=${analysis.baselineTest.count})`);
      const sorted = [...analysis.results].sort((a, b) => (b.test.avgR ?? -99) - (a.test.avgR ?? -99));
      const best = sorted[0];
      console.log(`    Meilleur stop suiveur: activation=${best.activationR}R trail=${best.trailR}R -- train avgR=${best.train.avgR} | test avgR=${best.test.avgR} ${best.beatsBaseline ? "(bat la baseline)" : "(NE bat PAS la baseline)"}`);
      console.log(`    Combinaisons qui battent la baseline: ${analysis.results.filter((r) => r.beatsBaseline).length} / ${analysis.results.length}`);
      if (CURRENT_TRAILING_PARAMS[symbolDef.pair]) {
        const hybridBeatsBaseline = analysis.hybridTrain.avgR > analysis.baselineTrain.avgR && analysis.hybridTest.avgR > analysis.baselineTest.avgR;
        const p = CURRENT_TRAILING_PARAMS[symbolDef.pair];
        console.log(`    HYBRIDE TP1 1.6R + trailing actuel (activation=${p.activationR}R trail=${p.trailR}R): train avgR=${analysis.hybridTrain.avgR} | test avgR=${analysis.hybridTest.avgR} ${hybridBeatsBaseline ? "(bat la baseline sur les deux splits)" : "(ne bat pas la baseline sur les deux splits)"}`);
      }
    }

    // The real question this whole second period exists to answer: is there
    // ANY (activationR, trailR) combo that beats baseline on BOTH independent
    // periods at once -- not just "each period has its own separate winner",
    // which proves nothing about whether either winner would have held up
    // outside the window that produced it.
    const [older, recent] = periodAnalyses.map((p) => p.analysis);
    if (older && recent) {
      const agreeing = older.results.filter((rOld) => {
        const rNew = recent.results.find((r) => r.activationR === rOld.activationR && r.trailR === rOld.trailR);
        return rOld.beatsBaseline && rNew?.beatsBaseline;
      });
      console.log(`  >>> Combinaisons qui battent la baseline sur LES DEUX periodes independantes: ${agreeing.length} / ${older.results.length}`);
      if (agreeing.length) {
        const bestAgreeing = [...agreeing].sort((a, b) => {
          const rNewA = recent.results.find((r) => r.activationR === a.activationR && r.trailR === a.trailR);
          const rNewB = recent.results.find((r) => r.activationR === b.activationR && r.trailR === b.trailR);
          return (rNewB.test.avgR + b.test.avgR) - (rNewA.test.avgR + a.test.avgR);
        })[0];
        console.log(`      Meilleure combinaison robuste: activation=${bestAgreeing.activationR}R trail=${bestAgreeing.trailR}R`);
      } else {
        console.log(`      Aucune combinaison ne tient sur les deux periodes -- pas assez de preuve pour deployer cette paire.`);
      }
    }
  }
}

main().catch((error) => { console.error("ERROR", error); process.exitCode = 1; });
