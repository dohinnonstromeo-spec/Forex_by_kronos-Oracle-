import {
  createPriceActionSetupState,
  PRICE_ACTION_RULES,
  stepPriceActionScalp,
} from "./price-action-scalp-engine.mjs";

export const PA_FORWARD_STRATEGY_VERSION = "xau-m5-pa-retest-short-sl150-tp1r-tp16r-bidask-v1";
export const PA_FORWARD_STRATEGY = Object.freeze({
  pair: "XAUUSD",
  timeframe: "M5",
  setup: "break_retest",
  direction: -1,
  stopMultiplier: 1.5,
  tp1R: PRICE_ACTION_RULES.tp1R,
  tp2R: PRICE_ACTION_RULES.tp2R,
  tp1SizePct: PRICE_ACTION_RULES.closeAtTp1Pct,
  maxHoldMinutes: PRICE_ACTION_RULES.defaultTimeStopMinutes,
  maxCostR: PRICE_ACTION_RULES.maxCostR,
  slippageTicksPerSide: 1,
  commissionPctPerSide: 0,
  minTicksPerMinute: 10,
});

function epochOf(bar) {
  const parsed = Date.parse(bar?.datetime || bar?.time || "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

export function aggregateMinuteBidAskTicks(ticks) {
  const valid = Array.isArray(ticks) ? ticks.filter((tick) => {
    const epoch = Number(tick?.epoch);
    const bid = Number(tick?.bid);
    const ask = Number(tick?.ask);
    return Number.isFinite(epoch) && bid > 0 && ask >= bid;
  }).sort((a, b) => Number(a.epoch) - Number(b.epoch)) : [];
  if (!valid.length) return null;
  const first = valid[0];
  const last = valid.at(-1);
  let bidHigh = Number.NEGATIVE_INFINITY;
  let bidLow = Number.POSITIVE_INFINITY;
  let askHigh = Number.NEGATIVE_INFINITY;
  let askLow = Number.POSITIVE_INFINITY;
  let spreadSum = 0;
  for (const tick of valid) {
    const bid = Number(tick.bid);
    const ask = Number(tick.ask);
    bidHigh = Math.max(bidHigh, bid);
    bidLow = Math.min(bidLow, bid);
    askHigh = Math.max(askHigh, ask);
    askLow = Math.min(askLow, ask);
    spreadSum += ask - bid;
  }
  return {
    minute_epoch: Math.floor(Number(first.epoch) / 60) * 60,
    bid_open: Number(first.bid),
    bid_high: bidHigh,
    bid_low: bidLow,
    bid_close: Number(last.bid),
    ask_open: Number(first.ask),
    ask_high: askHigh,
    ask_low: askLow,
    ask_close: Number(last.ask),
    mean_spread: spreadSum / valid.length,
    tick_count: valid.length,
    first_tick_epoch: Number(first.epoch),
    last_tick_epoch: Number(last.epoch),
  };
}

export function isCompleteBidAskMinute(row) {
  const minuteEpoch = Number(row?.minute_epoch);
  const firstTickEpoch = Number(row?.first_tick_epoch);
  const lastTickEpoch = Number(row?.last_tick_epoch);
  return Number(row?.tick_count) >= PA_FORWARD_STRATEGY.minTicksPerMinute
    && Number.isFinite(minuteEpoch)
    && Number.isFinite(firstTickEpoch)
    && Number.isFinite(lastTickEpoch)
    && firstTickEpoch >= minuteEpoch
    && firstTickEpoch <= minuteEpoch + 5
    && lastTickEpoch >= minuteEpoch + 54
    && lastTickEpoch < minuteEpoch + 60;
}

export function summarizePaForwardEvidence(closedRows, { minTrades = 100, minWeeks = 20, replicates = 5000 } = {}) {
  const weekly = new Map();
  const trades = (Array.isArray(closedRows) ? closedRows : []).map((row) => {
    const resultR = Number(row?.realized_r);
    const closedEpoch = Math.floor(Date.parse(row?.closed_at || "") / 1000);
    const epoch = Number.isFinite(closedEpoch) && closedEpoch > 0 ? closedEpoch : Number(row?.entry_epoch);
    return { resultR, epoch };
  }).filter((trade) => Number.isFinite(trade.resultR) && Number.isFinite(trade.epoch) && trade.epoch > 0);

  for (const trade of trades) {
    const utcDay = Math.floor(trade.epoch / 86_400);
    const week = Math.floor((utcDay + 3) / 7); // Monday-based UTC week.
    const bucket = weekly.get(week) || { week, trades: 0, totalR: 0 };
    bucket.trades += 1;
    bucket.totalR += trade.resultR;
    weekly.set(week, bucket);
  }

  const blocks = [...weekly.values()].sort((a, b) => a.week - b.week);
  const weeksWithTrades = blocks.length;
  const totalR = trades.reduce((sum, trade) => sum + trade.resultR, 0);
  const meanR = trades.length ? totalR / trades.length : null;
  let lower95R = null;
  let upper95R = null;

  if (weeksWithTrades >= 10 && trades.length >= 30 && replicates > 0) {
    let seed = 2166136261;
    for (const block of blocks) {
      const text = `${block.week}:${block.trades}:${block.totalR.toFixed(6)};`;
      for (let index = 0; index < text.length; index += 1) {
        seed = Math.imul(seed ^ text.charCodeAt(index), 16777619) >>> 0;
      }
    }
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4_294_967_296;
    };
    const samples = [];
    for (let sample = 0; sample < replicates; sample += 1) {
      let sampledR = 0;
      let sampledTrades = 0;
      for (let draw = 0; draw < weeksWithTrades; draw += 1) {
        const block = blocks[Math.floor(random() * weeksWithTrades)];
        sampledR += block.totalR;
        sampledTrades += block.trades;
      }
      if (sampledTrades) samples.push(sampledR / sampledTrades);
    }
    samples.sort((a, b) => a - b);
    const quantile = (probability) => {
      if (!samples.length) return null;
      const position = (samples.length - 1) * probability;
      const lower = Math.floor(position);
      const upper = Math.ceil(position);
      const fraction = position - lower;
      return samples[lower] * (1 - fraction) + samples[upper] * fraction;
    };
    lower95R = quantile(0.025);
    upper95R = quantile(0.975);
  }

  let status = "insufficient_sample";
  if (trades.length >= minTrades && weeksWithTrades >= minWeeks) {
    if (Number.isFinite(lower95R) && lower95R > 0) status = "positive_candidate_unconfirmed";
    else if (Number.isFinite(upper95R) && upper95R < 0) status = "negative_candidate";
    else status = "inconclusive";
  }
  return {
    trades: trades.length,
    weeksWithTrades,
    meanR,
    lower95R,
    upper95R,
    minTrades,
    minWeeks,
    bootstrapWeeks: weeksWithTrades >= 10 && trades.length >= 30 ? weeksWithTrades : 0,
    replicates: weeksWithTrades >= 10 && trades.length >= 30 ? replicates : 0,
    status,
  };
}

export function stepPaForwardBar(bars, index, setupState, { tickSize, spread = 0 } = {}) {
  if (!Array.isArray(bars) || index < PRICE_ACTION_RULES.lookbackBars + 2 || index >= bars.length || !(tickSize > 0)) {
    return { finalDirection: 0, signal: null, state: setupState || createPriceActionSetupState() };
  }
  const bar = bars[index];
  const previousBar = bars[index - 1];
  const barEpoch = epochOf(bar);
  const globalIndex = Number.isFinite(barEpoch) ? Math.floor(barEpoch / 300) : index;
  const rangeStart = Math.max(0, index - PRICE_ACTION_RULES.averageRangeBars + 1);
  const ranges = bars.slice(rangeStart, index + 1).map((item) => Number(item.high) - Number(item.low));
  const averageRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const prior = bars.slice(index - PRICE_ACTION_RULES.lookbackBars, index);
  const support = Math.min(...prior.map((item) => Number(item.low)));
  const resistance = Math.max(...prior.map((item) => Number(item.high)));
  return stepPriceActionScalp({
    bar: { open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close) },
    previousBar: { open: Number(previousBar.open), high: Number(previousBar.high), low: Number(previousBar.low), close: Number(previousBar.close) },
    index: globalIndex,
    averageRange,
    support,
    resistance,
    setup: "retest",
    setupState: setupState || createPriceActionSetupState(),
    tickSize,
    spreadPct: Number(bar.close) > 0 ? Number(spread) / Number(bar.close) * 100 : 0,
    commissionPctPerSide: PA_FORWARD_STRATEGY.commissionPctPerSide,
    slippageTicksPerSide: PA_FORWARD_STRATEGY.slippageTicksPerSide,
  });
}

