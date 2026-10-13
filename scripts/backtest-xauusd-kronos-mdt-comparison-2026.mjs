// Focused XAUUSD Deriv-Demo study. Signals are evaluated on completed M5 bars,
// with M15 trend context. Entries/exits are simulated on the following M1 bars.
// This is research code; reconstructed ask prices and OHLC path ambiguity remain.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const DAY = 86_400_000;
const POINT = 0.01; // MT5 XAUUSD digits=2, point=0.01
const SLIPPAGE = POINT; // one point each side
const LOOKBACK = 20;
const MAX_HOLD = 60;
const MAX_COST_R = 0.15;
const WARMUP = 30 * DAY;
const FOLD = 50 * DAY;
const FOLD_COUNT = 5;
const COST_MULTIPLIERS = [1, 1.5, 2];

function loadCsv(name) {
  const rows = readFileSync(join(DIR, name), "utf8").trim().split(/\r?\n/);
  rows.shift();
  return rows.map((row) => {
    const [timestamp, open, high, low, close, volume] = row.split(",");
    return { time: Date.parse(timestamp), open: +open, high: +high, low: +low, close: +close, volume: +volume };
  });
}

const bid = loadCsv("XAUUSD_M1_bid.csv");
const ask = loadCsv("XAUUSD_M1_ask.csv");
const askMap = new Map(ask.map((bar) => [bar.time, bar]));
const minuteBars = bid.flatMap((bar) => {
  const a = askMap.get(bar.time);
  if (!a) return [];
  return [{ ...bar, spread: Math.max(0, a.close - bar.close) }];
});

function resample(bars, minutes) {
  const ms = minutes * MINUTE;
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / ms) * ms;
    const group = groups.get(start) ?? [];
    group.push(bar);
    groups.set(start, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, group]) => {
    if (group.length !== minutes || group.some((bar, i) => bar.time !== time + i * MINUTE)) return [];
    return [{ time, open: group[0].open, high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)), close: group.at(-1).close,
      volume: group.reduce((sum, b) => sum + b.volume, 0) }];
  });
}

const m5 = resample(minuteBars, 5);
const m15 = resample(minuteBars, 15);

function ema(values, length) {
  const out = Array(values.length).fill(Number.NaN);
  const alpha = 2 / (length + 1);
  let value = Number.NaN;
  for (let i = 0; i < values.length; i += 1) {
    value = Number.isFinite(value) ? alpha * values[i] + (1 - alpha) * value : values[i];
    out[i] = value;
  }
  return out;
}

function atr(bars, length = 14) {
  const tr = bars.map((bar, i) => i === 0 ? bar.high - bar.low : Math.max(
    bar.high - bar.low,
    Math.abs(bar.high - bars[i - 1].close),
    Math.abs(bar.low - bars[i - 1].close),
  ));
  const out = Array(bars.length).fill(Number.NaN);
  let value = Number.NaN;
  for (let i = 0; i < tr.length; i += 1) {
    if (i === length - 1) value = tr.slice(0, length).reduce((sum, x) => sum + x, 0) / length;
    else if (i >= length) value = (value * (length - 1) + tr[i]) / length;
    if (i >= length - 1) out[i] = value;
  }
  return out;
}

const m5Atr = atr(m5);
const m5Ema20 = ema(m5.map((b) => b.close), 20);
const ema20 = ema(m15.map((b) => b.close), 20);
const ema50 = ema(m15.map((b) => b.close), 50);
const m15Trend = m15.map((bar, i) => {
  if (i < 2) return 0;
  if (bar.close > ema20[i] && ema20[i] > ema50[i] && ema20[i] > ema20[i - 2]) return 1;
  if (bar.close < ema20[i] && ema20[i] < ema50[i] && ema20[i] < ema20[i - 2]) return -1;
  return 0;
});

