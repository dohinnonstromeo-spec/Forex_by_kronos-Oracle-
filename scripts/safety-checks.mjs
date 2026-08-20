// Regression suite for one specific, recurring bug class found and fixed on
// 2026-08-13: code that treats "this value is a finite number" as proof that market
// data is real/current, when a stale or hardcoded emergency fallback price is *also*
// a finite number. Three real instances shipped bad output because of this before
// being caught live: validateTradeLevels() silently skipped its live-price distance
// check when the price was missing (and, separately, when it was a stale fallback),
// assessAnalysisDataReliability() awarded reliability points for a fake price, and
// buildQualityGate() force-passed other checks (and relaxed its danger threshold) in
// quick mode based on the same false signal.
//
// Standalone on purpose, same reason as scripts/backtest.mjs: importing server.mjs
// starts a real HTTP server as a side effect. The functions below are copied from
// server.mjs, not imported -- if you change validateTradeLevels, pricePayload,
// assessAnalysisDataReliability, or buildQualityGate there, update the matching copy
// here too, then run `node scripts/safety-checks.mjs` to confirm nothing regressed.
//
// This is a targeted regression net for this one bug class, not a general test
// suite -- it doesn't replace live verification against the real running server.

function isScalpingStrategy(strategy = "") { return /scalp|m1|m5|m15/i.test(String(strategy)); }
function riskProfile(risk) { return { percent: /0\.5/.test(String(risk)) ? 0.5 : /^1(\D|$)/.test(String(risk)) ? 1 : 2, minScore: 55 }; }
function rewardRisk(direction, entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return risk > 0 ? reward / risk : NaN;
}
function executionCostBuffer() { return 0.35; }
function inspectSuspiciousLevels() { return { risky: false, reason: "", reasons: [] }; }
function levelTolerance(pair = "", strategy = "") {
  const scalp = isScalpingStrategy(strategy);
  if (/XAU/i.test(pair)) return scalp ? 0.006 : 0.018;
  return scalp ? 0.0015 : 0.0035;
}
function isLivePriceSource(source = "") {
  return ["twelve_data", "massive", "alpha_vantage", "coinbase", "stooq", "binance", "yahoo"].includes(source);
}

// Copy of pricePayload() from server.mjs.
function pricePayload(symbol, value, source, error, options = {}) {
  const open = options.open ?? true;
  const live = isLivePriceSource(source);
  const stale = options.stale ?? (!live || !open);
  const reliability = options.reliability ?? (live ? 85 : 20);
  return {
    ...value,
    source,
    error,
    open,
    stale,
    reliability,
    trustworthy: Boolean(open && !stale && live && reliability >= 70),
    // Preserve the incoming value's own asOf (a reused cached object) instead of
    // always stamping "now" -- see the matching comment in server.mjs for the bug
    // this closes (a cached price's freshness clock resetting on every reuse,
    // letting a fetched-once price freeze indefinitely under real traffic).
    asOf: value?.asOf || new Date().toISOString(),
  };
}

// Copy of isUsableLivePrice() from server.mjs.
function isUsableLivePrice(price) {
  if (typeof price?.trustworthy === "boolean") return price.trustworthy;
  return Boolean(price?.open && !price.stale && isLivePriceSource(price.source) && Number(price.reliability || 0) >= 70);
}

