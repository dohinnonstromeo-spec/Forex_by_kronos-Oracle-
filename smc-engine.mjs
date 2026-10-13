// Deterministic, explainable SMC context for Kronos analysis.
// This module reads confirmed OHLC bars only. It never emits an executable trade signal.

export const KRONOS_SMC_VERSION = "kronos-smc-scalp-v1";
export const KRONOS_SMC_BENCHMARK = Object.freeze({
  market: "8 paires Deriv (dont XAU/USD)",
  timeframe: "M5 setup / M15 context",
  sample: "Deriv Demo, 31 janv. au 8 oct. 2026",
  strictTrades: 21,
  strictWinRatePct: 28.6,
  strictAverageR: -0.318,
  strictProfitFactor: 0.434,
  positiveFolds: 1,
  folds: 5,
  xauTrades: 6,
  xauAverageR: -0.444,
  xauProfitFactor: 0.174,
  note: "Résultat négatif et échantillon encore trop petit; SMC reste en recherche, sans signal copiable.",
});

const LOOKBACK = 20;
const PIVOT_SPAN = 2;
const ATR_PERIOD = 14;
const SETUP_TTL = 5;
const ZONE_TTL = 12;
const MIN_CONTEXT_BARS = 55;
const MIN_SETUP_BARS = 45;
const SESSION_START_UTC = 7;
const SESSION_END_UTC = 17;

const TIMEFRAME_MINUTES = Object.freeze({
  M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240,
  D1: 1440, W1: 10080, MN1: 43200,
});

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timeframeMs(value) {
  const minutes = TIMEFRAME_MINUTES[String(value || "").toUpperCase()];
  return minutes ? minutes * 60_000 : null;
}

function consecutiveBarStarts(previousMs, currentMs, timeframe, intervalMs) {
  const normalized = String(timeframe || "").toUpperCase();
  const previous = new Date(previousMs);
  const current = new Date(currentMs);
  if (normalized === "MN1") {
    const previousMonth = previous.getUTCFullYear() * 12 + previous.getUTCMonth();
    const currentMonth = current.getUTCFullYear() * 12 + current.getUTCMonth();
    return currentMonth - previousMonth === 1;
  }
  if (normalized === "D1") {
    const previousDay = Date.UTC(previous.getUTCFullYear(), previous.getUTCMonth(), previous.getUTCDate());
    const currentDay = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
    const dayDelta = (currentDay - previousDay) / 86_400_000;
    return dayDelta >= 1 && dayDelta <= 3;
  }
  if (normalized === "W1") {
    const delta = currentMs - previousMs;
    return delta >= 6 * 86_400_000 && delta <= 8 * 86_400_000;
  }
  return Math.abs((currentMs - previousMs) - intervalMs) <= 1000;
}

function timestampMs(bar) {
  const raw = bar?.epoch ?? bar?.time ?? bar?.timestamp ?? bar?.datetime;
  if (raw == null) return null;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(raw));
  return Number.isFinite(parsed) ? parsed : null;
}

