// Does pyramiding (adding to an already-winning position on the SAME pair,
// same direction, while it's still open) genuinely improve the swing engine's
// expectancy, or does it just add correlated risk for no real benefit?
// Requested directly after discussing why the auto-trader blocks a second
// position on a pair that's already open ("pas possible d'avoir plusieurs
// positions de la meme paire tant que le score de confiance est assez
// eleve?") -- the real mechanical reason is that the engine re-evaluates every
// 60s and a strong trend can keep signaling for many consecutive cycles,
// which without a dedup would open near-identical stacked positions on the
// SAME move, not independent opportunities. Genuine pyramiding is a
// different, deliberate thing: smaller each add, minimum spacing between
// adds, a hard cap on total combined risk -- backtested here rather than
// assumed to help.
//
// Uses the SAME unchanged production entry logic (evaluateSignalAt /
// BASELINE_PARAMS, copied verbatim, same as every other backtest script in
// this repo) and the SAME exit mechanism each pair actually ships with today
// (staged trailing stop for XAU/USD, USD/CHF, EUR/USD -- see
// SWING_TRAILING_PARAMS_BY_PAIR in server.mjs; fixed TP1 1.6R/TP2 2.5R for
// the rest). GBP/JPY excluded -- it has no validated entry edge at all
// (PAIRS_WITHOUT_VALIDATED_EDGE), so pyramiding a losing edge only tells you
// it's still losing, with more risk.
//
// Each open leg (base + adds) is tracked independently with its OWN
// entry/sl/risk/trailing state -- an add's stop hitting doesn't force the
// base to close and vice versa, same as how a real trader would actually
// manage a pyramided position. sizeFraction is risk-weighted, not
// lot-weighted: an add's contribution to the trade's total R is its own
// rMultiple times its sizeFraction of the BASE position's dollar risk, so a
// 0.5 sizeFraction add means "risk half as many real dollars as the base
// leg", regardless of that add's own stop distance.
//
// Run with: node scripts/backtest-swing-pyramiding.mjs [yahooRange]

const SYMBOLS = [
  { pair: "XAU/USD", yahooSymbol: "GC=F", exitType: "trailing", trailParams: { activationR: 1, trailR: 0.5, bufferR: 0.15 } },
  { pair: "USD/CHF", yahooSymbol: "USDCHF=X", exitType: "trailing", trailParams: { activationR: 0.2, trailR: 0.3, bufferR: 0.15 } },
  { pair: "EUR/USD", yahooSymbol: "EURUSD=X", exitType: "trailing", trailParams: { activationR: 0.2, trailR: 0.3, bufferR: 0.15 } },
  { pair: "US500", yahooSymbol: "^GSPC", exitType: "fixed" },
  { pair: "USD/JPY", yahooSymbol: "USDJPY=X", exitType: "fixed" },
  { pair: "BTC/USD", binanceSymbol: "BTCUSDT", exitType: "fixed" },
  { pair: "ETH/USD", binanceSymbol: "ETHUSDT", exitType: "fixed" },
];

const LOOKAHEAD_BARS = 20;
const COST_DRAG_R = 0.05;
const TRAIN_RATIO = 0.7;

const BASELINE_PARAMS = {
  rsiUp: 52, rsiDown: 48, momentumMin: 0.04, volatilityMin: 0.0008, confluenceMin: 4, strengthMin: 0.18,
};

async function fetchYahooDaily(yahooSymbol, range = "10y") {
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
  // Approximates computeDeterministicSignal's real confidence formula (server.mjs)
  // for signals this simplified backtest can't compute exactly: confidence = 52 +
  // strength*8 + history.length/12 + confluence*4 + reliability/12 - freshnessPenalty,
  // capped [48, 88]. history.length/12 and reliability/12 use best-case production
  // values (80-candle history, ~90 reliability, no freshness penalty) since a
  // backtest signal is, by construction, always "good" data -- this is the SAME
  // generous assumption a live signal gets when data quality is actually fine, so
  // it's a fair proxy, not an inflated one.
  const confidence = Math.round(Math.max(48, Math.min(88, 52 + strength * 8 + 80 / 12 + confluence * 4 + 90 / 12)));
  return { direction, entry, sl, risk, strength, confluence, confidence };
}