// MDT proxy: measure the complete 23:00-23:54 New York M1 range and attach it
// to the next midnight date. The public TradingView description does not specify
// one unique entry rule or all ratios, so this comparison tests a declared 0.5x
// range extension as a sweep/reclaim confluence, not a byte-for-byte MDT clone.
const nyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function nyParts(time) {
  return Object.fromEntries(nyFormatter.formatToParts(new Date(time))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}
function nextDateKey(year, month, day) {
  const next = new Date(Date.UTC(+year, +month - 1, +day + 1));
  return next.toISOString().slice(0, 10);
}
const mdtRanges = new Map();
for (const bar of minuteBars) {
  const parts = nyParts(bar.time);
  if (parts.hour !== "23" || +parts.minute >= 55) continue;
  const anchorDate = nextDateKey(parts.year, parts.month, parts.day);
  const range = mdtRanges.get(anchorDate) ?? { high: Number.NEGATIVE_INFINITY,
    low: Number.POSITIVE_INFINITY, count: 0 };
  range.high = Math.max(range.high, bar.high);
  range.low = Math.min(range.low, bar.low);
  range.count += 1;
  mdtRanges.set(anchorDate, range);
}
for (const [date, range] of mdtRanges) {
  if (range.count !== 55) mdtRanges.delete(date);
}

function nyDateKey(time) {
  const parts = nyParts(time);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function candleConfirms(bar, direction) {
  const range = Math.max(bar.high - bar.low, POINT);
  const body = Math.abs(bar.close - bar.open);
  if (direction === 1) {
    const lowerWick = Math.min(bar.open, bar.close) - bar.low;
    return bar.close > bar.open && bar.close >= bar.low + range * 0.62
      && lowerWick >= Math.max(body * 0.7, range * 0.2);
  }
  const upperWick = bar.high - Math.max(bar.open, bar.close);
  return bar.close < bar.open && bar.close <= bar.high - range * 0.62
    && upperWick >= Math.max(body * 0.7, range * 0.2);
}

const variants = [
  { key: "sweep_trend_session", label: "Balayage/reprise M5 + tendance M15 + 07-17 UTC", setup: "sweep", trend: true, session: true },
  { key: "sweep_trend_allhours", label: "Balayage/reprise M5 + tendance M15, toute heure", setup: "sweep", trend: true, session: false },
  { key: "sweep_session_notrend", label: "Balayage/reprise M5 + 07-17 UTC, sans filtre M15", setup: "sweep", trend: false, session: true },
  { key: "retest_trend_session", label: "Cassure/retest M5 + tendance M15 + 07-17 UTC", setup: "retest", trend: true, session: true },
  { key: "pullback_trend_session", label: "Pullback EMA20 M5 + tendance M15 + 07-17 UTC", setup: "pullback", trend: true, session: true },
  { key: "asia_sweep_fvg_retest", label: "Sweep range Asie + displacement/FVG + retest + tendance M15", setup: "fvg_retrace", trend: true, session: true },
  { key: "range20_sweep_fvg_retest", label: "KRONOS PA · sans MDT", setup: "fvg_retrace", trend: false, session: true, mdt: false },
  { key: "pa_with_mdt_proxy", label: "KRONOS PA + MDT proxy · sweep au-delà de ±0,5 range", setup: "fvg_retrace", trend: false, session: true, mdt: true },
];
const diagnosticCounts = {};

function buildSignals(variant) {
  const signals = new Map();
  let m15Index = -1;
  let armed = null;
  let swept = null;
  const diag = { liquidityReclaims: 0, alignedReclaims: 0, displacements: 0, armedFvgs: 0, confirmedRetests: 0,
    completeMdtRanges: mdtRanges.size, mdtLongReclaims: 0, mdtShortReclaims: 0 };
  const asiaRanges = new Map();
  for (const bar of m5) {
    const date = new Date(bar.time);
    const hour = date.getUTCHours();
    if (hour >= 7) continue;
    const key = date.toISOString().slice(0, 10);
    const range = asiaRanges.get(key) ?? { high: Number.NEGATIVE_INFINITY, low: Number.POSITIVE_INFINITY };
    range.high = Math.max(range.high, bar.high);
    range.low = Math.min(range.low, bar.low);
    asiaRanges.set(key, range);
  }
  for (let i = LOOKBACK + 2; i < m5.length; i += 1) {
    const bar = m5[i];
    const signalEnd = bar.time + 5 * MINUTE;
    while (m15Index + 1 < m15.length && m15[m15Index + 1].time + 15 * MINUTE <= signalEnd) m15Index += 1;
    const directionContext = m15Index >= 0 ? m15Trend[m15Index] : 0;
    const hour = new Date(variant.sessionUseBarStart ? bar.time : signalEnd).getUTCHours();
    if (variant.session && !(hour >= 7 && hour < 17)) continue;
    const previous = m5.slice(i - LOOKBACK, i);
    const priorLow = Math.min(...previous.map((x) => x.low));
    const priorHigh = Math.max(...previous.map((x) => x.high));
    const range = m5Atr[i];
    if (!(range > 0)) continue;
    const mdtRange = mdtRanges.get(nyDateKey(bar.time));
    const mdtSpan = mdtRange ? mdtRange.high - mdtRange.low : Number.NaN;
    const mdtLowerExtension = mdtRange ? mdtRange.low - mdtSpan * 0.5 : Number.NaN;
    const mdtUpperExtension = mdtRange ? mdtRange.high + mdtSpan * 0.5 : Number.NaN;

    let direction = 0;
    let stop = Number.NaN;
    if (variant.setup === "fvg_retrace") {
      const dateKey = new Date(bar.time).toISOString().slice(0, 10);
      const asia = asiaRanges.get(dateKey);
      const liquidityRange = variant.key.startsWith("asia_") ? asia : { high: priorHigh, low: priorLow };
      if (armed && (i > armed.expires || (armed.direction === 1 && bar.low <= armed.stop)
        || (armed.direction === -1 && bar.high >= armed.stop))) armed = null;
      if (armed && i > armed.index) {
        const midpointTouched = bar.low <= armed.mid && bar.high >= armed.mid;
        if (armed.direction === 1 && midpointTouched
          && bar.close > armed.mid && bar.close > bar.open) {
          diag.confirmedRetests += 1;
          direction = 1;
          stop = armed.stop;
          armed = null;
        } else if (armed.direction === -1 && midpointTouched
          && bar.close < armed.mid && bar.close < bar.open) {
          diag.confirmedRetests += 1;
          direction = -1;
          stop = armed.stop;
          armed = null;
        }
      }
      const rangeAvailable = variant.key.startsWith("asia_") ? Boolean(asia) : true;
      const m15RegimeAllowed = variant.allowNeutral || directionContext !== 0;
      if (!armed && direction === 0 && rangeAvailable && m15RegimeAllowed && hour >= 7 && hour < 17 && i >= 5) {
        const body = Math.abs(bar.close - bar.open);
        const swingHigh = Math.max(...m5.slice(i - 5, i).map((x) => x.high));
        const swingLow = Math.min(...m5.slice(i - 5, i).map((x) => x.low));
        if (swept && (i > swept.expires || (swept.direction === 1 && bar.low <= swept.extreme)
          || (swept.direction === -1 && bar.high >= swept.extreme))) swept = null;
        const bullishDisplacement = bar.close > bar.open && body >= range * 0.6 && bar.close > swingHigh
          && bar.low > m5[i - 2].high && bar.close >= bar.low + (bar.high - bar.low) * 0.75;
        const bearishDisplacement = bar.close < bar.open && body >= range * 0.6 && bar.close < swingLow
          && bar.high < m5[i - 2].low && bar.close <= bar.high - (bar.high - bar.low) * 0.75;
        if (bullishDisplacement || bearishDisplacement) diag.displacements += 1;
        if (swept?.direction === 1 && (!variant.trend || directionContext === 1) && i > swept.index && bullishDisplacement) {
          diag.armedFvgs += 1;
          const zoneLow = m5[i - 2].high;
          const zoneHigh = bar.low;
          armed = { direction: 1, zoneLow, zoneHigh, mid: (zoneLow + zoneHigh) / 2,
            stop: swept.extreme - Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
          swept = null;
        } else if (swept?.direction === -1 && (!variant.trend || directionContext === -1) && i > swept.index && bearishDisplacement) {
          diag.armedFvgs += 1;
          const zoneLow = bar.high;
          const zoneHigh = m5[i - 2].low;
          armed = { direction: -1, zoneLow, zoneHigh, mid: (zoneLow + zoneHigh) / 2,
            stop: swept.extreme + Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
          swept = null;
        } else if (!swept && liquidityRange && (!variant.trend || directionContext === 1)
          && (!variant.mdt || (mdtRange && bar.low < mdtLowerExtension && bar.close > mdtLowerExtension))
          && bar.low < liquidityRange.low && bar.close > liquidityRange.low) {
          diag.liquidityReclaims += 1;
          diag.alignedReclaims += 1;
          if (variant.mdt) diag.mdtLongReclaims += 1;
          swept = { direction: 1, extreme: bar.low, index: i, expires: i + 5 };
        } else if (!swept && liquidityRange && (!variant.trend || directionContext === -1)
          && (!variant.mdt || (mdtRange && bar.high > mdtUpperExtension && bar.close < mdtUpperExtension))
          && bar.high > liquidityRange.high && bar.close < liquidityRange.high) {
          diag.liquidityReclaims += 1;
          diag.alignedReclaims += 1;
          if (variant.mdt) diag.mdtShortReclaims += 1;
          swept = { direction: -1, extreme: bar.high, index: i, expires: i + 5 };
        } else if (liquidityRange && ((!variant.trend || directionContext === 1) && bar.low < liquidityRange.low && bar.close > liquidityRange.low
          || (!variant.trend || directionContext === -1) && bar.high > liquidityRange.high && bar.close < liquidityRange.high)) {
          diag.liquidityReclaims += 1;
        }
      }
    } else if (variant.setup === "sweep") {
      if (bar.low < priorLow && bar.close > priorLow && candleConfirms(bar, 1)) direction = 1;
      else if (bar.high > priorHigh && bar.close < priorHigh && candleConfirms(bar, -1)) direction = -1;
      if (direction === 1) stop = bar.low - Math.max(range * 0.1, 2 * POINT);
      if (direction === -1) stop = bar.high + Math.max(range * 0.1, 2 * POINT);
    } else if (variant.setup === "pullback") {
      const body = Math.abs(bar.close - bar.open);
      const candleRange = Math.max(bar.high - bar.low, POINT);
      const bull = bar.close > bar.open && bar.close >= bar.low + candleRange * 0.72 && body >= range * 0.30;
      const bear = bar.close < bar.open && bar.close <= bar.high - candleRange * 0.72 && body >= range * 0.30;
      if (i >= 3 && directionContext === 1 && bar.low <= m5Ema20[i] + range * 0.15
        && bar.close > m5Ema20[i] && bull) {
        direction = 1;
        stop = Math.min(m5[i].low, m5[i - 1].low, m5[i - 2].low) - Math.max(range * 0.1, 2 * POINT);
      } else if (i >= 3 && directionContext === -1 && bar.high >= m5Ema20[i] - range * 0.15
        && bar.close < m5Ema20[i] && bear) {
        direction = -1;
        stop = Math.max(m5[i].high, m5[i - 1].high, m5[i - 2].high) + Math.max(range * 0.1, 2 * POINT);
      }
    } else {
      const tolerance = Math.max(range * 0.2, 2 * POINT);
      if (armed && (i - armed.index > 6
        || (armed.direction === 1 && bar.close < armed.level - tolerance)
        || (armed.direction === -1 && bar.close > armed.level + tolerance))) armed = null;
      const breakBuffer = Math.max(range * 0.05, 2 * POINT);
      if (!armed && bar.close > priorHigh + breakBuffer && m5[i - 1].close <= priorHigh + breakBuffer) {
        armed = { direction: 1, level: priorHigh, index: i };
      } else if (!armed && bar.close < priorLow - breakBuffer && m5[i - 1].close >= priorLow - breakBuffer) {
        armed = { direction: -1, level: priorLow, index: i };
      } else if (armed?.direction === 1 && i > armed.index
        && bar.low <= armed.level + tolerance && bar.low >= armed.level - tolerance * 2
        && bar.close > armed.level && candleConfirms(bar, 1)) {
        direction = 1;
        stop = bar.low - Math.max(range * 0.1, 2 * POINT);
        armed = null;
      } else if (armed?.direction === -1 && i > armed.index
        && bar.high >= armed.level - tolerance && bar.high <= armed.level + tolerance * 2
        && bar.close < armed.level && candleConfirms(bar, -1)) {
        direction = -1;
        stop = bar.high + Math.max(range * 0.1, 2 * POINT);
        armed = null;
      }
    }
    if (direction === 0 || (variant.trend && directionContext !== direction)) continue;
    const eventMinute = signalEnd - MINUTE;
    signals.set(eventMinute, { direction, stop, averageRange: range, signalTime: signalEnd });
  }
  diagnosticCounts[variant.key] = diag;
  return signals;
}

const firstTime = minuteBars[0].time;
const researchStart = firstTime + WARMUP;

function simulate(variant, spreadMultiple) {
  const signals = buildSignals(variant);
  const trades = [];
  let pending = null;
  let position = null;
  let previous = null;

  function closeAt(time, exitPrice, reason) {
    const pnl = position.direction === 1 ? exitPrice - position.entry : position.entry - exitPrice;
    trades.push({ direction: position.direction, entryTime: position.entryTime, exitTime: time,
      r: pnl / position.risk, reason, risk: position.risk, entry: position.entry });
    position = null;
  }

  for (let i = 0; i < minuteBars.length; i += 1) {
    const bar = minuteBars[i];
    const wasOpenAtStart = position !== null;
    let closedThisBar = false;
    if (position && previous && bar.time - previous.time > 10 * MINUTE) {
      const spread = previous.spread * spreadMultiple;
      closeAt(previous.time, position.direction === 1
        ? previous.close - SLIPPAGE
        : previous.close + spread + SLIPPAGE, "data_gap_flatten");
      closedThisBar = true;
    }
    if (!position && pending) {
      const spread = bar.spread * spreadMultiple;
      const entry = pending.direction === 1 ? bar.open + spread + SLIPPAGE : bar.open - SLIPPAGE;
      const risk = pending.direction === 1 ? entry - pending.stop : pending.stop - entry;
      const estimatedCost = spread + 2 * SLIPPAGE;
      if (risk > 0 && risk <= pending.averageRange * 3 && estimatedCost / risk <= MAX_COST_R) {
        position = { direction: pending.direction, entry, entryTime: bar.time, stop: pending.stop,
          target: entry + pending.direction * risk * 1.5, risk, startIndex: i };
      }
      pending = null;
    }
    if (position) {
      const spread = bar.spread * spreadMultiple;
      const askHigh = bar.high + spread;
      const askLow = bar.low + spread;
      const stopHit = position.direction === 1 ? bar.low <= position.stop : askHigh >= position.stop;
      const targetHit = position.direction === 1 ? bar.high >= position.target : askLow <= position.target;
      if (stopHit) {
        const stopFill = position.direction === 1
          ? Math.min(position.stop, bar.open) - SLIPPAGE
          : Math.max(position.stop, bar.open + spread) + SLIPPAGE;
        closeAt(bar.time, stopFill, "SL");
        closedThisBar = true;
      } else if (targetHit) {
        closeAt(bar.time, position.direction === 1 ? position.target - SLIPPAGE : position.target + SLIPPAGE, "TP1_5R");
        closedThisBar = true;
      } else if (bar.time - position.entryTime >= MAX_HOLD * MINUTE) {
        closeAt(bar.time, position.direction === 1 ? bar.close - SLIPPAGE : bar.close + spread + SLIPPAGE, "TIME");
        closedThisBar = true;
      }
    }
    if (!position && !wasOpenAtStart && !closedThisBar && signals.has(bar.time)) pending = signals.get(bar.time);
    previous = bar;
  }
  if (position && previous) closeAt(previous.time,
    position.direction === 1 ? previous.close - SLIPPAGE : previous.close + previous.spread * spreadMultiple + SLIPPAGE,
    "end_of_data");

  const kept = trades.filter((trade) => trade.entryTime >= researchStart
    && trade.entryTime < researchStart + FOLD_COUNT * FOLD);
  return kept.map((trade) => ({ ...trade,
    fold: Math.floor((trade.entryTime - researchStart) / FOLD),
  }));
}

function simulateR2(variant, spreadMultiple) {
  const signals = buildSignals(variant);
  const trades = [];
  const maxHoldMinutes = 30; // R2 configured to six M5 bars, matching a <=30-minute scalp.
  let pending = null;
  let position = null;
  let previous = null;

  function realizeAt(time, exitPrice, reason, fraction) {
    const part = Math.min(fraction, position.remaining);
    const signedPnl = (position.direction === 1 ? exitPrice - position.entry : position.entry - exitPrice) * part;
    position.realizedPricePnl += signedPnl;
    position.remaining -= part;
    if (position.remaining <= 1e-9) {
      trades.push({ direction: position.direction, entryTime: position.entryTime, exitTime: time,
        r: position.realizedPricePnl / position.risk, reason, risk: position.risk,
        entry: position.entry, tp1Reached: position.tp1Reached, tp2Reached: reason === "TP2_1_5R" });
      position = null;
    }
  }

  for (let i = 0; i < minuteBars.length; i += 1) {
    const bar = minuteBars[i];
    const wasOpenAtStart = position !== null;
    let closedThisBar = false;
    if (position && previous && bar.time - previous.time > 10 * MINUTE) {
      const spread = previous.spread * spreadMultiple;
      const exitPrice = position.direction === 1
        ? previous.close - SLIPPAGE : previous.close + spread + SLIPPAGE;
      realizeAt(previous.time, exitPrice, "data_gap_flatten", position.remaining);
      closedThisBar = true;
    }
    if (!position && pending) {
      const spread = bar.spread * spreadMultiple;
      const entry = pending.direction === 1 ? bar.open + spread + SLIPPAGE : bar.open - SLIPPAGE;
      const risk = pending.direction === 1 ? entry - pending.stop : pending.stop - entry;
      const estimatedCost = spread + 2 * SLIPPAGE;
      if (risk > 0 && risk <= pending.averageRange * 3 && estimatedCost / risk <= MAX_COST_R) {
        position = { direction: pending.direction, entry, entryTime: bar.time, stop: pending.stop,
          tp1: entry + pending.direction * risk, tp2: entry + pending.direction * risk * 1.5,
          risk, remaining: 1, realizedPricePnl: 0, tp1Reached: false };
      }
      pending = null;
    }
    if (position) {
      const spread = bar.spread * spreadMultiple;
      const askHigh = bar.high + spread;
      const askLow = bar.low + spread;
      const stopHit = position.direction === 1 ? bar.low <= position.stop : askHigh >= position.stop;
      const tp1Hit = position.direction === 1 ? bar.high >= position.tp1 : askLow <= position.tp1;
      const tp2Hit = position.direction === 1 ? bar.high >= position.tp2 : askLow <= position.tp2;
      if (stopHit) {
        const stopFill = position.direction === 1
          ? Math.min(position.stop, bar.open) - SLIPPAGE
          : Math.max(position.stop, bar.open + spread) + SLIPPAGE;
        realizeAt(bar.time, stopFill, "SL", position.remaining);
        closedThisBar = true;
      } else {
        if (!position.tp1Reached && tp1Hit) {
          position.tp1Reached = true;
          realizeAt(bar.time, position.direction === 1 ? position.tp1 - SLIPPAGE : position.tp1 + SLIPPAGE,
            "TP1_1R", 0.5);
        }
        if (position && tp2Hit) {
          realizeAt(bar.time, position.direction === 1 ? position.tp2 - SLIPPAGE : position.tp2 + SLIPPAGE,
            "TP2_1_5R", position.remaining);
          closedThisBar = true;
        } else if (position && bar.time + MINUTE - position.entryTime >= maxHoldMinutes * MINUTE) {
          const exitPrice = position.direction === 1
            ? bar.close - SLIPPAGE : bar.close + spread + SLIPPAGE;
          realizeAt(bar.time, exitPrice, "TIME", position.remaining);
          closedThisBar = true;
        }
      }
    }
    if (!position && !wasOpenAtStart && !closedThisBar && signals.has(bar.time)) pending = signals.get(bar.time);
    previous = bar;
  }
  if (position && previous) {
    const exitPrice = position.direction === 1
      ? previous.close - SLIPPAGE : previous.close + previous.spread * spreadMultiple + SLIPPAGE;
    realizeAt(previous.time, exitPrice, "end_of_data", position.remaining);
  }

  const kept = trades.filter((trade) => trade.entryTime >= researchStart
    && trade.entryTime < researchStart + FOLD_COUNT * FOLD);
  return kept.map((trade) => ({ ...trade, fold: Math.floor((trade.entryTime - researchStart) / FOLD) }));
}

function summarize(trades) {
  const wins = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const losses = trades.filter((t) => t.r < 0).reduce((s, t) => s + Math.abs(t.r), 0);
  let equityR = 0;
  let peakR = 0;
  let maxDdR = 0;
  for (const trade of trades) {
    equityR += trade.r;
    peakR = Math.max(peakR, equityR);
    maxDdR = Math.max(maxDdR, peakR - equityR);
  }
  return { trades: trades.length,
    winPct: trades.length ? Math.round(trades.filter((t) => t.r > 0).length / trades.length * 1000) / 10 : 0,
    avgR: trades.length ? +(trades.reduce((s, t) => s + t.r, 0) / trades.length).toFixed(3) : 0,
    totalR: +trades.reduce((s, t) => s + t.r, 0).toFixed(2),
    profitFactor: losses ? +(wins / losses).toFixed(3) : 0,
    maxDrawdownR: +maxDdR.toFixed(2),
    positiveFolds: Array.from({ length: FOLD_COUNT }, (_, i) => trades.filter((t) => t.fold === i))
      .filter((foldTrades) => foldTrades.length && foldTrades.reduce((s, t) => s + t.r, 0) > 0).length,
    folds: Array.from({ length: FOLD_COUNT }, (_, i) => {
      const group = trades.filter((t) => t.fold === i);
      return { trades: group.length, avgR: group.length ? +(group.reduce((s, t) => s + t.r, 0) / group.length).toFixed(3) : 0,
        totalR: +group.reduce((s, t) => s + t.r, 0).toFixed(2) };
    }),
    exits: Object.fromEntries(["SL", "TP1_5R", "TIME", "data_gap_flatten", "end_of_data"].map((reason) =>
      [reason, trades.filter((t) => t.reason === reason).length])),
  };
}

const results = [];
for (const variant of variants) {
  for (const spreadMultiple of COST_MULTIPLIERS) {
    const trades = simulate(variant, spreadMultiple);
    results.push({ key: variant.key, label: variant.label, spreadMultiple, ...summarize(trades) });
  }
}

// R2 scalping check: exact two PA arms, M15 neutrality allowed as in the Pine
// default, M5 session bar-open semantics, partial exits at 1R/1.5R, 30-minute cap.
const r2Variants = [
  { key: "r2_without_mdt", label: "Pine R2 · sans MDT", setup: "fvg_retrace", trend: false,
    session: true, mdt: false, allowNeutral: true, sessionUseBarStart: true },
  { key: "r2_with_mdt_proxy", label: "Pine R2 · avec MDT proxy", setup: "fvg_retrace", trend: false,
    session: true, mdt: true, allowNeutral: true, sessionUseBarStart: true },
];
const r2Results = [];
for (const variant of r2Variants) {
  for (const spreadMultiple of COST_MULTIPLIERS) {
    const trades = simulateR2(variant, spreadMultiple);
    r2Results.push({ key: variant.key, label: variant.label, spreadMultiple,
      ...summarize(trades),
      tp1HitTrades: trades.filter((trade) => trade.tp1Reached).length,
      tp2HitTrades: trades.filter((trade) => trade.tp2Reached).length,
      exitsByFinalReason: Object.fromEntries(["SL", "TP2_1_5R", "TIME", "data_gap_flatten", "end_of_data"]
        .map((reason) => [reason, trades.filter((trade) => trade.reason === reason).length])),
    });
  }
}

const output = {
  source: "Deriv-Demo MT5 historical XAUUSD M1 bid/ask approximations",
  period: { from: new Date(minuteBars[0].time).toISOString(), to: new Date(minuteBars.at(-1).time).toISOString(), researchStart: new Date(researchStart).toISOString() },
  data: { m1Bars: minuteBars.length, m5CompleteBars: m5.length, m15CompleteBars: m15.length,
    point: POINT, spreadMedian: [...minuteBars].sort((a, b) => a.spread - b.spread)[Math.floor(minuteBars.length * 0.5)]?.spread,
    spreadP75: [...minuteBars].sort((a, b) => a.spread - b.spread)[Math.floor(minuteBars.length * 0.75)]?.spread,
    completeMdtNightRanges: mdtRanges.size },
  rules: { entry: "R1 candidate: M5 sweep/reclaim of prior 20-bar high/low; within five bars, strong BOS displacement with a 3-candle FVG; enter the first confirmed midpoint retest within 12 bars. Neutral M15 conditions are excluded, but direction need not align with M15. Fixed UTC 07-17 session; local fill next M1 open.",
    mdtProxy: "Compare identical PA entries with/without requiring a sweep beyond and reclaim of the first 0.5x extension of the complete 23:00-23:54 America/New_York M1 range, assigned to the next New York calendar date. This is an explicit proxy, not exact source-code reproduction of the TradingView MDT script.",
    r2PartialExit: "Separate current-Pine check: close 50% at +1R and the remaining 50% at +1.5R, or close remainder at original SL / time stop; maximum hold 30 minutes (six M5 bars). One trade at a time.",
    exit: "Full exit at stop or +1.5R, whichever is reached first, else close after 60 minutes; stops take priority if both levels occur in one M1 candle",
    stop: "Beyond signal sweep/retest extreme plus max(0.1 ATR14 M5, 0.02 USD)",
    costs: "Entry and exit use reconstructed per-minute bid/ask spread; 1 point ($0.01) slippage per side; stress reruns at 1.5x/2x spread; commission 0 assumed",
    foldMethod: "30-day warm-up plus five chronological 50-day folds; same rules/parameters in every fold" },
  variants: results,
  r2PartialVariants: r2Results,
  signalDiagnostics: diagnosticCounts,
  limitations: ["The MT5 source is Deriv-Demo, not a verified live account feed.",
    "Historical ask OHLC is reconstructed from bid OHLC and per-minute spread; no tick-by-tick order path is available.",
    "M15 trend uses completed candles only. Session filter is fixed UTC and does not adjust for daylight-saving time.",
    "Commission, swap, margin, minimum lot, order rejection and real slippage beyond the explicit 1-point assumption are not modeled.",
    "The MDT confluence is a declared proxy based on a 0.5x night-range extension; the public TradingView description does not fully specify one systematic entry model or all projection ratios.",
    "This experiment retains the R1 single full exit at 1.5R to isolate the MDT filter; it does not test the R2 split TP1/TP2 management.",
    "The Pine strategy fills on the next M5 bar in TradingView, while local research enters on the next available M1 bar. Pine's spread input only filters trades; it is not automatically debited from Strategy Tester P&L.",
    "The folds are historical validation, not a future untouched test; selecting a winner after seeing these results creates selection bias."],
};

writeFileSync(join(DIR, "kronos-xauusd-mdt-comparison-2026-results.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
const md = [
  "# KRONOS XAUUSD ciblé — Deriv-Demo MT5 — 2026 YTD",
  "",
  `Période source : ${output.period.from} à ${output.period.to}. Données M1 : ${minuteBars.length}; M5 complet : ${m5.length}; M15 complet : ${m15.length}. Spread médian ≈ $${output.data.spreadMedian.toFixed(3)}, p75 ≈ $${output.data.spreadP75.toFixed(3)}.`,
  "",
  "Chaque configuration est rejouée avec le spread historique normal, puis 1,5x et 2x. Exécution et sorties simulées à partir des bougies M1.",
  "",
  "| Configuration | Spread | Trades | Win % | R/trade | Total R | PF | DD max R | Plis + | Pli 1 | Pli 2 | Pli 3 | Pli 4 | Pli 5 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const r of results) md.push(`| ${r.label} | ${r.spreadMultiple}x | ${r.trades} | ${r.winPct} | ${r.avgR} | ${r.totalR} | ${r.profitFactor} | ${r.maxDrawdownR} | ${r.positiveFolds}/5 | ${r.folds.map((f) => `${f.trades} / ${f.avgR}`).join(" | ")} |`);
const paNoMdt = results.find((r) => r.key === "range20_sweep_fvg_retest" && r.spreadMultiple === 1);
const paWithMdt = results.find((r) => r.key === "pa_with_mdt_proxy" && r.spreadMultiple === 1);
const paWithMdtStress = results.find((r) => r.key === "pa_with_mdt_proxy" && r.spreadMultiple === 2);
const mdtDiag = diagnosticCounts.pa_with_mdt_proxy;
md.push("", "## Comparaison ciblée (spread Deriv observé)", "",
  `Sans MDT : ${paNoMdt.trades} trades, ${paNoMdt.winPct}% gagnants, ${paNoMdt.avgR} R/trade, PF ${paNoMdt.profitFactor}, ${paNoMdt.positiveFolds}/5 folds positifs.`,
  `Avec MDT proxy : ${paWithMdt.trades} trades, ${paWithMdt.winPct}% gagnants, ${paWithMdt.avgR} R/trade, PF ${paWithMdt.profitFactor}, ${paWithMdt.positiveFolds}/5 folds positifs.`,
  `Au spread x2, la variante MDT proxy donne ${paWithMdtStress.trades} trades, ${paWithMdtStress.avgR} R/trade et PF ${paWithMdtStress.profitFactor}.`,
  `Le filtre a trouvé ${mdtDiag.mdtLongReclaims} sweeps/reprises MDT longs et ${mdtDiag.mdtShortReclaims} shorts; ${mdtDiag.completeMdtRanges} plages nocturnes M1 complètes ont été disponibles.`,
  "Interprétation : le filtre garde les règles PA identiques et ajoute seulement une condition de localisation MDT. La description publique du script ne définit pas une entrée unique; le test MDT est donc un proxy explicite, pas une réplication exacte.");
const range20Base = results.find((r) => r.key === "range20_sweep_fvg_retest" && r.spreadMultiple === 1);
const range20Double = results.find((r) => r.key === "range20_sweep_fvg_retest" && r.spreadMultiple === 2);
const asiaBase = results.find((r) => r.key === "asia_sweep_fvg_retest" && r.spreadMultiple === 1);
md.push("", "## R1 candidate verdict", "",
  `The R1 entry model appears in Kronos_XAUUSD_Sweep_FVG_Retest_Research_v1.pine. On the closest local Deriv-Demo simulation (M5 sweep of prior 20 bars, displacement/BOS/FVG within 5 bars, midpoint retest within 12 bars; neutral M15 regimes excluded, but trade direction is not required to align), the result was ${range20Base.trades} trades, ${range20Base.avgR} R/trade, PF ${range20Base.profitFactor}, positive in ${range20Base.positiveFolds}/5 chronological folds; at 2x spread it was ${range20Double.avgR} R/trade. This does not establish an edge.`,
  `The stricter Asia-range version generated ${asiaBase.trades} trades, so it has no useful performance estimate on this sample. All XAU variants in this research are exploratory; none is approved as a profitable live setup.`,
  "The Pine Strategy Tester shows gross simulated results unless costs are configured in Strategy Properties. The spread input in the script is only an entry filter; use this local report for the Deriv-spread-adjusted estimate.");
md.push("", "## Règles testées", "", "- Balayage/reprise : le M5 dépasse le plus haut/bas des 20 bougies précédentes, clôture de nouveau dans le range et forme un rejet confirmé.",
  "- Cassure/retest : clôture au-delà du range des 20 bougies, puis retest tenu dans les 6 bougies suivantes avec rejet confirmé.",
  "- Pullback EMA20 : en régime M15 aligné, le prix teste l’EMA20 M5 puis clôture à nouveau dans le sens de tendance avec un corps d’au moins 0,3 ATR.",
  "- Variante stricte Sweep Asie/FVG : balayage du range Asie, displacement/BOS et FVG dans les bougies suivantes, puis retest; aucun trade sur l'échantillon, donc résultat non concluant.",
  "- Modèle R1 étudié : sweep/reprise des extrêmes des 20 M5 précédentes, displacement/BOS et FVG sous 5 bougies, retest du milieu de FVG sous 12 bougies; filtre horaire UTC 07-17, M15 affiché comme contexte sans filtre directionnel.",
  "- Filtre de régime M15 : EMA20 au-dessus/au-dessous de l’EMA50, cours du bon côté de l’EMA20 et EMA20 orientée dans le sens du trade.",
  "- Sortie entière au stop ou à +1,5R; sinon clôture après 60 minutes. Un seul trade à la fois.",
  "- Coût d’entrée/sortie basé sur les spreads historiques par minute, slippage simulé d’un point ($0,01) par côté, commission nulle supposée.",
  "", "## Limites", "", ...output.limitations.map((x) => `- ${x}`), "");
writeFileSync(join(DIR, "KRONOS_XAUUSD_MDT_COMPARISON_2026_REPORT.md"), md.join("\n"), "utf8");
const r2NoMdtBase = r2Results.find((r) => r.key === "r2_without_mdt" && r.spreadMultiple === 1);
const r2WithMdtBase = r2Results.find((r) => r.key === "r2_with_mdt_proxy" && r.spreadMultiple === 1);
const r2NoMdtDouble = r2Results.find((r) => r.key === "r2_without_mdt" && r.spreadMultiple === 2);
const r2WithMdtDouble = r2Results.find((r) => r.key === "r2_with_mdt_proxy" && r.spreadMultiple === 2);
const r2Md = [
  "# KRONOS XAUUSD R2 · backtest scalping MDT · Deriv-Demo · 2026 YTD", "",
  `Période ${output.period.from} à ${output.period.to}. ${minuteBars.length} bougies M1; ${m5.length} M5 complets; ${mdtRanges.size} plages MDT complètes. Spread médian $${output.data.spreadMedian.toFixed(3)}.`, "",
  "Même modèle d'entrée PA sur les deux variantes. Sorties inspirées du Pine R2 : 50 % à +1R, 50 % à +1,5R; stop structurel inchangé; sortie temps à 30 min (6 M5). Exécution sur les bougies M1 suivantes; spread historique + 1 point de slippage par côté; commission supposée nulle.", "",
  "MDT proxy: plage M1 23:00–23:54 America/New_York, attachée à la date de minuit suivante. Le long exige un sweep sous Low - 0,5×range puis une clôture de reprise au-dessus; le short exige l'inverse au-dessus de High + 0,5×range. Ce proxy n'est pas une reproduction certifiée du code public MDT.", "",
  "| Variante | Spread | Trades | Win % net/setup | TP1 touchés | TP1 % | TP2 touchés | TP2 % | R/trade | PF | DD max R | Plis + |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
];
for (const row of r2Results) {
  const tp1Pct = row.trades ? +(100 * row.tp1HitTrades / row.trades).toFixed(1) : 0;
  const tp2Pct = row.trades ? +(100 * row.tp2HitTrades / row.trades).toFixed(1) : 0;
  r2Md.push(`| ${row.label} | ${row.spreadMultiple}x | ${row.trades} | ${row.winPct} | ${row.tp1HitTrades} | ${tp1Pct} | ${row.tp2HitTrades} | ${tp2Pct} | ${row.avgR} | ${row.profitFactor} | ${row.maxDrawdownR} | ${row.positiveFolds}/5 |`);
}
r2Md.push("", "## Résumé au spread observé", "",
  `Sans MDT : ${r2NoMdtBase.trades} setups; ${r2NoMdtBase.tp1HitTrades}/${r2NoMdtBase.trades} ont touché TP1 (${r2NoMdtBase.trades ? +(100 * r2NoMdtBase.tp1HitTrades / r2NoMdtBase.trades).toFixed(1) : 0}%); ${r2NoMdtBase.tp2HitTrades}/${r2NoMdtBase.trades} ont touché TP2; P&L moyen ${r2NoMdtBase.avgR}R/setup, PF ${r2NoMdtBase.profitFactor}, folds positifs ${r2NoMdtBase.positiveFolds}/5.`,
  `Avec MDT proxy : ${r2WithMdtBase.trades} setups; ${r2WithMdtBase.tp1HitTrades}/${r2WithMdtBase.trades} ont touché TP1 (${r2WithMdtBase.trades ? +(100 * r2WithMdtBase.tp1HitTrades / r2WithMdtBase.trades).toFixed(1) : 0}%); ${r2WithMdtBase.tp2HitTrades}/${r2WithMdtBase.trades} ont touché TP2; P&L moyen ${r2WithMdtBase.avgR}R/setup, PF ${r2WithMdtBase.profitFactor}, folds positifs ${r2WithMdtBase.positiveFolds}/5.`,
  `Stress spread x2 : sans MDT ${r2NoMdtDouble.trades} trades, ${r2NoMdtDouble.avgR}R, PF ${r2NoMdtDouble.profitFactor}; MDT ${r2WithMdtDouble.trades} trades, ${r2WithMdtDouble.avgR}R, PF ${r2WithMdtDouble.profitFactor}.`,
  "Ces fréquences décrivent cet échantillon historique; elles ne donnent pas la probabilité fiable du prochain setup. Une petite taille d'échantillon rend le taux très incertain.",
  "Le jeu teste le comportement d'entrée R2/MDT en stratégie locale, pas l'exécution de TradingView ou de Deriv en réel. L'ask M1 est reconstruit depuis spread M1; pas de ticks, commission ni rejets broker.",
  "Règles, résultats complets et chronologie sont dans le fichier JSON associé.", "");
writeFileSync(join(DIR, "KRONOS_XAUUSD_R2_MDT_COMPARISON_2026_REPORT.md"), r2Md.join("\n"), "utf8");
writeFileSync(join(DIR, "kronos-xauusd-r2-mdt-comparison-2026-results.json"), JSON.stringify({
  source: output.source, period: output.period, data: output.data, rules: output.rules,
  variants: r2Results,
  signalDiagnostics: { r2_without_mdt: diagnosticCounts.r2_without_mdt, r2_with_mdt_proxy: diagnosticCounts.r2_with_mdt_proxy },
  limitations: output.limitations,
}, null, 2) + "\n", "utf8");
console.log(`Saved XAUUSD MDT comparison results for ${results.length} runs.`);