function confirmedBars(rawBars, timeframe, now) {
  if (!Array.isArray(rawBars)) return {
    bars: [], hasTimestamps: false, excludedPartial: 0, invalidBars: 0,
    missingTimestamps: 0, duplicateBars: 0, conflictingDuplicates: 0,
    gaps: 0, trailingConsecutiveBars: 0,
  };
  const interval = timeframeMs(timeframe);
  let invalidBars = 0;
  let missingTimestamps = 0;
  let duplicateBars = 0;
  let conflictingDuplicates = 0;
  const parsed = [];
  for (const bar of rawBars) {
    const open = finite(bar?.open);
    const high = finite(bar?.high);
    const low = finite(bar?.low);
    const close = finite(bar?.close);
    const startMs = timestampMs(bar);
    if (startMs == null) missingTimestamps += 1;
    const coherent = [open, high, low, close].every((value) => value != null && value > 0)
      && high >= Math.max(open, close, low)
      && low <= Math.min(open, close, high);
    if (!coherent || startMs == null) {
      invalidBars += 1;
      continue;
    }
    parsed.push({ open, high, low, close, startMs, endMs: interval ? startMs + interval : null });
  }
  parsed.sort((a, b) => a.startMs - b.startMs);
  const unique = [];
  for (const bar of parsed) {
    const previous = unique.at(-1);
    if (previous?.startMs !== bar.startMs) {
      unique.push(bar);
      continue;
    }
    duplicateBars += 1;
    if (bar.open !== previous.open || bar.high !== previous.high || bar.low !== previous.low || bar.close !== previous.close) {
      conflictingDuplicates += 1;
    }
  }
  const bars = interval ? unique.filter((bar) => bar.endMs <= now) : unique;
  let gaps = 0;
  let trailingConsecutiveBars = bars.length ? 1 : 0;
  for (let index = 1; index < bars.length; index += 1) {
    if (!consecutiveBarStarts(bars[index - 1].startMs, bars[index].startMs, timeframe, interval)) gaps += 1;
  }
  for (let index = bars.length - 1; index > 0; index -= 1) {
    if (!consecutiveBarStarts(bars[index - 1].startMs, bars[index].startMs, timeframe, interval)) break;
    trailingConsecutiveBars += 1;
  }
  return {
    bars,
    hasTimestamps: rawBars.length > 0 && missingTimestamps === 0,
    excludedPartial: unique.length - bars.length,
    invalidBars,
    missingTimestamps,
    duplicateBars,
    conflictingDuplicates,
    gaps,
    trailingConsecutiveBars,
  };
}

