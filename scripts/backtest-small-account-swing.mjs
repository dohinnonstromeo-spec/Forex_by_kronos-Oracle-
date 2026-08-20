// Does the swing engine's edge survive when we restrict it to ONLY the
// signals whose natural stop-loss distance keeps the broker's minimum lot
// (0.01) within a sane % of a genuinely small account ($30-100) -- instead of
// forcing every signal through at the min-lot floor regardless of how much
// that floor overshoots the intended risk%? Requested directly after
// discussing the min-lot-floor problem: "on fera un autre type de backtest
// specialement pour ces petits comptes sans trop de risque de trade avec
// perte d'abord" -- select only the trades that were ALREADY going to be
// small-risk by nature, rather than accepting a wider worst-case ceiling on
// every trade.
//
// Same non-negotiables as every other backtest in this repo: standalone (no
// import of server.mjs), real market data (Yahoo Finance daily), the
// UNCHANGED production entry logic (evaluateSignalAt/BASELINE_PARAMS, copied
// verbatim from scripts/backtest.mjs, same as backtest-swing-trailing-stop.mjs
// already does) -- only which signals get TRADED is under test here, never
// the signal logic itself. Walk-forward 70/30, two independent non-overlapping
// periods (see splitPeriods below), same bar backtest-swing-trailing-stop.mjs
// already used to pick SWING_TRAILING_PARAMS_BY_PAIR.
//
// Run with: node scripts/backtest-small-account-swing.mjs [yahooRange]

const SYMBOLS = [
  // Only the 3 pairs SWING_TRAILING_PARAMS_BY_PAIR already validated for the
  // trailing stop -- no point asking "is this small-account-safe" for a pair
  // that isn't even shipping the exit mechanism being tested here.
  { pair: "EUR/USD", yahooSymbol: "EURUSD=X", spec: { tickSize: 0.00001, lossTickValue: 1 }, trailParams: { activationR: 0.2, trailR: 0.3, bufferR: 0.15 } },
  { pair: "USD/CHF", yahooSymbol: "USDCHF=X", spec: { tickSize: 0.00001, lossTickValue: 1.2502813132954915 }, trailParams: { activationR: 0.2, trailR: 0.3, bufferR: 0.15 } },
  { pair: "XAU/USD", yahooSymbol: "GC=F", spec: { tickSize: 0.01, lossTickValue: 1 }, trailParams: { activationR: 1, trailR: 0.5, bufferR: 0.15 } },
];
// spec values: real numbers fetched live from the connected MetaApi demo
// account moments before this script was written (GET .../symbols/{sym}/
// specification + current-price), not typical/guessed FX conventions.
const MIN_VOLUME = 0.01; // confirmed identical (0.01) on all three pairs live

const CAPITAL_LEVELS = [30, 50, 100];
const RISK_CEILING_PCTS = [10, 15, 20]; // % of capital, worst case, at min lot

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

// See scripts/backtest-swing-trailing-stop.mjs for the full story on this --
// Yahoo's free FX feed returns literal zero-OHLC bars on several holiday
// dates, which corrupts ATR/risk math for any signal generated near one.
function isValidBar(bar) {
  return Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low)
    && bar.close > 0 && bar.high > 0 && bar.low > 0;
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

// Identical to evaluateSignalAt in scripts/backtest.mjs / backtest-swing-
// trailing-stop.mjs -- the entry/sl/risk logic is NOT under test here.
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

function summarize(trades) {
  if (!trades.length) return { count: 0, winRate: null, avgR: null };
  const wins = trades.filter((t) => t.result === "win").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  return { count: trades.length, winRate: Math.round((wins / trades.length) * 1000) / 10, avgR: Math.round((totalR / trades.length) * 1000) / 1000 };
}

function generateSignals(bars, valuePerUnitPerLot) {
  const trainCutoff = Math.round(bars.length * TRAIN_RATIO);
  const signals = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const signal = evaluateSignalAt(bars, i, BASELINE_PARAMS);
    if (!signal) continue;
    const minVolumeRisk = MIN_VOLUME * signal.risk * valuePerUnitPerLot;
    signals.push({ index: i, signal, split: i < trainCutoff ? "train" : "test", minVolumeRisk });
  }
  return signals;
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[idx];
}