// Copy of validateTradeLevels() from server.mjs.
function validateTradeLevels({ direction, entry, sl, tp, live, liveUsable, pair, strategy, risk }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { valid: false, score: 0, reason: "Niveaux numériques invalides." };
  const buy = direction === "ACHAT";
  if (buy && !(sl < entry && tp > entry)) return { valid: false, score: 20, reason: "Pour un achat, SL doit être sous l'entrée et TP au-dessus." };
  if (!buy && !(sl > entry && tp < entry)) return { valid: false, score: 20, reason: "Pour une vente, SL doit être au-dessus de l'entrée et TP sous l'entrée." };
  const rr = rewardRisk(direction, entry, sl, tp);
  const profile = riskProfile(risk);
  const minRr = isScalpingStrategy(strategy) ? 0.75 : profile.percent <= 0.5 ? 1.0 : 1.2;
  if (!Number.isFinite(rr) || rr < minRr) return { valid: false, score: 35, reason: `R/R trop faible.` };
  const riskDistance = Math.abs(entry - sl);
  const executionBuffer = executionCostBuffer(pair, strategy);
  if (riskDistance < executionBuffer * 3) return { valid: false, score: 30, reason: `SL trop serré.` };
  const suspicious = inspectSuspiciousLevels({ direction, entry, sl, tp1: tp, rr, pair });
  if (suspicious.risky) return { valid: false, score: 28, reason: `Trade risqué: ${suspicious.reason}` };
  if (!Number.isFinite(live) || !liveUsable) {
    return { valid: false, score: 30, reason: "Prix live indisponible ou non fiable: niveaux non vérifiables contre le marché réel." };
  }
  const distance = Math.abs(entry - live) / Math.max(Math.abs(live), 1);
  const tolerance = levelTolerance(pair, strategy);
  // Kept in sync with server.mjs's validateTradeLevels -- the old two-tier
  // "strict vs soft" split let entries up to 2x tolerance away from live still
  // validate (reported live: gold entry ~4200 vs live 4300, 2.33% off, still
  // valid:true). Any distance beyond tolerance blocks now, no soft zone.
  if (distance > tolerance) {
    return { valid: false, score: 32, reason: `Entrée trop éloignée du prix live (${(distance * 100).toFixed(2)}%).` };
  }
  return { valid: true, score: Math.max(55, Math.min(100, Math.round(55 + rr * 12))), reason: "Niveaux cohérents avec direction, R/R et prix live." };
}

// Copy of assessAnalysisDataReliability()'s live-price scoring, from server.mjs.
function liveScoreContribution(livePrice) {
  return isUsableLivePrice(livePrice) ? 24 : 0;
}

// Copy of buildQualityGate()'s hasLivePrice + the checks it gates, from server.mjs.
function qualityGateLivePriceChecks({ meta, quickMode }) {
  const hasLivePrice = Boolean(meta.liveUsable);
  return {
    prixLive: hasLivePrice,
    historique: quickMode && hasLivePrice ? true : meta.technicalSnapshot?.valid !== false,
    dangerThreshold: quickMode && hasLivePrice ? 92 : 65,
  };
}

let pass = 0, fail = 0;
function check(label, cond, extra) {
  console.log(`${cond ? "PASS" : "FAIL"} - ${label}${extra ? ` (${extra})` : ""}`);
  if (cond) pass++; else fail++;
}

console.log("=== validateTradeLevels: live price availability/trustworthiness ===");

const realLive = { price: 4348.61, open: true, stale: false, source: "twelve_data", reliability: 95, trustworthy: true };
const missingLive = null;
const staleFallback = { price: 2350.0, open: true, stale: true, source: "static_fallback", reliability: 15, trustworthy: false };
const closedMarketLive = { price: 4348.61, open: false, stale: false, source: "twelve_data", reliability: 95, trustworthy: false };

function levelsFor(livePrice) {
  const live = Number(livePrice?.price);
  const liveUsable = isUsableLivePrice(livePrice);
  return { live, liveUsable };
}

