// Shared, deterministic Price Action scalp rule used by the research backtest
// and the no-screenshot analysis path. This module identifies setups; it does
// not claim an edge or authorize execution.

export const KRONOS_PRICE_ACTION_VERSION = "kronos-pa-break-retest-v1";

export const PRICE_ACTION_RULES = Object.freeze({
  lookbackBars: 30,
  retestBars: 8,
  averageRangeBars: 14,
  tp1R: 1,
  tp2R: 1.6,
  closeAtTp1Pct: 50,
  maxCostR: 0.15,
  maxStopRangeR: 3,
  defaultTimeStopMinutes: 30,
});

export function createPriceActionSetupState() {
  return { direction: 0, level: Number.NaN, index: -1 };
}

/**
 * Process one closed bar. Formula is shared verbatim by the production
 * diagnostic and the historical walk-forward script.
 */
export function stepPriceActionScalp({
  bar,
  previousBar,
  index,
  averageRange,
  support,
  resistance,
  setup = "retest",
  setupState = createPriceActionSetupState(),
  tickSize,
  spreadPct = 0,
  commissionPctPerSide = 0,
  slippageTicksPerSide = 1,
}) {
  const { open, high, low, close } = bar || {};
  if (![open, high, low, close, averageRange, support, resistance, tickSize].every(Number.isFinite)
    || !(averageRange > 0) || !(tickSize > 0) || index < PRICE_ACTION_RULES.lookbackBars + 2) {
    return { finalDirection: 0, signal: null, state: setupState };
  }

  const candleBody = Math.abs(close - open);
  const candleRange = Math.max(high - low, close * 0.00001);
  const lowerWick = Math.min(open, close) - low;
  const upperWick = high - Math.max(open, close);
  const bullWick = close > open
    && lowerWick >= Math.max(candleBody * 1.35, candleRange * 0.25)
    && close >= low + candleRange * 0.62;
  const bearWick = close < open
    && upperWick >= Math.max(candleBody * 1.35, candleRange * 0.25)
    && close <= high - candleRange * 0.62;
  const bullEngulf = previousBar && previousBar.close < previousBar.open
    && close > open && close >= previousBar.open && open <= previousBar.close;
  const bearEngulf = previousBar && previousBar.close > previousBar.open
    && close < open && close <= previousBar.open && open >= previousBar.close;
  const tolerance = Math.max(averageRange * 0.20, tickSize * 2);

  const makeSignal = (direction, level, invalidationExtreme, setupType) => {
    const buffer = Math.max(averageRange * 0.10, tickSize * 2);
    const stop = direction === 1
      ? Math.min(level, invalidationExtreme) - buffer
      : Math.max(level, invalidationExtreme) + buffer;
    const risk = Math.abs(close - stop);
    if (!(risk > 0) || risk > averageRange * PRICE_ACTION_RULES.maxStopRangeR) return null;
    const roundTripCost = close * spreadPct / 100
      + close * 2 * commissionPctPerSide / 100
      + tickSize * slippageTicksPerSide * 2;
    if (roundTripCost / risk > PRICE_ACTION_RULES.maxCostR) return null;
    return {
      setup: setupType,
      direction,
      entry: close,
      stop,
      risk,
      averageRange,
      tp1: close + direction * risk * PRICE_ACTION_RULES.tp1R,
      tp2: close + direction * risk * PRICE_ACTION_RULES.tp2R,
      roundTripCost,
      costR: roundTripCost / risk,
    };
  };

  if (setup === "rejection") {
    const longAtSupport = (bullWick || bullEngulf)
      && low <= support + tolerance && low >= support - tolerance * 1.5 && close > support;
    const shortAtResistance = (bearWick || bearEngulf)
      && high >= resistance - tolerance && high <= resistance + tolerance * 1.5 && close < resistance;
    if (longAtSupport) {
      const signal = makeSignal(1, support, low, "rejection");
      return { finalDirection: signal ? 1 : 0, signal, state: setupState };
    }
    if (shortAtResistance) {
      const signal = makeSignal(-1, resistance, high, "rejection");
      return { finalDirection: signal ? -1 : 0, signal, state: setupState };
    }
    return { finalDirection: 0, signal: null, state: setupState };
  }

  const state = setupState;
  const breakBuffer = Math.max(close * 0.0002, tickSize * 2);
  if (state.direction !== 0) {
    const age = index - state.index;
    if (age > PRICE_ACTION_RULES.retestBars
      || (state.direction === 1 && close < state.level - tolerance)
      || (state.direction === -1 && close > state.level + tolerance)) {
      state.direction = 0;
      state.level = Number.NaN;
      state.index = -1;
    }
  }

  const bullBreak = state.direction === 0 && close > resistance + breakBuffer
    && previousBar?.close <= resistance + breakBuffer;
  const bearBreak = state.direction === 0 && close < support - breakBuffer
    && previousBar?.close >= support - breakBuffer;
  if (bullBreak || bearBreak) {
    state.direction = bullBreak ? 1 : -1;
    state.level = bullBreak ? resistance : support;
    state.index = index;
    return { finalDirection: 0, signal: null, state };
  }

  if (state.direction === 1 && index > state.index) {
    const retested = low <= state.level + tolerance && low >= state.level - tolerance * 2;
    if (retested && close > state.level && (close > open || bullWick || bullEngulf)) {
      const signal = makeSignal(1, state.level, low, "break_retest");
      state.direction = 0;
      return { finalDirection: signal ? 1 : 0, signal, state };
    }
  } else if (state.direction === -1 && index > state.index) {
    const retested = high >= state.level - tolerance && high <= state.level + tolerance * 2;
    if (retested && close < state.level && (close < open || bearWick || bearEngulf)) {
      const signal = makeSignal(-1, state.level, high, "break_retest");
      state.direction = 0;
      return { finalDirection: signal ? -1 : 0, signal, state };
    }
  }
  return { finalDirection: 0, signal: null, state };
}