async function main() {
  const yahooRange = process.argv[2] || "10y";

  for (const symbolDef of SYMBOLS) {
    let bars;
    try {
      bars = await fetchYahooDaily(symbolDef.yahooSymbol, yahooRange);
    } catch (error) {
      console.log(`[${symbolDef.pair}] fetch echouee (${error.message}), ignore.`);
      continue;
    }
    if (bars.length < 400) { console.log(`[${symbolDef.pair}] pas assez de bougies, ignore.`); continue; }

    const valuePerUnitPerLot = symbolDef.spec.lossTickValue / symbolDef.spec.tickSize;
    const allSignals = generateSignals(bars, valuePerUnitPerLot);
    const sortedRisks = [...allSignals.map((s) => s.minVolumeRisk)].sort((a, b) => a - b);
    console.log(`\n=== ${symbolDef.pair} (${bars.length} bougies, ${allSignals.length} signaux, ${bars[0].date} -> ${bars.at(-1).date}) ===`);
    console.log(`  Risque au lot minimum (0.01) reel, distribution sur tous les signaux: p10=$${percentile(sortedRisks, 0.10)?.toFixed(2)} p50=$${percentile(sortedRisks, 0.50)?.toFixed(2)} p90=$${percentile(sortedRisks, 0.90)?.toFixed(2)}`);

    const mid = Math.floor(bars.length / 2);
    const periods = [
      { label: "periode ancienne", bars: bars.slice(0, mid) },
      { label: "periode recente", bars: bars.slice(mid) },
    ];

    for (const capital of CAPITAL_LEVELS) {
      for (const ceilingPct of RISK_CEILING_PCTS) {
        const maxRisk = capital * (ceilingPct / 100);
        // Per-period so the walk-forward split (and the two-independent-period
        // check) still applies within each capital/ceiling combo, not just once
        // globally -- a filter that only "works" on one period isn't validated.
        const periodResults = periods.map((p) => {
          const signals = generateSignals(p.bars, valuePerUnitPerLot).filter((s) => s.minVolumeRisk <= maxRisk);
          if (!signals.length) return { label: p.label, eligible: 0, baseline: null, trailing: null };
          const baselineTrades = signals.map((s) => ({ split: s.split, ...simulateFixedTp(p.bars, s.index, s.signal) }));
          const trailingTrades = signals.map((s) => ({ split: s.split, ...simulateTrailingStop(p.bars, s.index, s.signal, symbolDef.trailParams.activationR, symbolDef.trailParams.trailR, symbolDef.trailParams.bufferR) }));
          return {
            label: p.label,
            eligible: signals.length,
            baseline: { train: summarize(baselineTrades.filter((t) => t.split === "train")), test: summarize(baselineTrades.filter((t) => t.split === "test")) },
            trailing: { train: summarize(trailingTrades.filter((t) => t.split === "train")), test: summarize(trailingTrades.filter((t) => t.split === "test")) },
          };
        });
        const totalEligible = periodResults.reduce((sum, p) => sum + p.eligible, 0);
        const pctEligible = allSignals.length ? Math.round((totalEligible / allSignals.length) * 1000) / 10 : 0;
        console.log(`  --- capital $${capital}, plafond ${ceilingPct}% ($${maxRisk.toFixed(2)}/trade max) : ${totalEligible}/${allSignals.length} signaux eligibles (${pctEligible}%) ---`);
        for (const p of periodResults) {
          if (!p.eligible) { console.log(`    [${p.label}] 0 signal eligible.`); continue; }
          console.log(`    [${p.label}, ${p.eligible} signaux] baseline train avgR=${p.baseline.train.avgR ?? "-"} (n=${p.baseline.train.count}) test avgR=${p.baseline.test.avgR ?? "-"} (n=${p.baseline.test.count}) | suiveur train avgR=${p.trailing.train.avgR ?? "-"} test avgR=${p.trailing.test.avgR ?? "-"}`);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error("Erreur fatale:", error);
  process.exit(1);
});