function simulateSingle(bars, signalIndex, signal, exitType, trailParams) {
  const buy = signal.direction === "ACHAT";
  if (exitType === "trailing") {
    let stop = signal.sl;
    let bestFavR = -Infinity;
    for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
      const bar = bars[j];
      const hitStop = buy ? bar.low <= stop : bar.high >= stop;
      if (hitStop) {
        const rAtStop = buy ? (stop - signal.entry) / signal.risk : (signal.entry - stop) / signal.risk;
        return { result: rAtStop > 0 ? "win" : "loss", rMultiple: rAtStop - COST_DRAG_R };
      }
      const favExtreme = buy ? bar.high : bar.low;
      const favR = buy ? (favExtreme - signal.entry) / signal.risk : (signal.entry - favExtreme) / signal.risk;
      if (favR > bestFavR) bestFavR = favR;
      if (bestFavR >= trailParams.activationR) {
        const breakevenStop = buy ? signal.entry + trailParams.bufferR * signal.risk : signal.entry - trailParams.bufferR * signal.risk;
        const trailedStop = bestFavR >= trailParams.activationR + trailParams.trailR
          ? (buy ? signal.entry + (bestFavR - trailParams.trailR) * signal.risk : signal.entry - (bestFavR - trailParams.trailR) * signal.risk)
          : breakevenStop;
        stop = buy ? Math.max(stop, breakevenStop, trailedStop) : Math.min(stop, breakevenStop, trailedStop);
      }
    }
    const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
    const expiryClose = bars[expiryIndex].close;
    const markToMarketR = buy ? (expiryClose - signal.entry) / signal.risk : (signal.entry - expiryClose) / signal.risk;
    return { result: "timeout", rMultiple: markToMarketR - COST_DRAG_R };
  }
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
  return { result: "expired", rMultiple: markToMarketR - COST_DRAG_R };
}

// The pyramiding simulation itself: base leg + up to (maxLegs-1) adds, each
// tracked with fully independent entry/sl/trailing state. An add only fires
// while the BASE leg is still open, at or beyond addActivationR of running
// profit (measured on the base leg specifically), with at least
// minBarsBetweenAdds daily bars since the last add, AND only if a genuine new
// signal (same direction) actually fires at that bar under the unchanged
// production entry logic -- this is not "add every bar regardless", it's
// "add only when the engine would have opened a fresh position anyway".
function simulateWithPyramiding(bars, baseIndex, baseSignal, exitType, trailParams, pyramidParams) {
  const { addActivationR, addSizeFraction, minBarsBetweenAdds, maxLegs } = pyramidParams;
  const buy = baseSignal.direction === "ACHAT";
  const legs = [{ entry: baseSignal.entry, sl: baseSignal.sl, risk: baseSignal.risk, sizeFraction: 1, stop: baseSignal.sl, bestFavR: -Infinity, closed: false, rMultiple: null }];
  let lastAddIndex = baseIndex;
  const endIndex = Math.min(baseIndex + LOOKAHEAD_BARS, bars.length - 1);

  for (let j = baseIndex + 1; j <= endIndex; j++) {
    const bar = bars[j];
    for (const leg of legs) {
      if (leg.closed) continue;
      if (exitType === "trailing") {
        const hitStop = buy ? bar.low <= leg.stop : bar.high >= leg.stop;
        if (hitStop) {
          const rAtStop = buy ? (leg.stop - leg.entry) / leg.risk : (leg.entry - leg.stop) / leg.risk;
          leg.closed = true; leg.rMultiple = rAtStop - COST_DRAG_R;
          continue;
        }
        const favExtreme = buy ? bar.high : bar.low;
        const favR = buy ? (favExtreme - leg.entry) / leg.risk : (leg.entry - favExtreme) / leg.risk;
        if (favR > leg.bestFavR) leg.bestFavR = favR;
        if (leg.bestFavR >= trailParams.activationR) {
          const breakevenStop = buy ? leg.entry + trailParams.bufferR * leg.risk : leg.entry - trailParams.bufferR * leg.risk;
          const trailedStop = leg.bestFavR >= trailParams.activationR + trailParams.trailR
            ? (buy ? leg.entry + (leg.bestFavR - trailParams.trailR) * leg.risk : leg.entry - (leg.bestFavR - trailParams.trailR) * leg.risk)
            : breakevenStop;
          leg.stop = buy ? Math.max(leg.stop, breakevenStop, trailedStop) : Math.min(leg.stop, breakevenStop, trailedStop);
        }
      } else {
        const tp1 = buy ? leg.entry + leg.risk * 1.6 : leg.entry - leg.risk * 1.6;
        const tp2 = buy ? leg.entry + leg.risk * 2.5 : leg.entry - leg.risk * 2.5;
        const hitSl = buy ? bar.low <= leg.sl : bar.high >= leg.sl;
        const hitTp2 = buy ? bar.high >= tp2 : bar.low <= tp2;
        const hitTp1 = buy ? bar.high >= tp1 : bar.low <= tp1;
        if (hitSl) { leg.closed = true; leg.rMultiple = -1 - COST_DRAG_R; continue; }
        if (hitTp2) { leg.closed = true; leg.rMultiple = 2.5 - COST_DRAG_R; continue; }
        if (hitTp1) { leg.closed = true; leg.rMultiple = 1.6 - COST_DRAG_R; continue; }
      }
    }

    const base = legs[0];
    if (legs.length < maxLegs && (j - lastAddIndex) >= minBarsBetweenAdds) {
      // Two different questions under test, deliberately kept separate: "profit"
      // (the original ask -- add only once the existing position is already
      // winning) requires the base leg to still be open AND running ahead by
      // addActivationR. "confidence" (the follow-up ask -- "pas possible d'avoir
      // plusieurs positions de la meme paire tant que le score de confiance est
      // de 85%?") drops the profit requirement entirely -- a new position can
      // stack on top of an ALREADY-LOSING one too, gated purely on how good the
      // new signal itself looks, independent of whether the existing exposure
      // is winning or not.
      const gateOpen = pyramidParams.gateType === "confidence"
        ? true
        : !base.closed && (buy ? (bar.close - base.entry) / base.risk : (base.entry - bar.close) / base.risk) >= addActivationR;
      if (gateOpen) {
        const candidate = evaluateSignalAt(bars, j, BASELINE_PARAMS);
        const confidenceOk = pyramidParams.gateType === "confidence" ? candidate?.confidence >= pyramidParams.minConfidence : true;
        if (candidate && candidate.direction === baseSignal.direction && confidenceOk) {
          legs.push({ entry: candidate.entry, sl: candidate.sl, risk: candidate.risk, sizeFraction: addSizeFraction, stop: candidate.sl, bestFavR: -Infinity, closed: false, rMultiple: null });
          lastAddIndex = j;
        }
      }
    }
    if (legs.every((l) => l.closed)) break;
  }

  const expiryClose = bars[endIndex].close;
  for (const leg of legs) {
    if (leg.closed) continue;
    const markToMarketR = buy ? (expiryClose - leg.entry) / leg.risk : (leg.entry - expiryClose) / leg.risk;
    leg.closed = true; leg.rMultiple = markToMarketR - COST_DRAG_R;
  }
  const totalWeight = legs.reduce((sum, l) => sum + l.sizeFraction, 0);
  const weightedR = legs.reduce((sum, l) => sum + l.rMultiple * l.sizeFraction, 0);
  return { legCount: legs.length, totalWeight, rMultiple: weightedR, riskAdjustedR: weightedR / totalWeight, result: weightedR > 0 ? "win" : "loss" };
}

