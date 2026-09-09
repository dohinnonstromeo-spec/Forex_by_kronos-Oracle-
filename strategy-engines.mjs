// Independent, deterministic evidence engines for the autonomous swing robot.
// This file deliberately has no database, network, or broker dependency so the
// same rules can be exercised by a local backtest without touching production.

export const AUTO_ANALYSIS_STYLES = Object.freeze([
  "legacy_momentum",
  "price_action",
  "ichimoku",
  "smc",
  "wyckoff",
  "mixte",
]);

export const DEFAULT_AUTO_ANALYSIS_STYLE = "legacy_momentum";
export const EXPERIMENTAL_AUTO_ANALYSIS_STYLES = Object.freeze([
  "price_action",
  "ichimoku",
  "smc",
  "wyckoff",
  "mixte",
]);

const STYLE_LABELS = Object.freeze({
  legacy_momentum: "Legacy SMA/RSI",
  price_action: "Price Action",
  ichimoku: "Ichimoku",
  smc: "SMC",
  wyckoff: "Wyckoff",
  mixte: "Mixte",
});

export function normalizeAutoAnalysisStyle(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return AUTO_ANALYSIS_STYLES.includes(normalized) ? normalized : null;
}

export function autoAnalysisStyleLabel(value) {
  const normalized = normalizeAutoAnalysisStyle(value) || DEFAULT_AUTO_ANALYSIS_STYLE;
  return STYLE_LABELS[normalized] || STYLE_LABELS[DEFAULT_AUTO_ANALYSIS_STYLE];
}

export function isExperimentalAutoAnalysisStyle(value) {
  const normalized = normalizeAutoAnalysisStyle(value);
  return Boolean(normalized && EXPERIMENTAL_AUTO_ANALYSIS_STYLES.includes(normalized));
}

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function barsWithRange(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .map((bar) => {
      const close = finite(bar?.close);
      const high = finite(bar?.high);
      const low = finite(bar?.low);
      if (close == null || high == null || low == null || high < low) return null;
      return {
        open: finite(bar?.open),
        close,
        high,
        low,
        volume: finite(bar?.volume),
      };
    })
    .filter(Boolean);
}

