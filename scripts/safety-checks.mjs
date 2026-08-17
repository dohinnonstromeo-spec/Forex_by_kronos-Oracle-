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

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail) process.exit(1);