function summarize(trades, field = "rMultiple") {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t[field], 0);
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

const PYRAMID_GRID = [];
for (const addActivationR of [0.5, 1.0, 1.5]) {
  for (const addSizeFraction of [0.5, 0.75]) {
    for (const maxLegs of [2, 3]) {
      PYRAMID_GRID.push({ gateType: "profit", addActivationR, addSizeFraction, minBarsBetweenAdds: 5, maxLegs });
    }
  }
}

// Follow-up question, tested separately: "pas possible d'avoir plusieurs
// positions de la meme paire tant que le score de confiance est de 85%?" --
// gates purely on the NEW signal's own (approximated) confidence, with NO
// requirement that the existing position already be winning. 85 is
// deliberately included even though the formula caps at 88 (near the
// ceiling, extremely selective) alongside lower thresholds for comparison.
const CONFIDENCE_GRID = [];
for (const minConfidence of [70, 80, 85, 88]) {
  for (const addSizeFraction of [0.5, 0.75]) {
    for (const maxLegs of [2, 3]) {
      CONFIDENCE_GRID.push({ gateType: "confidence", minConfidence, addSizeFraction, minBarsBetweenAdds: 5, maxLegs });
    }
  }
}

function analyzePeriod(symbolDef, bars, grid) {
  const signals = generateSignals(bars);
  if (!signals.length) return null;
  const baselineTrades = signals.map((s) => ({ split: s.split, ...simulateSingle(bars, s.index, s.signal, symbolDef.exitType, symbolDef.trailParams) }));
  const baselineTrain = summarize(baselineTrades.filter((t) => t.split === "train"));
  const baselineTest = summarize(baselineTrades.filter((t) => t.split === "test"));

  const results = grid.map((params) => {
    const trades = signals.map((s) => ({ split: s.split, ...simulateWithPyramiding(bars, s.index, s.signal, symbolDef.exitType, symbolDef.trailParams, params) }));
    const train = summarize(trades.filter((t) => t.split === "train"));
    const test = summarize(trades.filter((t) => t.split === "test"));
    const trainRA = summarize(trades.filter((t) => t.split === "train"), "riskAdjustedR");
    const testRA = summarize(trades.filter((t) => t.split === "test"), "riskAdjustedR");
    const avgLegs = Math.round((trades.reduce((sum, t) => sum + t.legCount, 0) / trades.length) * 100) / 100;
    return {
      params, train, test, trainRA, testRA, avgLegs,
      beatsBaselineRaw: train.avgR > baselineTrain.avgR && test.avgR > baselineTest.avgR,
      beatsBaselineRiskAdjusted: trainRA.avgR > baselineTrain.avgR && testRA.avgR > baselineTest.avgR,
    };
  });

  return { signalCount: signals.length, baselineTrain, baselineTest, results };
}