check(
  "missing live price: far entry BLOCKED",
  validateTradeLevels({ direction: "VENTE", entry: 4167, sl: 4180, tp: 4130, ...levelsFor(missingLive), pair: "XAU/USD", strategy: "Scalping", risk: "0.5" }).valid === false,
);
check(
  "stale/untrustworthy fallback price: far entry BLOCKED regardless of distance math",
  validateTradeLevels({ direction: "VENTE", entry: 4167, sl: 4180, tp: 4130, ...levelsFor(staleFallback), pair: "XAU/USD", strategy: "Scalping", risk: "0.5" }).valid === false,
);
check(
  "market closed (trustworthy:false even with a real recent price): BLOCKED",
  validateTradeLevels({ direction: "VENTE", entry: 4348, sl: 4352, tp: 4340, ...levelsFor(closedMarketLive), pair: "XAU/USD", strategy: "Scalping", risk: "0.5" }).valid === false,
);
check(
  "real trustworthy live price, tight entry: VALID",
  validateTradeLevels({ direction: "VENTE", entry: 4348, sl: 4352, tp: 4340, ...levelsFor(realLive), pair: "XAU/USD", strategy: "Scalping", risk: "0.5" }).valid === true,
);
check(
  "real trustworthy live price, far entry (the original reported bug: 4348 live, 4167 entry): still BLOCKED",
  validateTradeLevels({ direction: "VENTE", entry: 4167, sl: 4180, tp: 4130, ...levelsFor(realLive), pair: "XAU/USD", strategy: "Scalping", risk: "0.5" }).valid === false,
);
// Second real bug, reported live 2026-08-15: gold entry ~4200 while live traded at
// 4300 (2.33% off, non-scalping) still came back valid:true -- inside the old
// "soft zone" between tolerance (1.8%) and tolerance*2 (3.6%), which returned
// valid:true with just a lower score instead of blocking. There is no width of
// "somewhat wrong" that should validate; distance beyond tolerance blocks, period.
check(
  "real trustworthy live price, entry inside the old soft zone (1x-2x tolerance): now BLOCKED",
  validateTradeLevels({ direction: "ACHAT", entry: 4260, sl: 4210, tp: 4420, ...levelsFor(realLive), pair: "XAU/USD", strategy: "Swing Trading", risk: "1" }).valid === false,
);

console.log("\n=== pricePayload: .trustworthy is computed correctly at the source ===");

const freshLive = pricePayload("XAU/USD", { price: 4348.61, change: 0.1 }, "twelve_data", null, { stale: false, reliability: 90, open: true });
check("fresh real provider price: trustworthy=true", freshLive.trustworthy === true);

const staleCache = pricePayload("XAU/USD", { price: 4340.0, change: 0 }, "cache:twelve_data", "using_last_good", { stale: true, reliability: 55, open: true });
check("stale cache fallback: trustworthy=false", staleCache.trustworthy === false);

const emergencyFallback = pricePayload("XAU/USD", { price: 2350.0, change: 0 }, "static_fallback", "all_providers_unavailable", { stale: true, reliability: 15, open: true });
check("hardcoded emergency fallback: trustworthy=false", emergencyFallback.trustworthy === false);

const marketClosed = pricePayload("XAU/USD", { price: 4348.61, change: 0 }, "twelve_data", null, { stale: false, reliability: 90, open: false });
check("real price but market closed: trustworthy=false", marketClosed.trustworthy === false);

// Third real bug, reported live 2026-08-17, the root cause behind repeated "entry way
// off the real market" reports across the whole session: asOf used to be
// unconditionally `new Date().toISOString()`, including when re-wrapping an already-
// cached value (fetchBestPrice's "fresh_cache" branch does exactly this to skip a
// real provider call). That reset the freshness clock on every reuse, so
// isRecentCache() never saw the cache age past its TTL under regular traffic -- a
// price fetched once could freeze indefinitely while every response still claimed
// stale:false/trustworthy:true, because those flags were computed from the same wrong
// "now" timestamp, not from how old the underlying value actually was.
const genuinelyFresh = pricePayload("XAU/USD", { price: 4157.28, change: 1.2 }, "twelve_data", null, { reliability: 95 });
const reusedFromCache = pricePayload("XAU/USD", genuinelyFresh, "twelve_data", "fresh_cache", { stale: false, reliability: 90 });
check("cache-reuse preserves the original fetch time instead of resetting it", reusedFromCache.asOf === genuinelyFresh.asOf);
check("a genuinely fresh fetch still gets its own real timestamp", Boolean(genuinelyFresh.asOf));

console.log("\n=== mergeCachedHistories: same asOf bug, found auditing for it elsewhere, in candle history caching ===");