export function warmPaForwardSetupState(bars, throughIndex, { tickSize, spreadByM5Epoch = new Map() } = {}) {
  const state = createPriceActionSetupState();
  if (!Array.isArray(bars) || !(tickSize > 0) || throughIndex < 0) return state;
  const start = Math.max(PRICE_ACTION_RULES.lookbackBars + 2, throughIndex - 59);
  for (let index = start; index <= throughIndex && index < bars.length; index += 1) {
    const epoch = epochOf(bars[index]);
    stepPaForwardBar(bars, index, state, {
      tickSize,
      spread: spreadByM5Epoch.get(epoch) ?? 0,
    });
  }
  return state;
}

export function buildPaForwardPosition(signal, quote, tickSize) {
  if (!signal || !quote || !(tickSize > 0)) return { ok: false, reason: "entry_quote_unavailable" };
  const spread = Number(quote.ask_open) - Number(quote.bid_open);
  const bidOpen = Number(quote.bid_open);
  const askOpen = Number(quote.ask_open);
  if (!(bidOpen > 0) || !(askOpen >= bidOpen) || !(spread >= 0)) {
    return { ok: false, reason: "invalid_bid_ask_quote" };
  }
  const entry = bidOpen - tickSize * PA_FORWARD_STRATEGY.slippageTicksPerSide;
  const rawRisk = Number(signal.base_stop) - entry;
  if (!(rawRisk > 0) || rawRisk > Number(signal.average_range) * PRICE_ACTION_RULES.maxStopRangeR) {
    return { ok: false, reason: "invalid_structural_stop" };
  }
  const risk = rawRisk * PA_FORWARD_STRATEGY.stopMultiplier;
  const roundTripCost = spread + tickSize * PA_FORWARD_STRATEGY.slippageTicksPerSide * 2
    + Math.max(entry, 0) * PA_FORWARD_STRATEGY.commissionPctPerSide * 2 / 100;
  const costR = roundTripCost / risk;
  if (!(risk > 0) || costR > PA_FORWARD_STRATEGY.maxCostR) {
    return { ok: false, reason: "entry_cost_above_limit", spread, costR, entry, risk };
  }
  return {
    ok: true,
    position: {
      entry,
      stop: entry + risk,
      tp1: entry - risk * PA_FORWARD_STRATEGY.tp1R,
      tp2: entry - risk * PA_FORWARD_STRATEGY.tp2R,
      risk,
      entry_spread: spread,
      cost_r: costR,
      remaining_fraction: 1,
      tp1_taken: 0,
      realized_r: 0,
      bars_held: 0,
      last_processed_minute: Number(signal.entry_epoch) - 60,
      status: "OPEN",
      outcome_reason: null,
    },
  };
}

