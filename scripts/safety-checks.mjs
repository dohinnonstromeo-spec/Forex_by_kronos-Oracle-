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
import { readFile } from "node:fs/promises";

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
  console.log((cond ? "PASS" : "FAIL") + " - " + label + (extra ? " (" + extra + ")" : ""));
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

console.log("\n=== secure_half_priority_enabled: half-target formulas (Case A open-time, Case B trigger) ===");

// Copy of processAutoTradeForUser's Case A open-time formula.
function halfTpAtOpen(entry, tp1) { return entry + (tp1 - entry) * 0.5; }
// Copy of checkTrailingStops' Case B halfway-to-tp2 trigger formula.
function halfTargetFromTp2(buy, entry, tp2) { return buy ? entry + (tp2 - entry) * 0.5 : entry - (entry - tp2) * 0.5; }

check("Case A, BUY: half TP sits exactly midway between entry and the full 1.6R target", halfTpAtOpen(1.1000, 1.1160) === 1.1080);
check("Case A, SELL: half TP sits exactly midway (entry above tp1)", Math.round(halfTpAtOpen(1.1000, 1.0840) * 10000) / 10000 === 1.0920);
check("Case B, BUY: half-target trigger sits midway between entry and tp2 (2.5R reference)", halfTargetFromTp2(true, 4400, 4450) === 4425);
check("Case B, SELL: half-target trigger sits midway (tp2 below entry)", halfTargetFromTp2(false, 4400, 4350) === 4375);