// Copy of tagHistory() from server.mjs.
function tagHistory(bars, source, stale, asOf) {
  Object.defineProperty(bars, "_meta", { value: { source, stale, asOf: asOf || new Date().toISOString() }, enumerable: false });
  return bars;
}
// Copy of mergeCachedHistories() from server.mjs.
function mergeCachedHistories(existing, histories) {
  const next = { ...existing };
  for (const [symbol, bars] of Object.entries(histories)) {
    if (Array.isArray(bars) && bars.length >= 30 && !bars._meta?.stale) {
      next[symbol] = { source: bars._meta?.source || "twelve_data", asOf: bars._meta?.asOf || new Date().toISOString(), bars: bars.slice(-80) };
    }
  }
  return next;
}
const someBars = Array.from({ length: 30 }, (_, i) => ({ close: 4157 + i, high: 4158 + i, low: 4156 + i, datetime: `2026-08-17T0${i}:00:00Z` }));
const freshBars = tagHistory([...someBars], "twelve_data:15min", false);
const freshMerged = mergeCachedHistories({}, { "XAU/USD": freshBars });
// A cache read re-tags the same underlying bars, carrying the ORIGINAL cache asOf
// forward (this is what cachedHistory() does, passing cached.asOf as tagHistory's
// 4th arg) -- merging that back must not stamp a newer timestamp either.
const reReadFromCache = tagHistory([...someBars], "cache:twelve_data:15min", false, freshMerged["XAU/USD"].asOf);
const reReadMerged = mergeCachedHistories(freshMerged, { "XAU/USD": reReadFromCache });
check("re-merging a cache-read history preserves the original fetch time", reReadMerged["XAU/USD"].asOf === freshMerged["XAU/USD"].asOf);

console.log("\n=== assessAnalysisDataReliability: no partial credit for a fake-but-finite price ===");

check("fake/stale price contributes 0 (not partial credit)", liveScoreContribution(staleFallback) === 0);
check("real trustworthy price contributes full 24", liveScoreContribution(realLive) === 24);

console.log("\n=== buildQualityGate: quick-mode leniency requires a genuinely trustworthy price ===");

const gateWithFakeLive = qualityGateLivePriceChecks({ meta: { liveUsable: false, technicalSnapshot: { valid: false } }, quickMode: true });
check("fake price in quick mode: 'Prix live' check fails", gateWithFakeLive.prixLive === false);
check("fake price in quick mode: 'Historique' NOT force-passed", gateWithFakeLive.historique === false);
check("fake price in quick mode: danger threshold stays strict (65), not relaxed to 92", gateWithFakeLive.dangerThreshold === 65);

const gateWithRealLive = qualityGateLivePriceChecks({ meta: { liveUsable: true, technicalSnapshot: { valid: false } }, quickMode: true });
check("real price in quick mode: 'Prix live' check passes", gateWithRealLive.prixLive === true);
check("real price in quick mode: 'Historique' correctly relaxed (by design, quick mode)", gateWithRealLive.historique === true);

console.log("\n=== evaluateOutcomeFromHistory: point-sampling misses a touch-and-revert, candle history doesn't ===");

// Copy of evaluateOutcomeFromHistory() from server.mjs.
function evaluateOutcomeFromHistory(analysis, bars) {
  if (!Array.isArray(bars) || !bars.length) return null;
  if (![analysis.entry, analysis.sl, analysis.tp1].every(Number.isFinite)) return null;
  const buy = analysis.direction === "ACHAT";
  const risk = Math.abs(analysis.entry - analysis.sl);
  const rMultipleAt = (level) => (risk > 0 ? Math.round((Math.abs(level - analysis.entry) / risk) * 1000) / 1000 : null);
  const createdAtMs = new Date(analysis.createdAt).getTime();
  if (!Number.isFinite(createdAtMs)) return null;
  const relevant = bars
    .filter((bar) => Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(new Date(bar.datetime).getTime()) && new Date(bar.datetime).getTime() >= createdAtMs)
    .sort((a, b) => new Date(a.datetime).getTime() - new Date(b.datetime).getTime());
  for (const bar of relevant) {
    const hitSl = buy ? bar.low <= analysis.sl : bar.high >= analysis.sl;
    const hitTp2 = Number.isFinite(analysis.tp2) && (buy ? bar.high >= analysis.tp2 : bar.low <= analysis.tp2);
    const hitTp1 = buy ? bar.high >= analysis.tp1 : bar.low <= analysis.tp1;
    if (hitSl) return { status: "SL_HIT", result: "loss", price: analysis.sl, rMultiple: -1, reason: "Stop Loss touché (détecté sur l'historique des bougies)." };
    if (hitTp2) return { status: "TP2_HIT", result: "win", price: analysis.tp2, rMultiple: rMultipleAt(analysis.tp2), reason: "TP2 touché (détecté sur l'historique des bougies)." };
    if (hitTp1) return { status: "TP1_HIT", result: "win", price: analysis.tp1, rMultiple: rMultipleAt(analysis.tp1), reason: "TP1 touché (détecté sur l'historique des bougies)." };
  }
  return null;
}