export function analyzeLatestPriceActionScalp(bars, {
  tickSize,
  spread = null,
  commissionPctPerSide = 0,
  slippageTicksPerSide = 1,
  timeStopMinutes = PRICE_ACTION_RULES.defaultTimeStopMinutes,
} = {}) {
  const usable = Array.isArray(bars) ? bars.filter((bar) => [bar.open, bar.high, bar.low, bar.close]
    .every((value) => Number.isFinite(Number(value)))) : [];
  const base = {
    version: KRONOS_PRICE_ACTION_VERSION,
    status: "no_setup",
    statusLabel: "Aucun déclencheur confirmé",
    bars: usable.length,
    requiredBars: PRICE_ACTION_RULES.lookbackBars + 3,
    rule: "Cassure clôturée du niveau des 30 bougies précédentes, puis retest/reprise dans les 8 bougies suivantes.",
    timeStopMinutes,
    targetPlan: `50% à +${PRICE_ACTION_RULES.tp1R}R, solde à +${PRICE_ACTION_RULES.tp2R}R ou sortie temporelle.`,
    candidates: [],
  };
  if (usable.length < base.requiredBars || !(tickSize > 0)) {
    return { ...base, status: "insufficient_data", statusLabel: "Historique insuffisant" };
  }

  const last = usable.length - 1;
  const currentSpreadPct = Number.isFinite(Number(spread)) && Number(usable[last].close) > 0
    ? Number(spread) / Number(usable[last].close) * 100 : 0;
  const scanStart = Math.max(0, usable.length - 60);
  for (const setup of ["retest", "rejection"]) {
    const state = createPriceActionSetupState();
    let latestSignal = null;
    for (let index = scanStart; index <= last; index += 1) {
      if (index < PRICE_ACTION_RULES.lookbackBars + 2) continue;
      const bar = usable[index];
      const previousBar = usable[index - 1];
      const rangeStart = Math.max(0, index - PRICE_ACTION_RULES.averageRangeBars + 1);
      const ranges = usable.slice(rangeStart, index + 1).map((item) => Number(item.high) - Number(item.low));
      const averageRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
      const prior = usable.slice(index - PRICE_ACTION_RULES.lookbackBars, index);
      const support = Math.min(...prior.map((item) => Number(item.low)));
      const resistance = Math.max(...prior.map((item) => Number(item.high)));
      const result = stepPriceActionScalp({
        bar: { open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close) },
        previousBar: { open: Number(previousBar.open), high: Number(previousBar.high), low: Number(previousBar.low), close: Number(previousBar.close) },
        index,
        averageRange,
        support,
        resistance,
        setup,
        setupState: state,
        tickSize,
        spreadPct: index === last ? currentSpreadPct : 0,
        commissionPctPerSide,
        slippageTicksPerSide,
      });
      if (index === last && result.signal) {
        latestSignal = {
          ...result.signal,
          directionLabel: result.signal.direction === 1 ? "ACHAT" : "VENTE",
          entryBarTime: bar.datetime || bar.time || null,
          timeStopMinutes,
          closeAtTp1Pct: PRICE_ACTION_RULES.closeAtTp1Pct,
        };
      }
    }
    if (latestSignal) base.candidates.push(latestSignal);
  }
  if (base.candidates.length) {
    base.status = "research_candidate";
    base.statusLabel = "Configuration Price Action repérée · recherche seulement";
  }
  return base;
}