function trueRanges(bars) {
  return bars.map((bar, index) => {
    if (index === 0) return bar.high - bar.low;
    const previousClose = bars[index - 1].close;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
}

function atrSeries(bars, period = ATR_PERIOD) {
  const ranges = trueRanges(bars);
  const out = Array(bars.length).fill(null);
  if (ranges.length < period) return out;
  let value = ranges.slice(0, period).reduce((sum, item) => sum + item, 0) / period;
  out[period - 1] = value;
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
    out[index] = value;
  }
  return out;
}

function emaSeries(bars, period) {
  const out = Array(bars.length).fill(null);
  if (!bars.length) return out;
  const alpha = 2 / (period + 1);
  let value = bars[0].close;
  out[0] = value;
  for (let index = 1; index < bars.length; index += 1) {
    value = alpha * bars[index].close + (1 - alpha) * value;
    out[index] = value;
  }
  return out;
}

function confirmedPivots(bars) {
  const highs = [];
  const lows = [];
  const state = { high: null, highIndex: -1, low: null, lowIndex: -1 };
  for (let index = 0; index < bars.length; index += 1) {
    const center = index - PIVOT_SPAN;
    if (center >= PIVOT_SPAN) {
      let isHigh = true;
      let isLow = true;
      for (let check = center - PIVOT_SPAN; check <= index; check += 1) {
        if (bars[center].high < bars[check].high) isHigh = false;
        if (bars[center].low > bars[check].low) isLow = false;
      }
      if (isHigh) {
        state.high = bars[center].high;
        state.highIndex = center;
        highs.push({ index: center, value: state.high });
      }
      if (isLow) {
        state.low = bars[center].low;
        state.lowIndex = center;
        lows.push({ index: center, value: state.low });
      }
    }
  }
  return { highs, lows, state };
}

function sourceFamily(source) {
  let text = String(source || "").toLowerCase();
  while (text.startsWith("cache:")) text = text.slice(6);
  if (/deriv/.test(text)) return "deriv";
  if (/twelve[_ -]?data/.test(text)) return "twelve_data";
  if (/binance/.test(text)) return "binance";
  if (/massive|polygon/.test(text)) return "massive";
  if (/yahoo/.test(text)) return "yahoo";
  if (/stooq|dukascopy/.test(text)) return "stooq";
  return text.split(":")[0] || "inconnue";
}

function utcSessionAllowed(bar) {
  const hour = new Date(bar.startMs).getUTCHours();
  return hour >= SESSION_START_UTC && hour < SESSION_END_UTC;
}

function isDisplacement(bar, range, direction) {
  if (!(range > 0)) return false;
  const body = Math.abs(bar.close - bar.open);
  const candleRange = Math.max(bar.high - bar.low, Number.EPSILON);
  if (direction === 1) return bar.close > bar.open && body >= range * 0.6
    && bar.close >= bar.low + candleRange * 0.75;
  return bar.close < bar.open && body >= range * 0.6
    && bar.close <= bar.high - candleRange * 0.75;
}

function findOppositeCandle(bars, index, direction) {
  for (let back = 1; back <= 5 && index - back >= 0; back += 1) {
    const bar = bars[index - back];
    if ((direction === 1 && bar.close < bar.open) || (direction === -1 && bar.close > bar.open)) {
      return { low: bar.low, high: bar.high, type: "OB", index: index - back };
    }
  }
  return null;
}

function contextBiasAt(setupBar, contextBars, contextEnds, ema20, ema50, startAt) {
  let index = startAt;
  while (index + 1 < contextBars.length && contextEnds[index + 1] <= setupBar.endMs) index += 1;
  if (index < 49 || contextEnds[index] > setupBar.endMs) return { direction: 0, index: -1 };
  const close = contextBars[index].close;
  if (close > ema20[index] && ema20[index] > ema50[index]) return { direction: 1, index };
  if (close < ema20[index] && ema20[index] < ema50[index]) return { direction: -1, index };
  return { direction: 0, index };
}

function priceLabel(direction) {
  return direction === 1 ? "haussier" : direction === -1 ? "baissier" : "neutre / non aligné";
}

function nearestLiquidity(bars, count = LOOKBACK) {
  if (bars.length < 2) return null;
  const prior = bars.slice(-count - 1, -1);
  if (!prior.length) return null;
  return {
    high: Math.max(...prior.map((bar) => bar.high)),
    low: Math.min(...prior.map((bar) => bar.low)),
    bars: prior.length,
  };
}

function oteForLeg(bars, pivots, direction) {
  if (direction !== 1 && direction !== -1) return null;
  const { highs, lows } = pivots;
  if (direction === 1) {
    const high = highs.at(-1);
    const low = [...lows].reverse().find((pivot) => high && pivot.index < high.index);
    if (!high || !low || high.value <= low.value) return null;
    const range = high.value - low.value;
    return { type: "OTE", direction, low: high.value - range * 0.79, high: high.value - range * 0.62, anchorLow: low.value, anchorHigh: high.value };
  }
  const low = lows.at(-1);
  const high = [...highs].reverse().find((pivot) => low && pivot.index < low.index);
  if (!high || !low || high.value <= low.value) return null;
  const range = high.value - low.value;
  return { type: "OTE", direction, low: low.value + range * 0.62, high: low.value + range * 0.79, anchorLow: low.value, anchorHigh: high.value };
}

function unavailable(statusKey, statusLabel, note, data = {}) {
  return {
    version: KRONOS_SMC_VERSION,
    mode: "observation_recherche",
    tradeEligible: false,
    statusKey,
    statusLabel,
    summary: note,
    setupTimeframe: data.setupTimeframe || null,
    contextTimeframe: data.contextTimeframe || null,
    inputs: data.inputs || {},
    bias: { direction: 0, label: "indisponible" },
    structure: { direction: "indisponible", label: "swings confirmés insuffisants" },
    liquidity: null,
    stages: [],
    zones: [],
    candidateLevels: null,
    benchmark: KRONOS_SMC_BENCHMARK,
  };
}

export function analyzeKronosSmc({
  pair = "",
  setupBars: rawSetupBars = [],
  contextBars: rawContextBars = [],
  setupTimeframe = "M5",
  contextTimeframe = "M15",
  setupSource = "inconnue",
  contextSource = "inconnue",
  setupStale = false,
  contextStale = false,
  strategy = "Scalping",
  spread = null,
  now = Date.now(),
  includeResearchSignals = false,
} = {}) {
  const setupMs = timeframeMs(setupTimeframe);
  const contextMs = timeframeMs(contextTimeframe);
  const inputMeta = {
    setupSource: String(setupSource || "inconnue"),
    contextSource: String(contextSource || "inconnue"),
    setupStale: Boolean(setupStale),
    contextStale: Boolean(contextStale),
    spread: finite(spread),
  };
  if (!setupMs || !contextMs || contextMs <= setupMs) {
    return unavailable("timeframe_invalide", "Timeframes SMC incompatibles", "Choisis une unité de contexte strictement supérieure à l'unité du setup.", { setupTimeframe, contextTimeframe, inputs: inputMeta });
  }
  const setupResult = confirmedBars(rawSetupBars, setupTimeframe, now);
  const contextResult = confirmedBars(rawContextBars, contextTimeframe, now);
  const bars = setupResult.bars;
  const context = contextResult.bars;
  inputMeta.setupBars = bars.length;
  inputMeta.contextBars = context.length;
  inputMeta.setupPartialBarsExcluded = setupResult.excludedPartial;
  inputMeta.contextPartialBarsExcluded = contextResult.excludedPartial;
  inputMeta.asOf = bars.at(-1) ? new Date(bars.at(-1).endMs).toISOString() : null;
  const evaluationTime = Number(now) || Date.now();
  const setupAgeMs = bars.at(-1) ? Math.max(0, evaluationTime - bars.at(-1).endMs) : null;
  const contextAgeMs = context.at(-1) ? Math.max(0, evaluationTime - context.at(-1).endMs) : null;
  inputMeta.setupAgeSeconds = setupAgeMs == null ? null : Math.floor(setupAgeMs / 1000);
  inputMeta.contextAgeSeconds = contextAgeMs == null ? null : Math.floor(contextAgeMs / 1000);
  const setupSourceFamily = sourceFamily(setupSource);
  const contextSourceFamily = sourceFamily(contextSource);
  inputMeta.setupSourceFamily = setupSourceFamily;
  inputMeta.contextSourceFamily = contextSourceFamily;
  inputMeta.sourceAligned = setupSourceFamily !== "inconnue" && setupSourceFamily === contextSourceFamily;
  inputMeta.setupInvalidBars = setupResult.invalidBars;
  inputMeta.contextInvalidBars = contextResult.invalidBars;
  inputMeta.setupDuplicateBars = setupResult.duplicateBars;
  inputMeta.contextDuplicateBars = contextResult.duplicateBars;
  inputMeta.setupConflictingDuplicates = setupResult.conflictingDuplicates;
  inputMeta.contextConflictingDuplicates = contextResult.conflictingDuplicates;
  inputMeta.setupGaps = setupResult.gaps;
  inputMeta.contextGaps = contextResult.gaps;
  inputMeta.setupTrailingConsecutiveBars = setupResult.trailingConsecutiveBars;
  inputMeta.contextTrailingConsecutiveBars = contextResult.trailingConsecutiveBars;

  if ((rawSetupBars.length > 0 && !setupResult.hasTimestamps) || (rawContextBars.length > 0 && !contextResult.hasTimestamps)) {
    return unavailable("horodatage_absent", "Historique non confirmé", "Kronos a besoin de l'horodatage des bougies pour aligner le biais supérieur sans utiliser d'information future.", { setupTimeframe, contextTimeframe, inputs: inputMeta });
  }
  if (setupResult.invalidBars || contextResult.invalidBars || setupResult.conflictingDuplicates || contextResult.conflictingDuplicates) {
    return unavailable("donnees_incoherentes", "Données OHLC incohérentes", "Au moins une bougie contient un OHLC invalide ou des valeurs contradictoires au même horodatage. Aucun setup SMC n'est confirmé avec ces données.", { setupTimeframe, contextTimeframe, inputs: inputMeta });
  }
  if (bars.length < MIN_SETUP_BARS || context.length < MIN_CONTEXT_BARS) {
    return unavailable("historique_insuffisant", "Historique insuffisant", `SMC requiert au moins ${MIN_SETUP_BARS} bougies clôturées ${setupTimeframe} et ${MIN_CONTEXT_BARS} bougies clôturées ${contextTimeframe}.`, { setupTimeframe, contextTimeframe, inputs: inputMeta });
  }
  if (setupResult.trailingConsecutiveBars < 3 || contextResult.trailingConsecutiveBars < 2) {
    return unavailable("historique_discontinu", "Historique MTF discontinu", "Les dernières bougies setup/contexte comportent une coupure de données. Attends au moins trois bougies setup et deux bougies contexte consécutives avant de confirmer un setup.", { setupTimeframe, contextTimeframe, inputs: inputMeta });
  }

  const stale = Boolean(setupStale || contextStale
    || (setupAgeMs != null && setupAgeMs > setupMs * 3)
    || (contextAgeMs != null && contextAgeMs > contextMs * 3));
  const sourceMismatch = !inputMeta.sourceAligned;
  const atr = atrSeries(bars);
  const ema20 = emaSeries(context, 20);
  const ema50 = emaSeries(context, 50);
  const contextEnds = context.map((bar) => bar.endMs);
  const pivots = { highs: [], lows: [], state: { high: null, highIndex: -1, low: null, lowIndex: -1 } };
  let contextPointer = 0;
  let activeSetup = null;
  let activeZone = null;
  let latestSweep = null;
  let latestChoch = null;
  let latestZoneEvent = null;
  let latestRetest = null;
  const researchSignals = [];
  let currentBias = { direction: 0, index: -1 };
  const diagnostics = { sweeps: 0, alignedSweeps: 0, structureBreaks: 0, fvgCreated: 0, obCreated: 0, retests: 0 };

  for (let index = 0; index < bars.length; index += 1) {
    const bar = bars[index];
    if (index > 0 && !consecutiveBarStarts(bars[index - 1].startMs, bar.startMs, setupTimeframe, setupMs)) {
      activeSetup = null;
      activeZone = null;
      latestSweep = null;
      latestChoch = null;
      latestZoneEvent = null;
      latestRetest = null;
    }
    const center = index - PIVOT_SPAN;
    if (center >= PIVOT_SPAN) {
      let isHigh = true;
      let isLow = true;
      for (let check = center - PIVOT_SPAN; check <= index; check += 1) {
        if (bars[center].high < bars[check].high) isHigh = false;
        if (bars[center].low > bars[check].low) isLow = false;
      }
      if (isHigh) {
        pivots.state.high = bars[center].high;
        pivots.state.highIndex = center;
        pivots.highs.push({ index: center, value: bars[center].high });
      }
      if (isLow) {
        pivots.state.low = bars[center].low;
        pivots.state.lowIndex = center;
        pivots.lows.push({ index: center, value: bars[center].low });
      }
    }
    while (contextPointer + 1 < context.length && contextEnds[contextPointer + 1] <= bar.endMs) contextPointer += 1;
    currentBias = contextBiasAt(bar, context, contextEnds, ema20, ema50, contextPointer);
    if (!atr[index] || index < LOOKBACK || !utcSessionAllowed(bar) && /scalp/i.test(strategy)) {
      if (activeSetup && index - activeSetup.index > SETUP_TTL) activeSetup = null;
      if (activeZone && index > activeZone.expires) activeZone = null;
      continue;
    }

    if (activeZone && (index > activeZone.expires
      || (activeZone.direction === 1 && bar.close < activeZone.low)
      || (activeZone.direction === -1 && bar.close > activeZone.high))) {
      activeZone = null;
      latestZoneEvent = null;
    }

    if (activeZone && index > activeZone.index) {
      const touches = bar.low <= activeZone.high && bar.high >= activeZone.low;
      const midpoint = (activeZone.low + activeZone.high) / 2;
      const rejected = activeZone.direction === 1
        ? bar.close > bar.open && bar.close > midpoint
        : bar.close < bar.open && bar.close < midpoint;
      if (touches && rejected && currentBias.direction === activeZone.direction) {
        latestRetest = { ...activeZone, retestIndex: index, retestTime: bar.endMs, entryReference: bar.close, bias: currentBias.direction };
        researchSignals.push({
          direction: activeZone.direction,
          stopReference: activeZone.sweepExtreme,
          signalRange: atr[index],
          signalTime: bar.endMs - 60_000,
          signalEndTime: bar.endMs,
          zoneType: activeZone.type,
        });
        diagnostics.retests += 1;
        activeZone = null;
        activeSetup = null;
        continue;
      }
    }

    if (activeSetup && index > activeSetup.index) {
      if (index > activeSetup.expires || (activeSetup.direction === 1 && bar.low < activeSetup.extreme)
        || (activeSetup.direction === -1 && bar.high > activeSetup.extreme)) {
        activeSetup = null;
        activeZone = null;
        latestChoch = null;
        latestZoneEvent = null;
        latestRetest = null;
      } else {
        const brokePivot = activeSetup.direction === 1 ? bar.close > activeSetup.breakLevel : bar.close < activeSetup.breakLevel;
        if (brokePivot && activeSetup.chochIndex == null) {
          diagnostics.structureBreaks += 1;
          activeSetup.chochIndex = index;
          latestChoch = { direction: activeSetup.direction, breakLevel: activeSetup.breakLevel, index, time: bar.endMs };
        }
        const structureHeld = activeSetup.direction === 1 ? bar.close > activeSetup.breakLevel : bar.close < activeSetup.breakLevel;
        if (activeSetup.chochIndex != null && structureHeld && index >= activeSetup.chochIndex
          && index - activeSetup.chochIndex <= SETUP_TTL) {
          const prior2 = bars[index - 2];
          const displacement = isDisplacement(bar, atr[index], activeSetup.direction);
          const hasFvg = prior2 && displacement && (activeSetup.direction === 1
            ? prior2.high < bar.low : prior2.low > bar.high);
          if (hasFvg) {
            diagnostics.fvgCreated += 1;
            const fvg = activeSetup.direction === 1
              ? { low: prior2.high, high: bar.low, type: "FVG" }
              : { low: bar.high, high: prior2.low, type: "FVG" };
            activeZone = { ...fvg, direction: activeSetup.direction, sweepExtreme: activeSetup.extreme,
              index, expires: index + ZONE_TTL, createdTime: bar.endMs };
            latestZoneEvent = activeZone;
            activeSetup = null;
            continue;
          }
          if (displacement) {
            const ob = findOppositeCandle(bars, index, activeSetup.direction);
            if (ob) {
              diagnostics.obCreated += 1;
              activeZone = { ...ob, direction: activeSetup.direction, sweepExtreme: activeSetup.extreme,
                index, expires: index + ZONE_TTL, createdTime: bar.endMs };
              latestZoneEvent = activeZone;
              activeSetup = null;
              continue;
            }
          }
        }
      }
    }

    const prior = bars.slice(Math.max(0, index - LOOKBACK), index);
    if (prior.length < LOOKBACK) continue;
    const priorLow = Math.min(...prior.map((item) => item.low));
    const priorHigh = Math.max(...prior.map((item) => item.high));
    let direction = 0;
    let extreme = Number.NaN;
    if (bar.low < priorLow && bar.close > priorLow && bar.close > bar.open) {
      direction = 1;
      extreme = bar.low;
    } else if (bar.high > priorHigh && bar.close < priorHigh && bar.close < bar.open) {
      direction = -1;
      extreme = bar.high;
    }
    if (!direction) continue;
    diagnostics.sweeps += 1;
    latestChoch = null;
    latestZoneEvent = null;
    latestRetest = null;
    latestSweep = { direction, level: direction === 1 ? priorLow : priorHigh, extreme, index, time: bar.endMs, bias: currentBias.direction };
    if (currentBias.direction !== direction) continue;
    diagnostics.alignedSweeps += 1;
    const breakLevel = direction === 1 ? pivots.state.high : pivots.state.low;
    const pivotIndex = direction === 1 ? pivots.state.highIndex : pivots.state.lowIndex;
    if (Number.isFinite(breakLevel) && pivotIndex >= 0 && pivotIndex < index) {
      activeSetup = { direction, extreme, breakLevel, index, expires: index + SETUP_TTL, chochIndex: null };
    }
  }

  const pivotStructure = (() => {
    const highPair = pivots.highs.slice(-2);
    const lowPair = pivots.lows.slice(-2);
    const higherHighs = highPair.length === 2 && highPair[1].value > highPair[0].value;
    const lowerHighs = highPair.length === 2 && highPair[1].value < highPair[0].value;
    const higherLows = lowPair.length === 2 && lowPair[1].value > lowPair[0].value;
    const lowerLows = lowPair.length === 2 && lowPair[1].value < lowPair[0].value;
    const direction = higherHighs && higherLows ? 1 : lowerHighs && lowerLows ? -1 : 0;
    return {
      direction,
      label: direction === 1 ? "HH/HL haussiers confirmés" : direction === -1 ? "LH/LL baissiers confirmés" : "structure mixte / range",
      lastSwingHigh: highPair.at(-1)?.value ?? null,
      lastSwingLow: lowPair.at(-1)?.value ?? null,
    };
  })();
  const lastBar = bars.at(-1);
  const liquidity = nearestLiquidity(bars);
  const activeDirection = activeZone?.direction ?? activeSetup?.direction ?? latestRetest?.direction ?? latestSweep?.direction ?? 0;
  const ote = oteForLeg(bars, pivots, activeDirection);
  const zones = [];
  if (activeZone) zones.push({
    type: activeZone.type,
    direction: activeZone.direction,
    low: activeZone.low,
    high: activeZone.high,
    timeframe: setupTimeframe,
    lifecycle: "fraîche / en attente de retest",
    expiresInBars: Math.max(0, activeZone.expires - (bars.length - 1)),
  });
  if (ote) zones.push({ ...ote, timeframe: setupTimeframe, lifecycle: "repère Fibonacci facultatif; non testé comme filtre" });

  let statusKey = "aucun_setup";
  let statusLabel = "Aucun setup SMC actif";
  if (stale) {
    statusKey = "historique_perime";
    statusLabel = "Historique differe : setup non confirmable";
  } else if (sourceMismatch) {
    statusKey = "sources_non_alignees";
    statusLabel = "Sources OHLC differentes entre timeframes";
  } else if (latestRetest && latestRetest.retestIndex === bars.length - 1) {
    statusKey = "retest_confirme_recherche";
    statusLabel = "Retest confirmé · scénario de recherche";
  } else if (activeZone) {
    statusKey = "attente_retest";
    statusLabel = `Attente du retest ${activeZone.type}`;
  } else if (activeSetup?.chochIndex != null) {
    statusKey = "attente_deplacement";
    statusLabel = "CHoCH confirmé · attente déplacement/FVG";
  } else if (activeSetup) {
    statusKey = "attente_choch";
    statusLabel = "Sweep confirmé · attente cassure de structure";
  } else if (latestSweep && bars.length - 1 - latestSweep.index <= SETUP_TTL && latestSweep.bias !== latestSweep.direction) {
    statusKey = "biais_mtf_contraire";
    statusLabel = "Sweep détecté · biais MTF non aligné";
  } else if (latestSweep && bars.length - 1 - latestSweep.index <= SETUP_TTL
    && latestSweep.bias === latestSweep.direction) {
    statusKey = "attente_choch";
    statusLabel = "Sweep confirme; attente d'une cassure de structure";
  } else if (stale) {
    statusKey = "historique_perime";
    statusLabel = "Historique différé · setup non confirmable";
  } else if (sourceMismatch) {
    statusKey = "sources_non_alignees";
    statusLabel = "Sources OHLC différentes entre timeframes";
  }
  if (stale && statusKey !== "historique_perime") {
    statusLabel += " · historique différé";
  }
  if (sourceMismatch && statusKey !== "sources_non_alignees") {
    statusLabel += " · sources différentes";
  }

  const biasDirection = currentBias.direction;
  const lastIndex = bars.length - 1;
  const retestRecent = Boolean(latestRetest && lastIndex - latestRetest.retestIndex <= 1);
  const sweepRecent = Boolean(latestSweep && lastIndex - latestSweep.index <= SETUP_TTL);
  const structureActive = Boolean(activeZone || activeSetup?.chochIndex != null || retestRecent);
  const zoneActive = Boolean(activeZone || retestRecent);
  const sweepActive = Boolean(activeZone || activeSetup || retestRecent || sweepRecent);
  const stages = [
    { key: "biais", label: `Biais ${contextTimeframe}`, status: biasDirection ? "confirme" : "neutre", detail: priceLabel(biasDirection) },
    { key: "liquidite", label: "Sweep + reprise", status: sweepActive ? "confirme" : "attente", detail: sweepActive && latestSweep ? `${latestSweep.direction === 1 ? "bas" : "haut"} sweep; close back inside` : "aucun sweep recent" },
    { key: "structure", label: "CHoCH / BOS", status: structureActive ? "confirme" : "attente", detail: structureActive && latestChoch ? `cloture au-dela de ${latestChoch.breakLevel}` : "cassure d'un pivot confirmee attendue" },
    { key: "deplacement", label: "Deplacement + zone", status: zoneActive ? "confirme" : "attente", detail: zoneActive && latestZoneEvent ? `${latestZoneEvent.type} creee apres l'impulsion` : activeZone ? `${activeZone.type} creee apres l'impulsion` : "impulsion >= 0.6 ATR et FVG/OB attendue" },
    { key: "retest", label: "Retest + rejet", status: retestRecent ? "confirme" : activeZone ? "attente" : "bloque", detail: retestRecent ? "cloture de rejet dans la zone" : activeZone ? `zone valide ${Math.max(0, activeZone.expires - lastIndex)} bougies encore` : "aucune zone active a retester" },
  ];  const stepsConfirmed = stages.filter((stage) => stage.status === "confirme").length;
  const direction = activeZone?.direction ?? activeSetup?.direction ?? latestRetest?.direction ?? latestSweep?.direction ?? 0;
  const directionText = direction === 1 ? "haussier" : direction === -1 ? "baissier" : "indéterminé";
  const sourceNote = sourceMismatch ? " Les deux unités de temps viennent de fournisseurs différents." : "";
  const staleNote = stale ? " Au moins un historique est différé." : "";
  const noEdgeNote = " Le backtest strict multi-paires est négatif; le scénario reste en mode recherche et n'est pas un signal validé.";
  const summary = statusKey === "retest_confirme_recherche"
    ? `Séquence ${directionText} complète sur la dernière bougie clôturée: sweep, cassure confirmée, zone puis rejet au retest.${noEdgeNote}`
    : `${statusLabel}. Étapes confirmées: ${stepsConfirmed}/5.${sourceNote}${staleNote}`;

  const candidateLevels = latestRetest && latestRetest.retestIndex === bars.length - 1 && !stale && !sourceMismatch
    ? (() => {
      const entry = latestRetest.entryReference;
      const tick = /XAU|XAG|GOLD|SILVER/i.test(String(pair)) ? 0.01
        : /JPY/i.test(String(pair)) ? 0.001 : 0.00001;
      const buffer = Math.max((atr.at(-1) || 0) * 0.1, tick * 2);
      const sl = latestRetest.direction === 1 ? latestRetest.sweepExtreme - buffer : latestRetest.sweepExtreme + buffer;
      const risk = Math.abs(entry - sl);
      return risk > 0 ? {
        direction: latestRetest.direction === 1 ? "ACHAT" : "VENTE",
        entry,
        sl,
        tp: entry + latestRetest.direction * risk * 1.5,
        risk,
        rr: "1:1.5",
        label: "simulation de recherche uniquement; non validée et non copiable",
      } : null;
    })()
    : null;

  return {
    version: KRONOS_SMC_VERSION,
    mode: "observation_recherche",
    tradeEligible: false,
    statusKey,
    statusLabel,
    summary,
    setupTimeframe,
    contextTimeframe,
    inputs: inputMeta,
    bias: { direction: biasDirection, label: priceLabel(biasDirection), ema20: ema20.at(-1), ema50: ema50.at(-1) },
    structure: pivotStructure,
    liquidity: liquidity ? { ...liquidity, source: `extrêmes des ${liquidity.bars} bougies antérieures` } : null,
    stages,
    stepsConfirmed,
    direction: direction === 1 ? "ACHAT" : direction === -1 ? "VENTE" : null,
    activeZone: activeZone ? { type: activeZone.type, direction: activeZone.direction === 1 ? "ACHAT" : "VENTE", low: activeZone.low, high: activeZone.high, createdAt: new Date(activeZone.createdTime).toISOString(), expiresInBars: Math.max(0, activeZone.expires - (bars.length - 1)) } : null,
    zones,
    candidateLevels,
    diagnostics,
    ...(includeResearchSignals ? { researchSignals: stale || sourceMismatch ? [] : researchSignals } : {}),
    lastClosedBarAt: lastBar ? new Date(lastBar.endMs).toISOString() : null,
    benchmark: KRONOS_SMC_BENCHMARK,
    caveat: "OHLC ne révèle pas les ordres institutionnels. Ce panneau décrit une règle mécanique, pas une probabilité de gain ni une recommandation automatique.",
  };
}