// Real production report, 2026-08-18: a scalp analysis's TP/SL sat only ~$2 from
// entry on XAU/USD -- easily crossed and reverted within one candle, invisible to a
// checker that only ever looks at "price right now" every 90s.
const scalpAnalysis = { direction: "ACHAT", entry: 4420.79, sl: 4418.80, tp1: 4422.48, tp2: 4423.48, createdAt: "2026-08-17T23:55:00.000Z" };

const tp1SpikeAndRevert = [
  { datetime: "2026-08-17T23:56:00.000Z", high: 4421.0, low: 4420.5 },
  { datetime: "2026-08-17T23:57:00.000Z", high: 4423.0, low: 4421.8 }, // wicks through TP1 (4422.48)
  { datetime: "2026-08-17T23:58:00.000Z", high: 4421.2, low: 4420.9 }, // back below TP1 by the next bar
];
check(
  "TP1 spiked through and reverted -- current-price-only would show 'not hit', history correctly shows TP1_HIT",
  evaluateOutcomeFromHistory(scalpAnalysis, tp1SpikeAndRevert)?.status === "TP1_HIT",
);

const slSpikeAndRevert = [
  { datetime: "2026-08-17T23:56:00.000Z", high: 4420.9, low: 4420.3 },
  { datetime: "2026-08-17T23:57:00.000Z", high: 4420.5, low: 4418.5 }, // wicks through SL (4418.80)
  { datetime: "2026-08-17T23:58:00.000Z", high: 4421.0, low: 4420.6 }, // recovered above SL by the next bar
];
check(
  "SL spiked through and reverted -- history correctly shows SL_HIT",
  evaluateOutcomeFromHistory(scalpAnalysis, slSpikeAndRevert)?.status === "SL_HIT",
);

const bothInSameBar = [
  { datetime: "2026-08-17T23:56:00.000Z", high: 4423.0, low: 4418.5 }, // one wide bar spans both SL and TP1
];
check(
  "SL and TP1 both inside the same bar's range -- SL wins (conservative ordering, matches scripts/backtest.mjs)",
  evaluateOutcomeFromHistory(scalpAnalysis, bothInSameBar)?.status === "SL_HIT",
);

const noTouch = [
  { datetime: "2026-08-17T23:56:00.000Z", high: 4421.0, low: 4420.5 },
  { datetime: "2026-08-17T23:57:00.000Z", high: 4421.3, low: 4420.7 },
];
check("neither level touched -- returns null so the point-price/24h-expiry fallback still applies", evaluateOutcomeFromHistory(scalpAnalysis, noTouch) === null);

const barsBeforeCreation = [
  { datetime: "2026-08-17T20:00:00.000Z", high: 4423.0, low: 4418.5 }, // would hit both, but it's before createdAt
];
check("bars from before the analysis existed are ignored, not treated as a touch", evaluateOutcomeFromHistory(scalpAnalysis, barsBeforeCreation) === null);

console.log("\n=== computeAutoTradeVolume: autonomous bot position sizing never risks more than approved ===");

