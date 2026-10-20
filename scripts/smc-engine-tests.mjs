import assert from "node:assert/strict";
import test from "node:test";
import { analyzeKronosSmc, inspectClosedOhlcHistory } from "../smc-engine.mjs";

const NOW = Date.parse("2026-06-10T12:00:00.000Z");
const MINUTE = 60_000;

function makeBars(timeframe, count, { now = NOW, slope = 0.02 } = {}) {
  const interval = ({ M1: 1, M5: 5, M15: 15, H1: 60 })[timeframe] * MINUTE;
  const first = now - count * interval;
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * slope;
    const close = open + 0.01;
    return {
      time: first + index * interval,
      open,
      high: close + 0.02,
      low: open - 0.02,
      close,
    };
  });
}

function analyze({ setupBars = makeBars("M5", 100), contextBars = makeBars("M15", 80), ...options } = {}) {
  return analyzeKronosSmc({
    pair: "XAU/USD",
    setupBars,
    contextBars,
    setupTimeframe: "M5",
    contextTimeframe: "M15",
    setupSource: "deriv_ws:5min",
    contextSource: "deriv_ws:15min",
    strategy: "Scalping",
    now: NOW,
    ...options,
  });
}

test("SMC returns an observation only, never an executable trade", () => {
  const result = analyze();
  assert.equal(result.mode, "observation_recherche");
  assert.equal(result.tradeEligible, false);
  assert.equal(result.candidateLevels, null);
  assert.equal("researchSignals" in result, false);
});

test("rejects insufficient M5/M15 history", () => {
  const result = analyze({ setupBars: makeBars("M5", 44), contextBars: makeBars("M15", 54) });
  assert.equal(result.statusKey, "historique_insuffisant");
  assert.equal(result.tradeEligible, false);
});

test("rejects invalid OHLC candles rather than silently using them", () => {
  const setupBars = makeBars("M5", 100);
  setupBars[30] = { ...setupBars[30], high: setupBars[30].close - 0.01 };
  const result = analyze({ setupBars });
  assert.equal(result.statusKey, "donnees_incoherentes");
  assert.equal(result.inputs.setupInvalidBars, 1);
  assert.equal(result.tradeEligible, false);
});

test("rejects missing timestamps needed for multi-timeframe alignment", () => {
  const setupBars = makeBars("M5", 100);
  delete setupBars[30].time;
  const result = analyze({ setupBars });
  assert.equal(result.statusKey, "horodatage_absent");
  assert.equal(result.tradeEligible, false);
});

test("rejects conflicting candles at the same timestamp", () => {
  const setupBars = makeBars("M5", 100);
  setupBars.push({ ...setupBars[50], close: setupBars[50].close + 0.005 });
  const result = analyze({ setupBars });
  assert.equal(result.statusKey, "donnees_incoherentes");
  assert.equal(result.inputs.setupConflictingDuplicates, 1);
});

test("deduplicates identical timestamps and reports their count", () => {
  const setupBars = makeBars("M5", 100);
  setupBars.push({ ...setupBars[50] });
  const result = analyze({ setupBars });
  assert.equal(result.inputs.setupBars, 100);
  assert.equal(result.inputs.setupDuplicateBars, 1);
  assert.notEqual(result.statusKey, "donnees_incoherentes");
});

test("shared OHLC inspection reports malformed candles, duplicates, gaps, and the latest continuous run", () => {
  const bars = makeBars("M5", 10);
  bars[1] = { ...bars[1], high: bars[1].close - 0.01 };
  bars.splice(8, 1);
  bars.push({ ...bars[3] });
  const result = inspectClosedOhlcHistory(bars, "M5", NOW);
  assert.equal(result.invalidBars, 1);
  assert.equal(result.duplicateBars, 1);
  assert.equal(result.conflictingDuplicates, 0);
  assert.ok(result.gaps >= 2);
  assert.equal(result.trailingConsecutiveBars, 1);
  assert.equal(result.bars.length, 8);
});

test("blocks a setup when the newest M5 or M15 candles are discontinuous", () => {
  const setupBars = makeBars("M5", 100);
  setupBars.splice(98, 1);
  const result = analyze({ setupBars });
  assert.equal(result.statusKey, "historique_discontinu");
  assert.equal(result.inputs.setupTrailingConsecutiveBars, 1);
  assert.equal(result.tradeEligible, false);
});

test("excludes a still-open setup candle from the analysis", () => {
  const setupBars = makeBars("M5", 100);
  setupBars.push({ ...setupBars.at(-1), time: NOW });
  const result = analyze({ setupBars });
  assert.equal(result.inputs.setupBars, 100);
  assert.equal(result.inputs.setupPartialBarsExcluded, 1);
  assert.equal(Date.parse(result.lastClosedBarAt), NOW);
});

test("does not treat two unknown providers as aligned sources", () => {
  const result = analyze({ setupSource: "inconnue", contextSource: "inconnue" });
  assert.equal(result.statusKey, "sources_non_alignees");
  assert.equal(result.inputs.sourceAligned, false);
  assert.equal(result.tradeEligible, false);
});

test("does not use a completed higher-timeframe candle that closed after the setup candle", () => {
  const setupBars = makeBars("M5", 100);
  const contextBars = makeBars("M15", 80);
  const baseline = analyze({ setupBars, contextBars, now: NOW + 15 * MINUTE });
  const futureContext = {
    time: NOW,
    open: 110,
    high: 111,
    low: 89,
    close: 90,
  };
  const withLaterContext = analyze({
    setupBars,
    contextBars: [...contextBars, futureContext],
    now: NOW + 15 * MINUTE,
  });
  assert.equal(withLaterContext.bias.direction, baseline.bias.direction);
  assert.equal(withLaterContext.lastClosedBarAt, baseline.lastClosedBarAt);
});

test("marks stale history as non-confirmable", () => {
  const result = analyze({ now: NOW + 4 * 5 * MINUTE });
  assert.equal(result.statusKey, "historique_perime");
  assert.equal(result.tradeEligible, false);
});