async function main() {
  const yahooRange = process.argv[2] || "10y";

  for (const symbolDef of SYMBOLS) {
    let bars;
    try {
      bars = symbolDef.yahooSymbol ? await fetchYahooDaily(symbolDef.yahooSymbol, yahooRange) : await fetchBinanceDaily(symbolDef.binanceSymbol);
    } catch (error) {
      console.log(`[${symbolDef.pair}] fetch echouee (${error.message}), ignore.`);
      continue;
    }
    if (bars.length < 400) { console.log(`[${symbolDef.pair}] pas assez de bougies, ignore.`); continue; }
    console.log(`\n=== ${symbolDef.pair} (exit: ${symbolDef.exitType}, ${bars.length} bougies, ${bars[0].date} -> ${bars.at(-1).date}) ===`);

    const allSignals = generateSignals(bars);
    const confidences = allSignals.map((s) => s.signal.confidence).sort((a, b) => a - b);
    const pct = (p) => confidences[Math.min(confidences.length - 1, Math.floor(p * confidences.length))];
    console.log(`  Distribution de confiance (approximee) sur tous les signaux: p50=${pct(0.5)} p80=${pct(0.8)} p90=${pct(0.9)} p95=${pct(0.95)} max=${confidences.at(-1)} (${confidences.filter((c) => c >= 85).length}/${confidences.length} atteignent 85+)`);

    const mid = Math.floor(bars.length / 2);
    const periods = [
      { label: "periode ancienne", bars: bars.slice(0, mid) },
      { label: "periode recente", bars: bars.slice(mid) },
    ];

    for (const [gridName, grid] of [["PROFIT (empiler seulement si deja gagnant)", PYRAMID_GRID], ["CONFIANCE (empiler des qu'un nouveau signal est assez bon, gagnant ou pas)", CONFIDENCE_GRID]]) {
      const periodAnalyses = periods.map((p) => ({ label: p.label, analysis: analyzePeriod(symbolDef, p.bars, grid) }));
      for (const { label, analysis } of periodAnalyses) {
        if (!analysis) { console.log(`  [${label}] aucun signal.`); continue; }
        console.log(`  [${label}] BASELINE (1 position) train avgR=${analysis.baselineTrain.avgR} (n=${analysis.baselineTrain.count}) test avgR=${analysis.baselineTest.avgR} (n=${analysis.baselineTest.count})`);
      }
      const [older, recent] = periodAnalyses.map((p) => p.analysis);
      if (!older || !recent) continue;

      const robustRaw = [];
      const robustRiskAdjusted = [];
      for (let i = 0; i < grid.length; i++) {
        const o = older.results[i];
        const r = recent.results[i];
        if (o.beatsBaselineRaw && r.beatsBaselineRaw) robustRaw.push(i);
        if (o.beatsBaselineRiskAdjusted && r.beatsBaselineRiskAdjusted) robustRiskAdjusted.push(i);
      }

      console.log(`  --- Grille ${gridName} ---`);
      console.log(`  >>> Bat la baseline en R BRUT sur LES DEUX periodes: ${robustRaw.length} / ${grid.length}`);
      console.log(`  >>> Bat la baseline en R AJUSTE AU RISQUE sur LES DEUX periodes: ${robustRiskAdjusted.length} / ${grid.length}`);
      for (const idx of robustRiskAdjusted.slice(0, 3)) {
        const p = grid[idx];
        const o = older.results[idx], r = recent.results[idx];
        const paramsLabel = p.gateType === "confidence" ? `confiance>=${p.minConfidence}` : `activation=${p.addActivationR}R`;
        console.log(`      ${paramsLabel} taille_ajout=${p.addSizeFraction}x max_legs=${p.maxLegs} -- legs moy. ${o.avgLegs}/${r.avgLegs} -- ancienne: brut=${o.train.avgR}/${o.test.avgR} ajuste=${o.trainRA.avgR}/${o.testRA.avgR} -- recente: brut=${r.train.avgR}/${r.test.avgR} ajuste=${r.trainRA.avgR}/${r.testRA.avgR}`);
      }
    }
  }
}

main().catch((error) => {
  console.error("Erreur fatale:", error);
  process.exit(1);
});