// Copy of computeAutoTradeVolume() from server.mjs.
function computeAutoTradeVolume({ balance, riskPercent, entry, sl, specification, allowMinVolumeFloor = false, maxRiskAmount = null }) {
  const slDistance = Math.abs(Number(entry) - Number(sl));
  if (!(slDistance > 0) || !(balance > 0) || !(Number(riskPercent) > 0)) return null;
  const valuePerUnitPerLot = specification.lossTickValue / specification.tickSize;
  if (!(valuePerUnitPerLot > 0)) return null;
  const riskAmount = balance * (Number(riskPercent) / 100);
  const rawVolume = riskAmount / (slDistance * valuePerUnitPerLot);
  const steppedVolume = Math.floor(rawVolume / specification.volumeStep) * specification.volumeStep;
  const volume = Math.min(steppedVolume, specification.maxVolume);
  if (volume >= specification.minVolume) return Math.round(volume * 100) / 100;
  if (allowMinVolumeFloor && maxRiskAmount > 0) {
    const minVolumeRisk = specification.minVolume * slDistance * valuePerUnitPerLot;
    if (minVolumeRisk <= maxRiskAmount) return specification.minVolume;
  }
  return null;
}

// Real numbers confirmed live this session against the connected MetaApi demo
// account: XAU/USD tickSize 0.01, lossTickValue ~1 (USD account), balance
// $43,230.85, 0.1% risk, $15 SL distance -> volume 0.02 lots, confirmed against a
// real order actually sent and filled.
const xauSpec = { tickSize: 0.01, lossTickValue: 1, minVolume: 0.01, maxVolume: 10, volumeStep: 0.01 };
check(
  "real XAU/USD numbers from this session reproduce the exact volume a real order used (0.02 lots)",
  computeAutoTradeVolume({ balance: 43230.85, riskPercent: 0.1, entry: 4400.13601, sl: 4385.13601, specification: xauSpec }) === 0.02,
);

// Confirmed live: GBP/JPY's lossTickValue (~0.627 for a USD account) differs
// meaningfully from a same-magnitude EUR/USD tick value (1.0) -- proving the
// formula must use the pair-specific, already-FX-converted lossTickValue and never
// a shared/guessed constant across pairs.
const gbpjpySpec = { tickSize: 0.001, lossTickValue: 0.627, minVolume: 0.01, maxVolume: 20, volumeStep: 0.01 };
const gbpjpyVolume = computeAutoTradeVolume({ balance: 43230.85, riskPercent: 0.1, entry: 216.051, sl: 215.051, specification: gbpjpySpec });
check("a different pair's distinct tick value produces a materially different volume, not a copy-pasted constant", gbpjpyVolume !== 0.02 && gbpjpyVolume > 0);

check(
  "never rounds UP to the broker's minimum volume -- a setup too small to size safely is skipped, not risked anyway",
  computeAutoTradeVolume({ balance: 100, riskPercent: 0.1, entry: 4400, sl: 3000, specification: xauSpec }) === null,
);

check(
  "volume is capped at the broker's maxVolume, never sized past it",
  computeAutoTradeVolume({ balance: 50_000_000, riskPercent: 3, entry: 4400, sl: 4399, specification: xauSpec }) === xauSpec.maxVolume,
);

check("no balance -- fails closed instead of guessing a size", computeAutoTradeVolume({ balance: 0, riskPercent: 0.5, entry: 4400, sl: 4385, specification: xauSpec }) === null);
check("zero SL distance (entry === sl, malformed signal) -- fails closed, would otherwise divide by zero", computeAutoTradeVolume({ balance: 43230, riskPercent: 0.5, entry: 4400, sl: 4400, specification: xauSpec }) === null);