function average(values = []) {
  const valid = values.map(finite).filter((value) => value != null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function highest(bars = []) {
  return bars.length ? Math.max(...bars.map((bar) => bar.high)) : null;
}

function lowest(bars = []) {
  return bars.length ? Math.min(...bars.map((bar) => bar.low)) : null;
}

function atr(bars, period = 14) {
  const values = bars.slice(-period).map((bar) => Math.max(0, bar.high - bar.low));
  return average(values);
}

function sma(bars, period) {
  return average(bars.slice(-period).map((bar) => bar.close));
}

function pivots(bars, span = 2) {
  const highs = [];
  const lows = [];
  for (let index = span; index < bars.length - span; index += 1) {
    const current = bars[index];
    const left = bars.slice(index - span, index);
    const right = bars.slice(index + 1, index + span + 1);
    if (current.high >= Math.max(...left.map((bar) => bar.high), ...right.map((bar) => bar.high))) {
      highs.push({ index, value: current.high });
    }
    if (current.low <= Math.min(...left.map((bar) => bar.low), ...right.map((bar) => bar.low))) {
      lows.push({ index, value: current.low });
    }
  }
  return { highs, lows };
}

function baseEvidenceSignal({
  style,
  direction,
  entry,
  stopReference,
  atrValue,
  confidence,
  evidence,
  indicators,
  reason,
}) {
  if (!["ACHAT", "VENTE"].includes(direction) || !(entry > 0) || !(atrValue > 0)) return null;
  const minimumRisk = Math.max(atrValue * 1.15, entry * 0.0012);
  const structuralRisk = Number.isFinite(stopReference)
    ? Math.abs(entry - stopReference)
    : 0;
  const risk = Math.max(minimumRisk, structuralRisk <= entry * 0.025 ? structuralRisk : 0);
  if (!(risk > 0) || risk > entry * 0.025) return null;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.6 : entry - risk * 1.6;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.5 : entry - risk * 2.5;
  return {
    direction,
    entree: entry,
    sl,
    tp1,
    tp2,
    rr: "1:2.0",
    confiance: Math.round(Math.max(70, Math.min(88, confidence))),
    technique: autoAnalysisStyleLabel(style),
    raison: reason,
    direct: true,
    suspended: false,
    style,
    styleScore: Math.round(Math.max(0, Math.min(100, confidence))),
    styleEvidence: [...new Set(evidence)].slice(0, 8),
    styleVersion: "evidence-v1",
    indicators: { ...indicators, atr: atrValue },
  };
}

function detectPriceAction(symbol, price, history) {
  const bars = barsWithRange(history);
  if (bars.length < 35) return null;
  const last = bars.at(-1);
  const previous = bars.at(-2);
  const entry = finite(price?.price);
  if (!(entry > 0) || !last || !previous) return null;
  const recent = bars.slice(-31, -1);
  const support = lowest(recent);
  const resistance = highest(recent);
  const open = last.open ?? previous.close;
  const previousOpen = previous.open ?? bars.at(-3)?.close ?? previous.close;
  const body = Math.abs(last.close - open);
  const range = Math.max(last.high - last.low, entry * 0.00001);
  const lowerWick = Math.min(open, last.close) - last.low;
  const upperWick = last.high - Math.max(open, last.close);
  const bullishRejection = last.close > open && lowerWick >= Math.max(body * 1.35, range * 0.25) && last.close >= last.low + range * 0.62;
  const bearishRejection = last.close < open && upperWick >= Math.max(body * 1.35, range * 0.25) && last.close <= last.high - range * 0.62;
  const bullishEngulfing = previous.close < previousOpen && last.close > open && last.close >= previousOpen && open <= previous.close;
  const bearishEngulfing = previous.close > previousOpen && last.close < open && last.close <= previousOpen && open >= previous.close;
  const bullishBreak = last.close > resistance * 1.0002;
  const bearishBreak = last.close < support * 0.9998;
  const trend = sma(bars, 10) >= sma(bars, 30) ? "ACHAT" : "VENTE";
  const bullishEvidence = [
    bullishBreak && "breakout resistance",
    bullishEngulfing && "engulfing haussier",
    bullishRejection && "rejet du support",
    trend === "ACHAT" && "structure de clotures haussiere",
  ].filter(Boolean);
  const bearishEvidence = [
    bearishBreak && "breakout support",
    bearishEngulfing && "engulfing baissier",
    bearishRejection && "rejet de la resistance",
    trend === "VENTE" && "structure de clotures baissiere",
  ].filter(Boolean);
  const direction = bullishEvidence.length >= bearishEvidence.length ? "ACHAT" : "VENTE";
  const evidence = direction === "ACHAT" ? bullishEvidence : bearishEvidence;
  const pattern = direction === "ACHAT"
    ? (bullishBreak || bullishEngulfing || bullishRejection)
    : (bearishBreak || bearishEngulfing || bearishRejection);
  if (!pattern || evidence.length < 2) return null;
  const atrValue = atr(bars);
  const stopReference = direction === "ACHAT" ? support : resistance;
  return baseEvidenceSignal({
    style: "price_action",
    direction,
    entry,
    stopReference,
    atrValue,
    confidence: 70 + evidence.length * 4,
    evidence,
    indicators: { support, resistance, patternCount: evidence.length },
    reason: "Price Action confirme: " + evidence.join(", ") + ".",
  });
}

function detectIchimoku(symbol, price, history) {
  const bars = barsWithRange(history);
  if (bars.length < 78) return null;
  const entry = finite(price?.price);
  if (!(entry > 0)) return null;
  const window = (period) => bars.slice(-period);
  const tenkan = (highest(window(9)) + lowest(window(9))) / 2;
  const kijun = (highest(window(26)) + lowest(window(26))) / 2;
  const spanB = (highest(window(52)) + lowest(window(52))) / 2;
  const spanA = (tenkan + kijun) / 2;
  const cloudTop = Math.max(spanA, spanB);
  const cloudBottom = Math.min(spanA, spanB);
  const chikouReference = bars.at(-27)?.close;
  const bullish = entry > cloudTop && tenkan > kijun && entry > chikouReference;
  const bearish = entry < cloudBottom && tenkan < kijun && entry < chikouReference;
  if (!bullish && !bearish) return null;
  const direction = bullish ? "ACHAT" : "VENTE";
  const evidence = direction === "ACHAT"
    ? ["prix au-dessus du nuage", "Tenkan au-dessus de Kijun", "Chikou au-dessus du prix"]
    : ["prix sous le nuage", "Tenkan sous Kijun", "Chikou sous le prix"];
  const atrValue = atr(bars);
  return baseEvidenceSignal({
    style: "ichimoku",
    direction,
    entry,
    stopReference: direction === "ACHAT" ? Math.min(kijun, cloudBottom) : Math.max(kijun, cloudTop),
    atrValue,
    confidence: 78,
    evidence,
    indicators: { tenkan, kijun, spanA, spanB, cloudTop, cloudBottom },
    reason: "Ichimoku confirme: " + evidence.join(", ") + ".",
  });
}

function detectSmc(symbol, price, history) {
  const bars = barsWithRange(history);
  if (bars.length < 45) return null;
  const entry = finite(price?.price);
  if (!(entry > 0)) return null;
  const structureBars = bars.slice(-90);
  const structure = pivots(structureBars, 2);
  if (structure.highs.length < 2 || structure.lows.length < 2) return null;
  const lastHigh = structure.highs.at(-1).value;
  const previousHigh = structure.highs.at(-2).value;
  const lastLow = structure.lows.at(-1).value;
  const previousLow = structure.lows.at(-2).value;
  const last = bars.at(-1);
  const firstGapBar = bars.at(-3);
  const bullishStructure = lastHigh > previousHigh && lastLow > previousLow;
  const bearishStructure = lastHigh < previousHigh && lastLow < previousLow;
  const bullishBos = last.close > lastHigh * 1.0002;
  const bearishBos = last.close < lastLow * 0.9998;
  const bullishSweep = last.low < lastLow * 0.9998 && last.close > lastLow;
  const bearishSweep = last.high > lastHigh * 1.0002 && last.close < lastHigh;
  const bullishFvg = firstGapBar.high < last.low;
  const bearishFvg = firstGapBar.low > last.high;
  const bullishEvidence = [
    bullishBos && "break of structure haussier",
    bullishStructure && "sommets et creux ascendants",
    bullishSweep && "liquidite sous le dernier creux",
    bullishFvg && "fair value gap haussier",
  ].filter(Boolean);
  const bearishEvidence = [
    bearishBos && "break of structure baissier",
    bearishStructure && "sommets et creux descendants",
    bearishSweep && "liquidite au-dessus du dernier sommet",
    bearishFvg && "fair value gap baissier",
  ].filter(Boolean);
  const bullishValid = bullishBos && (bullishStructure || bullishFvg) || bullishSweep && bullishFvg;
  const bearishValid = bearishBos && (bearishStructure || bearishFvg) || bearishSweep && bearishFvg;
  if (!bullishValid && !bearishValid) return null;
  const direction = bullishValid && !bearishValid ? "ACHAT" : bearishValid && !bullishValid ? "VENTE" : (bullishEvidence.length >= bearishEvidence.length ? "ACHAT" : "VENTE");
  const evidence = direction === "ACHAT" ? bullishEvidence : bearishEvidence;
  return baseEvidenceSignal({
    style: "smc",
    direction,
    entry,
    stopReference: direction === "ACHAT" ? lastLow : lastHigh,
    atrValue: atr(bars),
    confidence: 72 + Math.min(12, evidence.length * 4),
    evidence,
    indicators: { lastSwingHigh: lastHigh, lastSwingLow: lastLow, bullishBos, bearishBos, bullishFvg, bearishFvg },
    reason: "SMC confirme: " + evidence.join(", ") + ".",
  });
}

function detectWyckoff(symbol, price, history) {
  const bars = barsWithRange(history);
  if (bars.length < 50) return null;
  const entry = finite(price?.price);
  if (!(entry > 0)) return null;
  const volumeBars = bars.slice(-30);
  if (volumeBars.some((bar) => !(bar.volume > 0))) return null;
  const context = bars.slice(-45, -5);
  const testWindow = bars.slice(-5);
  const support = lowest(context);
  const resistance = highest(context);
  const averageVolume = average(volumeBars.slice(0, -1).map((bar) => bar.volume));
  const last = bars.at(-1);
  const volumeRatio = averageVolume > 0 ? last.volume / averageVolume : 0;
  const spring = lowest(testWindow) < support * 0.9995 && last.close > support && volumeRatio >= 1.15;
  const upthrust = highest(testWindow) > resistance * 1.0005 && last.close < resistance && volumeRatio >= 1.15;
  if (!spring && !upthrust) return null;
  const direction = spring ? "ACHAT" : "VENTE";
  const evidence = direction === "ACHAT"
    ? ["spring sous le support", "reprise au-dessus du support", "volume " + volumeRatio.toFixed(2) + "x"]
    : ["upthrust au-dessus de la resistance", "repli sous la resistance", "volume " + volumeRatio.toFixed(2) + "x"];
  return baseEvidenceSignal({
    style: "wyckoff",
    direction,
    entry,
    stopReference: direction === "ACHAT" ? support : resistance,
    atrValue: atr(bars),
    confidence: 76,
    evidence,
    indicators: { support, resistance, volumeRatio, phase: direction === "ACHAT" ? "spring" : "upthrust" },
    reason: "Wyckoff confirme: " + evidence.join(", ") + ".",
  });
}

function buildMixedSignal(symbol, price, history) {
  const methods = ["price_action", "ichimoku", "smc", "wyckoff"]
    .map((style) => buildStyleSignal(style, symbol, price, history))
    .filter(Boolean);
  const votes = new Map();
  for (const signal of methods) {
    const list = votes.get(signal.direction) || [];
    list.push(signal);
    votes.set(signal.direction, list);
  }
  const winner = [...votes.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!winner || winner[1].length < 2) return null;
  const [direction, confirmations] = winner;
  const representative = confirmations[0];
  const entry = finite(price?.price);
  const stopReference = direction === "ACHAT"
    ? Math.min(...confirmations.map((signal) => signal.sl))
    : Math.max(...confirmations.map((signal) => signal.sl));
  const confidence = Math.min(88, Math.round(average(confirmations.map((signal) => signal.confiance)) + confirmations.length * 3));
  return baseEvidenceSignal({
    style: "mixte",
    direction,
    entry,
    stopReference,
    atrValue: representative.indicators.atr,
    confidence,
    evidence: [
      confirmations.length + " methodes en accord",
      ...confirmations.flatMap((signal) => [
        autoAnalysisStyleLabel(signal.style) + ": " + (signal.styleEvidence?.[0] || "signal confirme"),
      ]),
    ],
    indicators: {
      consensus: confirmations.length,
      methods: confirmations.map((signal) => signal.style),
    },
    reason: "Mixte confirme par " + confirmations.map((signal) => autoAnalysisStyleLabel(signal.style)).join(" + ") + ".",
  });
}

export function buildStyleSignal(style, symbol, price, history) {
  const normalized = normalizeAutoAnalysisStyle(style);
  if (!normalized || normalized === "legacy_momentum") return null;
  if (normalized === "price_action") return detectPriceAction(symbol, price, history);
  if (normalized === "ichimoku") return detectIchimoku(symbol, price, history);
  if (normalized === "smc") return detectSmc(symbol, price, history);
  if (normalized === "wyckoff") return detectWyckoff(symbol, price, history);
  if (normalized === "mixte") return buildMixedSignal(symbol, price, history);
  return null;
}

export function buildStyleSignalSet(style, prices = {}, histories = {}, symbols = []) {
  const normalized = normalizeAutoAnalysisStyle(style);
  if (!normalized || normalized === "legacy_momentum") return [];
  return symbols
    .map((symbol) => {
      const signal = buildStyleSignal(normalized, symbol, prices[symbol], histories[symbol]);
      return signal ? { ...signal, paire: symbol } : null;
    })
    .filter(Boolean);
}