export function advancePaForwardPosition(position, quoteBars, tickSize) {
  if (!position || position.status !== "OPEN" || !(tickSize > 0)) return position;
  let next = { ...position };
  const pending = (Array.isArray(quoteBars) ? quoteBars : [])
    .filter((bar) => Number(bar.minute_epoch) > Number(next.last_processed_minute))
    .sort((a, b) => Number(a.minute_epoch) - Number(b.minute_epoch));
  for (const quote of pending) {
    const minute = Number(quote.minute_epoch);
    if (minute > Number(next.last_processed_minute) + 60) {
      next.status = "DATA_GAP";
      next.outcome_reason = "missing_bid_ask_minute";
      next.closed_at = new Date(minute * 1000).toISOString();
      break;
    }
    const askOpen = Number(quote.ask_open);
    const askHigh = Number(quote.ask_high);
    const askLow = Number(quote.ask_low);
    const askClose = Number(quote.ask_close);
    if (![askOpen, askHigh, askLow, askClose].every(Number.isFinite)) {
      next.status = "DATA_GAP";
      next.outcome_reason = "invalid_bid_ask_minute";
      next.closed_at = new Date(minute * 1000).toISOString();
      break;
    }
    next.bars_held += 1;
    const addRealized = (fill, fraction, slippage = 0) => {
      const executableFill = fill + slippage;
      next.realized_r += (Number(next.entry) - executableFill) / Number(next.risk) * fraction;
      next.remaining_fraction = Math.max(0, Number(next.remaining_fraction) - fraction);
    };

    const stopHit = askHigh >= Number(next.stop);
    const tp1Hit = askLow <= Number(next.tp1);
    const tp2Hit = askLow <= Number(next.tp2);
    // Bid/ask ticks are aggregated into M1 OHLC; the within-minute order remains
    // unknown, so stop wins a stop/target collision in this minute.
    if (stopHit) {
      addRealized(Math.max(Number(next.stop), askOpen), Number(next.remaining_fraction), tickSize);
      next.status = "CLOSED";
      next.outcome_reason = "SL";
    } else {
      if (tp1Hit && !next.tp1_taken) {
        const fraction = Math.min(PA_FORWARD_STRATEGY.tp1SizePct / 100, Number(next.remaining_fraction));
        addRealized(Math.min(Number(next.tp1), askOpen), fraction);
        next.tp1_taken = 1;
      }
      if (next.remaining_fraction > 0 && tp2Hit) {
        addRealized(Math.min(Number(next.tp2), askOpen), Number(next.remaining_fraction));
        next.status = "CLOSED";
        next.outcome_reason = "TP2";
      }
      if (next.status === "OPEN" && next.bars_held >= PA_FORWARD_STRATEGY.maxHoldMinutes) {
        addRealized(askClose, Number(next.remaining_fraction), tickSize);
        next.status = "CLOSED";
        next.outcome_reason = "TIME";
      }
    }
    next.last_processed_minute = minute;
    if (next.status === "CLOSED") {
      next.closed_at = new Date((minute + 60) * 1000).toISOString();
      break;
    }
  }
  return next;
}