// Small-account min-lot floor (allowMinVolumeFloor/maxRiskAmount) -- real
// EUR/USD spec fetched live from the connected MetaApi demo account
// (tickSize 0.00001, lossTickValue 1) while building
// scripts/backtest-small-account-swing.mjs. $50 capital, 1% risk, 70-pip stop
// -> target risk $0.50, far below the broker's real $7 min-lot floor.
const eurusdSpec = { tickSize: 0.00001, lossTickValue: 1, minVolume: 0.01, maxVolume: 20, volumeStep: 0.01 };
check(
  "small-account floor OFF by default -- a target too small to reach min lot is still skipped, not risked anyway",
  computeAutoTradeVolume({ balance: 50, riskPercent: 1, entry: 1.1000, sl: 1.0930, specification: eurusdSpec }) === null,
);
check(
  "small-account floor ON, min-lot's real risk ($7) fits under the ceiling ($7.50 = 15% of $50) -- floors to minVolume",
  computeAutoTradeVolume({ balance: 50, riskPercent: 1, entry: 1.1000, sl: 1.0930, specification: eurusdSpec, allowMinVolumeFloor: true, maxRiskAmount: 7.5 }) === 0.01,
);
check(
  "small-account floor ON but min-lot's real risk ($7) exceeds a tighter ceiling ($5) -- still skipped, never forced past the ceiling",
  computeAutoTradeVolume({ balance: 50, riskPercent: 1, entry: 1.1000, sl: 1.0930, specification: eurusdSpec, allowMinVolumeFloor: true, maxRiskAmount: 5 }) === null,
);
check(
  "small-account floor ON but the target already sizes above min lot on its own -- returns the normally-computed volume, not forced down to minVolume",
  computeAutoTradeVolume({ balance: 43230.85, riskPercent: 0.1, entry: 4400.13601, sl: 4385.13601, specification: xauSpec, allowMinVolumeFloor: true, maxRiskAmount: 1000000 }) === 0.02,
);

console.log("\n=== confirmAndSendOrder's sideValid: a BUY order with no broker-side TP (tp1=null) must not be spuriously rejected ===");

// Copy of the sideValid logic from confirmAndSendOrder() in server.mjs. Found live
// during an engine audit: order.tp1 is deliberately NULL for scalp and the
// trailing-stop swing pairs (XAU/USD, USD/CHF, EUR/USD -- see processScalpForUser /
// processAutoTradeForUser). The old check was `currentPrice < order.tp1` for a BUY
// unconditionally -- JS coerces null to 0 in a relational comparison, so that
// silently became `currentPrice < 0`, always false for a real price, rejecting
// EVERY such BUY order with a misleading "levels_crossed_by_price" error. SELL
// orders happened to pass by the same coincidence (`price > null` -> `price > 0`),
// which is why this went unnoticed through this session's live scalp/trailing-stop
// testing (that testing used seeded positions and/or SELL-direction trades).
function sideValid({ buyOrder, tp1, sl, currentPrice }) {
  const hasBrokerTp = Number.isFinite(tp1);
  return buyOrder
    ? (!hasBrokerTp || currentPrice < tp1) && currentPrice > sl
    : (!hasBrokerTp || currentPrice > tp1) && currentPrice < sl;
}

check(
  "a BUY order with tp1=null (scalp/trailing-stop pairs) now correctly passes based on sl alone",
  sideValid({ buyOrder: true, tp1: null, sl: 4380, currentPrice: 4400 }) === true,
);
check(
  "a BUY order with tp1=null is still correctly rejected once price has already crossed its sl",
  sideValid({ buyOrder: true, tp1: null, sl: 4400, currentPrice: 4380 }) === false,
);
check(
  "a SELL order with tp1=null is unaffected by the fix -- still passes based on sl alone",
  sideValid({ buyOrder: false, tp1: null, sl: 4420, currentPrice: 4400 }) === true,
);
check(
  "a normal BUY order WITH a real tp1 is unaffected by the fix -- still rejects once price is past tp1",
  sideValid({ buyOrder: true, tp1: 4390, sl: 4380, currentPrice: 4400 }) === false,
);
check(
  "a normal BUY order WITH a real tp1 still passes when price sits between sl and tp1",
  sideValid({ buyOrder: true, tp1: 4410, sl: 4380, currentPrice: 4400 }) === true,
);

console.log("\n=== processAutoTradeForUser's R:R filter: signal.rr is always a \"1:X\" string, never a bare number ===");

