import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeLatestPriceActionScalp,
  createPriceActionSetupState,
  stepPriceActionScalp,
} from "../price-action-scalp-engine.mjs";

function makeRetest({ spreadPct = null, allowUnverifiedCosts = false } = {}) {
  const setupState = { direction: 1, level: 100, index: 31 };
  return stepPriceActionScalp({
    bar: { open: 100, high: 100.8, low: 99.9, close: 100.6 },
    previousBar: { open: 100.2, high: 100.3, low: 99.8, close: 100 },
    index: 32,
    averageRange: 1,
    support: 98,
    resistance: 102,
    setupState,
    tickSize: 0.01,
    spreadPct,
    allowUnverifiedCosts,
  });
}

test("Price Action research can show structure with spread unverified, but labels costs unknown", () => {
  const blockedByDefault = makeRetest();
  assert.equal(blockedByDefault.signal, null, "unknown costs must stay blocked by default");

  const researchOnly = makeRetest({ allowUnverifiedCosts: true });
  assert.equal(researchOnly.signal?.setup, "break_retest");
  assert.equal(researchOnly.signal?.costStatus, "spread_unverified");
  assert.equal(researchOnly.signal?.roundTripCost, null);
  assert.equal(researchOnly.signal?.costR, null);
  assert.equal(Number.isFinite(researchOnly.signal?.slippageCost), true);
  assert.equal(researchOnly.finalDirection, 1);
});

test("Price Action candidates with confirmed spread still pass the round-trip cost filter", () => {
  const confirmedSpread = makeRetest({ spreadPct: 0.005 });
  assert.equal(confirmedSpread.signal?.costStatus, "spread_confirmed");
  assert.equal(Number.isFinite(confirmedSpread.signal?.costR), true);
  assert.ok(confirmedSpread.signal.costR <= 0.15);

  const excessiveSpread = makeRetest({ spreadPct: 1 });
  assert.equal(excessiveSpread.signal, null, "a spread above the cost ceiling must remain rejected");
});

test("latest-candle analysis preserves an OHLC candidate when only the Deriv spread is missing", () => {
  const bars = Array.from({ length: 40 }, (_, index) => ({
    open: 100.45,
    high: 100.6,
    low: 100.3,
    close: 100.5,
    datetime: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
  }));
  bars[bars.length - 1] = {
    ...bars[bars.length - 1],
    open: 100.5,
    high: 100.7,
    low: 100.22,
    close: 100.6,
  };

  const strict = analyzeLatestPriceActionScalp(bars, { tickSize: 0.01, spread: null });
  assert.equal(strict.candidates.length, 0, "normal analysis must not treat missing spread as zero");

  const research = analyzeLatestPriceActionScalp(bars, {
    tickSize: 0.01,
    spread: null,
    allowUnverifiedCosts: true,
  });
  assert.equal(research.status, "research_candidate");
  assert.equal(research.candidates.length, 1);
  assert.equal(research.candidates[0].costStatus, "spread_unverified");
  assert.equal(research.candidates[0].costR, null);
});

test("setup state factory remains neutral", () => {
  assert.deepEqual(createPriceActionSetupState(), { direction: 0, level: Number.NaN, index: -1 });
});