console.log("=== distributed scheduler lease: autonomous execution stays single-flight across replicas ===");
const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
const ciSource = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const apiTestSource = await readFile(new URL("../scripts/api-tests.mjs", import.meta.url), "utf8");
check("durable auto-trade lease table exists", /CREATE TABLE IF NOT EXISTS auto_trade_leases/.test(serverSource));
check("lease acquisition uses an expiry condition", /async function tryAcquireLease[\s\S]{0,600}\$\{table\} SET[\s\S]{0,300}lease_until < \?/.test(serverSource));
check("auto-trade lease goes through the shared CAS lease helper", /tryAcquireAutoTradeLease[\s\S]{0,200}return tryAcquireLease\("auto_trade_leases"/.test(serverSource));
check("swing scheduler acquires a lease before processing a user", /tryAcquireAutoTradeLease\(account\.user_id, slot\)[\s\S]{0,300}processAutoTradeForUser/.test(serverSource));
check("scalp scheduler acquires a lease before processing a user", /tryAcquireAutoTradeLease\(account\.user_id, slot\)[\s\S]{0,300}processScalpForUser/.test(serverSource));
check("password reset claims the token atomically", /UPDATE password_reset_tokens SET used_at = \? WHERE id = \? AND used_at IS NULL/.test(serverSource));
check("daily order usage is durable", /CREATE TABLE IF NOT EXISTS trade_daily_usage/.test(serverSource));
check("daily order cap increments conditionally in SQL", /trade_daily_usage[\s\S]{0,1200}confirmed_count < \?/.test(serverSource));
check("maintenance scheduler lease table exists", /CREATE TABLE IF NOT EXISTS scheduler_leases/.test(serverSource));
check("broker reconciliation uses a durable lease", /tryAcquireSchedulerLease\("broker-reconcile"\)/.test(serverSource));
check("scalp timeout uses a durable lease", /tryAcquireSchedulerLease\("scalp-timeouts"\)/.test(serverSource));
check("trailing stop uses a durable lease", /tryAcquireSchedulerLease\("trailing-stops"\)/.test(serverSource));
check("learning outcomes uses a durable lease", /tryAcquireSchedulerLease\("learning-outcomes"\)/.test(serverSource));
check("position modification lease table exists", /CREATE TABLE IF NOT EXISTS trade_operation_leases/.test(serverSource));
check("secure-half acquires a durable position lease", /tryAcquireTradeOperationLease\(order\.id, "position-modify"\)/.test(serverSource));
check("trailing acquires a durable position lease per order", /tryAcquireTradeOperationLease\(row\.order_id, "position-modify"\)/.test(serverSource));
check("position modification leases are always released", /releaseTradeOperationLease\(row\.order_id, "position-modify", positionLeaseToken\)/.test(serverSource) && /releaseTradeOperationLease\(order\.id, "position-modify", leaseToken\)/.test(serverSource));
check("scalp timeout shares the position mutex with trailing", /closeBrokerPosition\(credentials, latestRow\.broker_order_id\)/.test(serverSource) && /tryAcquireTradeOperationLease\(row\.order_id, "position-modify"\)/.test(serverSource));
check("scalp close network failures are marked uncertain", /async function closeBrokerPosition[\s\S]{0,1800}broker_request_uncertain/.test(serverSource));
check("secure-half and trailing share one mutex namespace", serverSource.includes('"position-modify"'));
check("trailing rereads the order after locking", /const latestOrderRow = await sqlGet/.test(serverSource) && /Object\.assign\(row, latestOrderRow\)/.test(serverSource));
check("secure-half refuses a position already secured", /Number\(latestRow\.half_target_secured\) === 1/.test(serverSource));
console.log("=== broker delivery uncertainty: never retry an ambiguous order ===");
check("broker timeouts are marked uncertain", /broker_request_uncertain/.test(serverSource) && /uncertain: true/.test(serverSource));
check("simulation flags are disabled in production", serverSource.includes("MOCK_BROKER_ENABLED") && serverSource.includes("MOCK_MARKET_DATA") && serverSource.includes('NODE_ENV !== "production"'));
check("file locks release resolved keys", serverSource.includes("const settled = run.then") && serverSource.includes("fileLocks.delete(key)"));
check("auto-trade status map is bounded and pruned", serverSource.includes("AUTO_TRADE_STATUS_TTL_MS") && serverSource.includes("MAX_AUTO_TRADE_STATUS_ENTRIES") && serverSource.includes("pruneAutoTradeTickStatus"));
check("deployment intervals and body size are bounded", serverSource.includes("function boundedEnvNumber") && serverSource.includes("MAX_BODY_BYTES = Math.trunc(boundedEnvNumber") && serverSource.includes("AUTO_TRADE_INTERVAL_MS = boundedEnvNumber"));
check("Supabase table identifier is constrained", serverSource.includes("requestedSupabaseStateTable") && serverSource.includes("/^[A-Za-z_][A-Za-z0-9_]{0,62}$/"));
check("request body reads have a bounded timeout", serverSource.includes("BODY_READ_TIMEOUT_MS") && serverSource.includes("req.destroy(bodyReadTimeoutError())") && serverSource.includes("clearTimeout(timeout)"));
check("free and trade quotas are bounded", serverSource.includes("FREE_DAILY_ANALYSES_LIMIT = Math.trunc(boundedEnvNumber") && serverSource.includes("VISITOR_DAILY_DETECTIONS_LIMIT = Math.trunc(boundedEnvNumber") && serverSource.includes("Math.min(10_000, Math.max(1, Math.trunc(cap)))"));
check("browser isolation headers are present", serverSource.includes("X-DNS-Prefetch-Control") && serverSource.includes("Cross-Origin-Resource-Policy"));
check("lease and recovery intervals are bounded", serverSource.includes("AUTO_TRADE_LEASE_MS = boundedEnvNumber") && serverSource.includes("SCHEDULER_LEASE_MS = boundedEnvNumber") && serverSource.includes("TRADE_OPERATION_LEASE_MS = boundedEnvNumber") && serverSource.includes("HEARTBEAT_STALE_MS = boundedEnvNumber") && serverSource.includes("SENDING_RECOVERY_INTERVAL_MS = boundedEnvNumber") && serverSource.includes("SENDING_RECOVERY_AFTER_MS = boundedEnvNumber"));
check("relational readiness waits for legacy migration", serverSource.indexOf("await migrateLegacyJsonIntoRelationalTables();") < serverSource.indexOf("relationalTablesReady = true;"));
check("chat prompts are bounded", serverSource.includes("sanitizeUserText(cleanLine") && serverSource.includes(".slice(0, 4000)"));
check("image payloads are bounded before decoding", serverSource.includes("MAX_IMAGE_DATA_URL_CHARS = 8 * 1024 * 1024") && serverSource.includes("image.length > MAX_IMAGE_DATA_URL_CHARS"));
check("SSE clients cannot create an unbounded backlog", serverSource.includes("if (!client.write(message)) client.destroy()") && serverSource.includes("client.writableEnded"));
check("recent log cache is bounded and pruned", serverSource.includes("MAX_RECENT_LOG_ENTRIES") && serverSource.includes("RECENT_LOG_TTL_MS") && serverSource.includes("pruneRecentLogs"));
check("provider health errors are bounded", serverSource.includes("String(error).slice(0, 240)") && serverSource.includes("lastError: ok ? null : safeError"));
check("production requires durable database storage", serverSource.includes("IS_PRODUCTION && !databaseUrl"));
check("readiness verifies relational storage", serverSource.includes('url.pathname === "/api/ready"') && serverSource.includes('await sqlGet("SELECT 1")') && serverSource.includes("storage_unavailable"));
check("HTTP server has explicit resource timeouts", serverSource.includes("httpServer.headersTimeout = 15_000") && serverSource.includes("httpServer.requestTimeout = 120_000") && serverSource.includes("httpServer.keepAliveTimeout = 65_000"));
check("shutdown closes SSE and database resources", serverSource.includes("async function gracefulShutdown") && serverSource.includes("client.destroy()") && serverSource.includes("pgPool.end()"));
check("CI probes readiness instead of liveness only", ciSource.includes("/api/ready"));
check("integration tests force a non-production environment", apiTestSource.includes('NODE_ENV: "test"'));
const robotsSource = await readFile(new URL("../robots.txt", import.meta.url), "utf8");
const sitemapSource = await readFile(new URL("../sitemap.xml", import.meta.url), "utf8");
const indexHtmlSource = await readFile(new URL("../index.html", import.meta.url), "utf8");
const legalHtmlSource = await readFile(new URL("../legal.html", import.meta.url), "utf8");
const privateHtmlSources = await Promise.all(["dashboard.html", "login.html", "signup.html", "forgot-password.html"].map((file) => readFile(new URL("../" + file, import.meta.url), "utf8")));
check("robots and sitemap are present", robotsSource.includes("Sitemap:") && sitemapSource.includes("<urlset"));
check("public legal page has canonical and social metadata", legalHtmlSource.includes('rel="canonical"') && legalHtmlSource.includes("og:title") && legalHtmlSource.includes("twitter:card"));
check("private auth surfaces are noindex", privateHtmlSources.every((source) => source.includes('name="robots" content="noindex, nofollow"')));
check("homepage has WebSite structured data", indexHtmlSource.includes('id="website-jsonld"') && indexHtmlSource.includes('"@type": "WebSite"'));
check("successful broker acknowledgements require an order id", /broker_ack_missing_order_id/.test(serverSource));
check("ambiguous broker responses transition to DELIVERY_UNKNOWN", serverSource.includes('broker.uncertain ? "DELIVERY_UNKNOWN"'));
check("stale SENDING orders have a recovery scheduler", /recoverStaleSendingOrders/.test(serverSource) && /status = 'DELIVERY_UNKNOWN'/.test(serverSource));
const recoveryStart = serverSource.indexOf("async function recoverStaleSendingOrders");
const recoveryEnd = serverSource.indexOf("function startSendingRecoveryScheduler");
const recoveryBlock = recoveryStart >= 0 && recoveryEnd > recoveryStart ? serverSource.slice(recoveryStart, recoveryEnd) : "";
check("recovery never resends a stale SENDING order", recoveryBlock.length > 0 && !recoveryBlock.includes("sendOrderToBroker"));
check("delivery-unknown orders stay active and cannot be prepared again", serverSource.includes("status IN ('PENDING_CONFIRMATION', 'SENDING', 'SENT', 'DELIVERY_UNKNOWN')"));
check("late broker responses cannot overwrite DELIVERY_UNKNOWN", serverSource.includes("WHERE id = ? AND status = 'SENDING'"));
check("prepare claims are retained for uncertain delivery", serverSource.includes("if (!broker.ok && !broker.uncertain)"));
check("static files stay confined and internal paths are denied", serverSource.includes("const publicDeniedPath") && serverSource.includes("decodedPathname = decodeURIComponent(pathname)") && serverSource.includes("const rootPath = resolve(root)"));
check("session deletion preserves Secure", serverSource.includes("clearSessionCookie(res, req = null)") && serverSource.includes("Max-Age=0\" + secure"));
check("news requests are normalized and bounded", serverSource.includes("normalizedSymbol = normalizePair") && serverSource.includes("const newsInFlight = new Map()") && serverSource.includes("memoryCache.news.size > 32"));
const authClientSource = await readFile(new URL("../assets/auth.js", import.meta.url), "utf8");
check("authenticated frontend requests have bounded timeouts", authClientSource.includes("function fetchWithTimeout(url, options = {})") && authClientSource.includes("AbortSignal.timeout(CLIENT_REQUEST_TIMEOUT_MS)") && !/await fetch\(/.test(authClientSource));
check("external alert and email calls have bounded timeouts", serverSource.includes("signal: AbortSignal.timeout(3500)") && serverSource.includes("signal: AbortSignal.timeout(10000)"));
check("production PostgreSQL TLS verifies certificates", serverSource.includes("allowInsecureDatabaseTls") && serverSource.includes("env.NODE_ENV !== \"production\"") && serverSource.includes("rejectUnauthorized: !allowInsecureDatabaseTls"));
const boundedFrontendSources = await Promise.all(["admin-content.js", "premium-admin.js", "admin-health.js", "site-content.js"].map((file) => readFile(new URL("../assets/" + file, import.meta.url), "utf8")));
check("admin and public frontend requests have bounded timeouts", boundedFrontendSources.every((source) => source.includes("AbortSignal.timeout")));
const pauseSettingsStart = serverSource.indexOf("const requestedCap = hasCapUpdate");
const pauseSettingsEnd = serverSource.indexOf("sendJson(res, 200, { ok: true, paused", pauseSettingsStart);
const pauseSettingsBlock = pauseSettingsStart >= 0 && pauseSettingsEnd > pauseSettingsStart ? serverSource.slice(pauseSettingsStart, pauseSettingsEnd) : "";
check("invalid admin cap is rejected before pause mutation", pauseSettingsBlock.indexOf("if (hasCapUpdate &&") >= 0 && pauseSettingsBlock.indexOf("if (hasCapUpdate &&") < pauseSettingsBlock.indexOf('setAppSetting("trading_paused"'));
check("partial user preferences preserve omitted fields", /const providedPreferences =/.test(serverSource) && /Object\.prototype\.hasOwnProperty\.call\(body, key\)/.test(serverSource) && serverSource.includes("providedPreferences.map(([column]) => column)"));
check("broker-backed reconciliation fails closed when state is unknown", /brokerUnavailable/.test(serverSource) && /brokerResult\?\.stillOpen \|\| brokerResult\?\.brokerUnavailable/.test(serverSource));
const frontendAuditSources = await Promise.all([
  readFile(new URL("../assets/analyse-page.js", import.meta.url), "utf8"),
  readFile(new URL("../assets/kronos-live.js", import.meta.url), "utf8"),
  readFile(new URL("../assets/oracle-tabs.js", import.meta.url), "utf8"),
  readFile(new URL("../assets/oracle-chatbot.js", import.meta.url), "utf8"),
]);
const frontendAnalyseSource = frontendAuditSources[0];
const frontendHomeSource = frontendAuditSources[1];
const frontendTabsSource = frontendAuditSources[2];
const frontendChatSource = frontendAuditSources[3];
const frontendHtmlSources = await Promise.all(
  ["index.html", "analyse.html", "dashboard.html", "legal.html", "404.html", "paiement.html", "admin-contenu.html", "admin-health.html", "premium-admin.html"].map((file) => readFile(new URL("../" + file, import.meta.url), "utf8")),
);
check("frontend analysis refresh is single-flight", frontendAnalyseSource.includes("let signalsRefreshInFlight = false") && frontendAnalyseSource.includes("if (signalsRefreshInFlight) return"));
check("homepage live refreshes are single-flight", frontendHomeSource.includes("let pricesRefreshInFlight = false") && frontendHomeSource.includes("let signalsRefreshInFlight = false") && frontendHomeSource.includes("let signalScoresRefreshInFlight = false"));
check("dashboard order refresh is single-flight", authClientSource.includes("let tradeOrdersRefreshInFlight = false") && authClientSource.includes("if (tradeOrdersRefreshInFlight) return"));
check("robot action buttons are re-enabled", authClientSource.includes("/api/auto-trade/request") && authClientSource.includes("/api/auto-trade/pause") && authClientSource.includes("/api/auto-trade/resume") && (authClientSource.match(/button\.disabled = false/g) || []).length >= 3);
check("tab keyboard and ARIA contract is present", frontendTabsSource.includes("aria-controls") && frontendTabsSource.includes("ArrowRight") && frontendTabsSource.includes("role"));
check("chat and analysis previews stay lazy", frontendChatSource.includes('loading="lazy"') && frontendAnalyseSource.includes('loading="lazy"'));
check("public and internal pages expose skip links", frontendHtmlSources.every((source) => source.includes('class="oracle-skip-link"') && source.includes('id="main-content"')));
check("forms declare an HTTP method", frontendHtmlSources.concat(privateHtmlSources).every((source) => !/<form\\b(?![^>]*\\bmethod=)[^>]*>/i.test(source)));
check("private pages keep noindex", privateHtmlSources.every((source) => source.includes('name="robots" content="noindex, nofollow"')));
const adminContentPageSource = await readFile(new URL('../admin-contenu.html', import.meta.url), 'utf8');
const adminHealthPageSource = await readFile(new URL('../admin-health.html', import.meta.url), 'utf8');
const adminPremiumSource = await readFile(new URL('../assets/premium-admin.js', import.meta.url), 'utf8');
const adminHealthSource = await readFile(new URL('../assets/admin-health.js', import.meta.url), 'utf8');
const adminContentSource = await readFile(new URL('../assets/admin-content.js', import.meta.url), 'utf8');
const adminStylesSource = await readFile(new URL('../assets/oracle-extras.css', import.meta.url), 'utf8');
check('admin member detail endpoint is protected', serverSource.includes('url.pathname.startsWith("/api/admin/members/")') && serverSource.includes('const admin = await requireAdmin(req)') && serverSource.includes('broker_last_check_status') && !serverSource.includes('broker_token:'));
check('admin member detail exposes pair performance', serverSource.includes('GROUP BY pair') && serverSource.includes('LIMIT 20') && adminPremiumSource.includes('data.byPair') && adminPremiumSource.includes('Performance par paire'));
check('admin member detail exposes a bounded activity timeline', adminPremiumSource.includes('const activity = [...analyses') && adminPremiumSource.includes('slice(0, 12)') && adminPremiumSource.includes('member-timeline'));
check('admin member detail UI keeps personal data escaped', adminContentPageSource.includes('data-member-drawer') && adminPremiumSource.includes('/api/admin/members/') && adminPremiumSource.includes('escapeHtml(user.email') && adminPremiumSource.includes('member-detail-table'));
check('admin member dossier URLs use internal ids', adminPremiumSource.includes('data-member-details="${escapeHtml(user.id)}"') && adminPremiumSource.includes('const userId = button.dataset.memberDetails') && adminPremiumSource.includes('encodeURIComponent(userId)'));
check('admin member detail restores keyboard focus', adminContentPageSource.includes('tabindex="-1"') && adminPremiumSource.includes('event.key === "Escape"') && adminPremiumSource.includes('lastMemberTrigger.focus()'));
check('admin command center keeps existing contracts', adminContentPageSource.includes('data-premium-admin-form') && adminContentPageSource.includes('data-trading-pause') && adminContentPageSource.includes('data-autotrade-requests') && adminContentPageSource.includes('data-site-content-sections'));
check('admin command center exposes a protected overview state', adminContentPageSource.includes('data-admin-overview-refresh') && adminContentPageSource.includes('data-admin-overall-status') && adminContentPageSource.includes('data-admin-alerts') && adminPremiumSource.includes('/api/admin/members') && adminPremiumSource.includes('/api/admin/trading-status'));
check('admin overview remains single-flight and restores its button', adminPremiumSource.includes('if (adminOverviewRefresh) adminOverviewRefresh.disabled = true') && adminPremiumSource.includes('} finally {') && adminPremiumSource.includes('adminOverviewRefresh) adminOverviewRefresh.disabled = false'));
check('health console keeps refresh and output contracts', adminHealthPageSource.includes('id="refreshHealth"') && adminHealthPageSource.includes('id="healthOutput"') && adminHealthPageSource.includes('data-health-score') && adminHealthPageSource.includes('data-health-alerts'));
check('health console classifies provider states', adminHealthSource.includes('function stateFor(status)') && adminHealthSource.includes("['ok', 'up', 'healthy']") && adminHealthSource.includes('data-state="'));
check('health console bounds requests and escapes provider data', adminHealthSource.includes('AbortSignal.timeout(7000)') && adminHealthSource.includes('escapeHtml(item?.source') && adminHealthSource.includes('health.recommendations.map'));
check('content CMS always restores its load button', adminContentSource.includes('try {') && adminContentSource.includes('} finally {') && adminContentSource.includes('if (loadButton) loadButton.disabled = false'));
check('content CMS search remains client-side bounded', adminContentPageSource.includes('data-site-content-search') && adminContentSource.includes('filterContent()') && adminContentSource.includes('field.hidden = !matches') && adminStylesSource.includes('.admin-content-search'));
check('admin member directory filters locally', adminContentPageSource.includes('data-member-search') && adminContentPageSource.includes('data-member-plan-filter') && adminPremiumSource.includes('currentMemberItems()') && adminPremiumSource.includes('renderMemberDirectory'));
check('admin pages stay airy and responsive', adminContentPageSource.includes('admin-summary-grid') && adminHealthPageSource.includes('health-summary-grid') && adminStylesSource.includes('@media (max-width: 620px)') && adminStylesSource.includes('.health-detail-card--wide'));
console.log("=== requestOrigin: password-reset links never trust an attacker-controlled production Host ===");

// Copy of requestOrigin() from server.mjs, with the logger omitted because this
// standalone suite only checks the returned origin.
function requestOriginForTest(req, runtimeEnv = {}, runtimePort = 4174) {
  let configuredOrigin = String(runtimeEnv.PUBLIC_ORIGIN || runtimeEnv.APP_URL || "").trim();
  while (configuredOrigin.endsWith("/")) configuredOrigin = configuredOrigin.slice(0, -1);
  if (configuredOrigin) {
    try {
      const parsed = new URL(configuredOrigin);
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password) {
        return parsed.origin;
      }
    } catch {
      // Production fallback below remains safe when configuration is invalid.
    }
  }
  if (runtimeEnv.NODE_ENV === "production") return "https://forex-by-kronos-oracle.onrender.com";
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwardedProto === "https" || runtimeEnv.NODE_ENV === "production" ? "https" : "http";
  const candidateHost = String(req?.headers?.host || ("127.0.0.1:" + runtimePort));
  const host = candidateHost.includes("/") || candidateHost.includes(" ") ? ("127.0.0.1:" + runtimePort) : candidateHost;
  return protocol + "://" + host;
}

check(
  "production ignores an attacker-controlled Host header",
  requestOriginForTest({ headers: { host: "evil.example/reset" } }, { NODE_ENV: "production" }) === "https://forex-by-kronos-oracle.onrender.com",
);
check(
  "configured PUBLIC_ORIGIN wins over request headers",
  requestOriginForTest({ headers: { host: "evil.example" } }, { NODE_ENV: "production", PUBLIC_ORIGIN: "https://oracle.example/" }) === "https://oracle.example",
);
check(
  "invalid production PUBLIC_ORIGIN still falls back to the safe canonical origin",
  requestOriginForTest({ headers: { host: "evil.example" } }, { NODE_ENV: "production", PUBLIC_ORIGIN: "javascript:alert(1)" }) === "https://forex-by-kronos-oracle.onrender.com",
);
check(
  "development keeps a valid local Host for reset-link testing",
  requestOriginForTest({ headers: { host: "127.0.0.1:4174" } }, { NODE_ENV: "development" }) === "http://127.0.0.1:4174",
);

console.log(`
${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