// Copy of parseRr() from server.mjs.
function parseRr(value) {
  const match = String(value ?? "").replace(",", ".").match(/([0-9]+(?:\.[0-9]+)?)/g);
  if (!match?.length) return NaN;
  return Number(match.at(-1));
}

check(
  "real bug found live: Number(\"1:2.0\") is NaN, never >= a real minRiskReward -- used to silently empty out every account's candidates the moment any min R:R was set",
  !(Number("1:2.0") >= 1.5),
);
check("parseRr correctly extracts 2.0 from computeDeterministicSignal's real rr format", parseRr("1:2.0") === 2.0);
check("parseRr correctly extracts 1.4 from cautiousSignal's rr format", parseRr("1:1.4") === 1.4);
check("with the fix, a signal genuinely meeting a 1.5 min R:R now correctly passes", parseRr("1:2.0") >= 1.5);
check("with the fix, a signal genuinely below a 1.5 min R:R is still correctly rejected", !(parseRr("1:1.4") >= 1.5));

console.log("\n=== checkSchedulerHeartbeat: alert once a scheduler goes silent, without spamming while it stays silent ===");

// Copy of the staleness/cooldown decision from checkSchedulerHeartbeat() in
// server.mjs, as a pure function of (now, lastAttemptAt, lastAlertAt) so it's
// testable without real setInterval timing.
function shouldAlertHeartbeat(now, lastAttemptAt, lastAlertAt, staleMs = 10 * 60 * 1000, cooldownMs = 60 * 60 * 1000) {
  if (!lastAttemptAt) return false;
  if (now - lastAttemptAt < staleMs) return false;
  if (now - lastAlertAt < cooldownMs) return false;
  return true;
}

const T0 = 1_800_000_000_000; // arbitrary fixed reference instant
check("never alerts before the scheduler has ticked even once (server just started)", shouldAlertHeartbeat(T0, null, 0) === false);
check("does not alert while the scheduler is still ticking normally (last attempt 1 min ago)", shouldAlertHeartbeat(T0, T0 - 60_000, 0) === false);
check("alerts once the scheduler has been silent past the stale threshold (11 min, threshold 10)", shouldAlertHeartbeat(T0, T0 - 11 * 60_000, 0) === true);
check("does NOT re-alert immediately after already alerting (still silent, but within the cooldown)", shouldAlertHeartbeat(T0, T0 - 11 * 60_000, T0 - 5 * 60_000) === false);
check("DOES alert again once the cooldown has passed and it's still silent (a real ongoing outage keeps getting reported)", shouldAlertHeartbeat(T0, T0 - 11 * 60_000, T0 - 61 * 60_000) === true);

console.log("\n=== startOfWeekUtc/startOfMonthUtc: weekly/monthly loss-cap window boundaries ===");

// Copy of both from server.mjs.
function startOfWeekUtc(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - (day === 0 ? 6 : day - 1));
  return d;
}
function startOfMonthUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

check("a Wednesday resolves to that same week's Monday", startOfWeekUtc(new Date("2026-08-19T15:00:00Z")).toISOString() === "2026-08-17T00:00:00.000Z");
check("a Monday itself resolves to itself (00:00), not the previous week", startOfWeekUtc(new Date("2026-08-17T23:59:00Z")).toISOString() === "2026-08-17T00:00:00.000Z");
check("a Sunday resolves to the Monday that started ITS week (6 days back), not the upcoming one", startOfWeekUtc(new Date("2026-08-23T05:00:00Z")).toISOString() === "2026-08-17T00:00:00.000Z");
check("mid-month resolves to the 1st of that month", startOfMonthUtc(new Date("2026-08-19T15:00:00Z")).toISOString() === "2026-08-01T00:00:00.000Z");
check("the 1st itself resolves to itself", startOfMonthUtc(new Date("2026-08-01T00:00:01Z")).toISOString() === "2026-08-01T00:00:00.000Z");
check("crosses a real year boundary correctly (Jan 2027)", startOfMonthUtc(new Date("2027-01-15T00:00:00Z")).toISOString() === "2027-01-01T00:00:00.000Z");

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
