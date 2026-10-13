// KRONOS R3 research: preserve the R2 sweep -> displacement/BOS -> FVG midpoint
// retest trigger; test confirmed MTF alignment and MDT-inspired partial/BE exits.
// This is not the proprietary MDT indicator or a claim of future profitability.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(ROOT, "data-backtest", "2026-ytd-deriv");
const MINUTE = 60_000;
const POINT = 0.01;
const SLIPPAGE = POINT;
const LOOKBACK = 20;
const MAX_HOLD_MINUTES = 30;
const MAX_COST_R = 0.15;
const WARMUP = 30 * 86_400_000;
const FOLD = 50 * 86_400_000;
const FOLD_COUNT = 5;
const SPREAD_MULTIPLIERS = [1, 1.5, 2];

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
const askByTime = new Map(ask.map((bar) => [bar.time, bar]));
const m1 = bid.flatMap((bar) => {
  const a = askByTime.get(bar.time);
  return a ? [{ ...bar, spread: Math.max(0, a.close - bar.close) }] : [];
});

function resample(bars, minutes) {
  const width = minutes * MINUTE;
  const groups = new Map();
  for (const bar of bars) {
    const start = Math.floor(bar.time / width) * width;
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

const m5 = resample(m1, 5);
const higherFrames = [15, 60, 240, 1440].map((minutes) => ({ minutes, bars: resample(m1, minutes) }));

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
    bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close)));
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
const mtf = higherFrames.map(({ minutes, bars }) => {
  const e20 = ema(bars.map((bar) => bar.close), 20);
  const e50 = ema(bars.map((bar) => bar.close), 50);
  const trend = bars.map((bar, i) => {
    if (i < 2) return 0;
    if (bar.close > e20[i] && e20[i] > e50[i] && e20[i] > e20[i - 2]) return 1;
    if (bar.close < e20[i] && e20[i] < e50[i] && e20[i] < e20[i - 2]) return -1;
    return 0;
  });
  return { minutes, bars, trend };
});

const variants = [
  { key: "r2_reference", label: "KRONOS R2 · référence, sans filtre MTF", minVotes: 0, align15h1: false, tp1R: 1, tp2R: 1.5, moveToBE: false },
  { key: "exit_only_067_be_2r", label: "R2 entrées · TP1 0,67R, BE, TP2 2R", minVotes: 0, align15h1: false, tp1R: 0.67, tp2R: 2, moveToBE: true },
  { key: "mtf_1of4_r2_exits", label: "≥1/4 cadres dans le sens · sorties R2", minVotes: 1, align15h1: false, tp1R: 1, tp2R: 1.5, moveToBE: false },
  { key: "mtf_2of4_r2_exits", label: "≥2/4 cadres dans le sens · sorties R2", minVotes: 2, align15h1: false, tp1R: 1, tp2R: 1.5, moveToBE: false },
  { key: "mtf_2of4_067be_2r", label: "≥2/4 cadres dans le sens · TP1 0,67R, BE, TP2 2R", minVotes: 2, align15h1: false, tp1R: 0.67, tp2R: 2, moveToBE: true },
  { key: "mtf_3of4_067be_2r", label: "≥3/4 cadres dans le sens · TP1 0,67R, BE, TP2 2R", minVotes: 3, align15h1: false, tp1R: 0.67, tp2R: 2, moveToBE: true },
  { key: "mtf_aligned_2of4_067be_2r", label: "M15+H1 alignés et ≥2/4 · TP1 0,67R, BE, TP2 2R", minVotes: 2, align15h1: true, tp1R: 0.67, tp2R: 2, moveToBE: true },
];

function buildSignals(variant) {
  const signals = new Map();
  const ptrs = mtf.map(() => -1);
  let swept = null;
  let armed = null;
  for (let i = LOOKBACK + 2; i < m5.length; i += 1) {
    const bar = m5[i];
    const signalEnd = bar.time + 5 * MINUTE;
    for (let f = 0; f < mtf.length; f += 1) {
      const frame = mtf[f];
      while (ptrs[f] + 1 < frame.bars.length
        && frame.bars[ptrs[f] + 1].time + frame.minutes * MINUTE <= signalEnd) ptrs[f] += 1;
    }
    const trends = mtf.map((frame, f) => ptrs[f] >= 0 ? frame.trend[ptrs[f]] : 0);
    const prior = m5.slice(i - LOOKBACK, i);
    const priorLow = Math.min(...prior.map((x) => x.low));
    const priorHigh = Math.max(...prior.map((x) => x.high));
    const range = m5Atr[i];
    if (!(range > 0)) continue;
    const hour = new Date(bar.time).getUTCHours();
    if (hour < 7 || hour >= 17) continue; // same 07-17 UTC window as R2

    if (armed && (i > armed.expires || (armed.direction === 1 && bar.low <= armed.stop)
      || (armed.direction === -1 && bar.high >= armed.stop))) armed = null;
    if (swept && (i > swept.expires || (swept.direction === 1 && bar.low <= swept.extreme)
      || (swept.direction === -1 && bar.high >= swept.extreme))) swept = null;

    let direction = 0;
    let stop = Number.NaN;
    if (armed && i > armed.index) {
      const midpointTouched = bar.low <= armed.mid && bar.high >= armed.mid;
      if (armed.direction === 1 && midpointTouched && bar.close > armed.mid && bar.close > bar.open) {
        direction = 1; stop = armed.stop; armed = null;
      } else if (armed.direction === -1 && midpointTouched && bar.close < armed.mid && bar.close < bar.open) {
        direction = -1; stop = armed.stop; armed = null;
      }
    }

    if (!armed && direction === 0 && i >= 5) {
      const body = Math.abs(bar.close - bar.open);
      const swingHigh = Math.max(...m5.slice(i - 5, i).map((x) => x.high));
      const swingLow = Math.min(...m5.slice(i - 5, i).map((x) => x.low));
      const bullDisp = bar.close > bar.open && body >= range * 0.6 && bar.close > swingHigh
        && bar.low > m5[i - 2].high && bar.close >= bar.low + (bar.high - bar.low) * 0.75;
      const bearDisp = bar.close < bar.open && body >= range * 0.6 && bar.close < swingLow
        && bar.high < m5[i - 2].low && bar.close <= bar.high - (bar.high - bar.low) * 0.75;
      if (swept?.direction === 1 && i > swept.index && bullDisp) {
        const low = m5[i - 2].high;
        const high = bar.low;
        armed = { direction: 1, low, high, mid: (low + high) / 2,
          stop: swept.extreme - Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
        swept = null;
      } else if (swept?.direction === -1 && i > swept.index && bearDisp) {
        const low = bar.high;
        const high = m5[i - 2].low;
        armed = { direction: -1, low, high, mid: (low + high) / 2,
          stop: swept.extreme + Math.max(range * 0.1, 2 * POINT), index: i, expires: i + 12 };
        swept = null;
      } else if (!swept && !armed && bar.low < priorLow && bar.close > priorLow) {
        swept = { direction: 1, extreme: bar.low, index: i, expires: i + 5 };
      } else if (!swept && !armed && bar.high > priorHigh && bar.close < priorHigh) {
        swept = { direction: -1, extreme: bar.high, index: i, expires: i + 5 };
      }
    }

    if (!direction) continue;
    const matchingVotes = trends.filter((trend) => trend === direction).length;
    if (variant.align15h1 && !(trends[0] === direction && trends[1] === direction)) continue;
    if (matchingVotes < variant.minVotes) continue;
    signals.set(signalEnd - MINUTE, { direction, stop, averageRange: range, signalTime: signalEnd,
      trends, matchingVotes });
  }
  return signals;
}

function simulate(variant, spreadMultiple) {
  const signals = buildSignals(variant);
  const trades = [];
  let pending = null;
  let pos = null;
  let previous = null;
  function exitPart(time, price, reason, fraction) {
    const qty = Math.min(fraction, pos.remaining);
    pos.pnl += (pos.direction === 1 ? price - pos.entry : pos.entry - price) * qty;
    pos.remaining -= qty;
    if (pos.remaining <= 1e-9) {
      trades.push({ direction: pos.direction, entryTime: pos.entryTime, exitTime: time,
        r: pos.pnl / pos.risk, reason, risk: pos.risk, tp1Reached: pos.tp1Reached,
        tp2Reached: reason === "TP2", mtfVotes: pos.mtfVotes });
      pos = null;
    }
  }

  for (let i = 0; i < m1.length; i += 1) {
    const bar = m1[i];
    const wasOpen = pos !== null;
    let closedThisBar = false;
    if (pos && previous && bar.time - previous.time > 10 * MINUTE) {
      const sp = previous.spread * spreadMultiple;
      exitPart(previous.time, pos.direction === 1 ? previous.close - SLIPPAGE : previous.close + sp + SLIPPAGE,
        "data_gap_flatten", pos.remaining);
      closedThisBar = true;
    }
    if (!pos && pending) {
      const sp = bar.spread * spreadMultiple;
      const entry = pending.direction === 1 ? bar.open + sp + SLIPPAGE : bar.open - SLIPPAGE;
      const risk = pending.direction === 1 ? entry - pending.stop : pending.stop - entry;
      if (risk > 0 && risk <= pending.averageRange * 3 && (sp + 2 * SLIPPAGE) / risk <= MAX_COST_R) {
        pos = { direction: pending.direction, entry, entryTime: bar.time, initialStop: pending.stop,
          activeStop: pending.stop, tp1: entry + pending.direction * risk * variant.tp1R,
          tp2: entry + pending.direction * risk * variant.tp2R, risk, remaining: 1, pnl: 0,
          tp1Reached: false, mtfVotes: pending.matchingVotes };
      }
      pending = null;
    }
    if (pos) {
      const sp = bar.spread * spreadMultiple;
      const askHigh = bar.high + sp;
      const askLow = bar.low + sp;
      const stopHit = pos.direction === 1 ? bar.low <= pos.activeStop : askHigh >= pos.activeStop;
      const stopPrice = pos.direction === 1
        ? Math.min(pos.activeStop, bar.open) - SLIPPAGE
        : Math.max(pos.activeStop, bar.open + sp) + SLIPPAGE;
      if (stopHit) {
        exitPart(bar.time, stopPrice, pos.tp1Reached && variant.moveToBE ? "BE" : "SL", pos.remaining);
        closedThisBar = true;
      } else {
        const tp1Hit = pos.direction === 1 ? bar.high >= pos.tp1 : askLow <= pos.tp1;
        const tp2Hit = pos.direction === 1 ? bar.high >= pos.tp2 : askLow <= pos.tp2;
        if (!pos.tp1Reached && tp1Hit) {
          pos.tp1Reached = true;
          const tp1Fill = pos.direction === 1 ? pos.tp1 - SLIPPAGE : pos.tp1 + SLIPPAGE;
          exitPart(bar.time, tp1Fill, "TP1", 0.5);
          if (pos && variant.moveToBE) {
            pos.activeStop = pos.entry;
            // Conservative OHLC ambiguity rule: if TP1 and entry are both crossed
            // in one M1 bar, count the remainder as a breakeven exit.
            const sameBarBe = pos.direction === 1 ? bar.low <= pos.entry : askHigh >= pos.entry;
            if (sameBarBe) {
              exitPart(bar.time, pos.direction === 1 ? pos.entry - SLIPPAGE : pos.entry + sp + SLIPPAGE,
                "BE", pos.remaining);
              closedThisBar = true;
            }
          }
        }
        if (pos && !closedThisBar && tp2Hit) {
          const tp2Fill = pos.direction === 1 ? pos.tp2 - SLIPPAGE : pos.tp2 + SLIPPAGE;
          exitPart(bar.time, tp2Fill, "TP2", pos.remaining);
          closedThisBar = true;
        } else if (pos && !closedThisBar && bar.time + MINUTE - pos.entryTime >= MAX_HOLD_MINUTES * MINUTE) {
          const timeFill = pos.direction === 1 ? bar.close - SLIPPAGE : bar.close + sp + SLIPPAGE;
          exitPart(bar.time, timeFill, "TIME", pos.remaining);
          closedThisBar = true;
        }
      }
    }
    if (!pos && !wasOpen && !closedThisBar && signals.has(bar.time)) pending = signals.get(bar.time);
    previous = bar;
  }
  if (pos && previous) {
    const sp = previous.spread * spreadMultiple;
    exitPart(previous.time, pos.direction === 1 ? previous.close - SLIPPAGE : previous.close + sp + SLIPPAGE,
      "end_of_data", pos.remaining);
  }
  const start = m1[0].time + WARMUP;
  return trades.filter((t) => t.entryTime >= start && t.entryTime < start + FOLD * FOLD_COUNT)
    .map((t) => ({ ...t, fold: Math.floor((t.entryTime - start) / FOLD) }));
}

function summarize(trades) {
  const grossWins = trades.filter((t) => t.r > 0).reduce((s, t) => s + t.r, 0);
  const grossLosses = trades.filter((t) => t.r < 0).reduce((s, t) => s + Math.abs(t.r), 0);
  let equity = 0; let peak = 0; let maxDrawdown = 0;
  for (const t of trades) { equity += t.r; peak = Math.max(peak, equity); maxDrawdown = Math.max(maxDrawdown, peak - equity); }
  const totalR = trades.reduce((s, t) => s + t.r, 0);
  const folds = Array.from({ length: FOLD_COUNT }, (_, i) => {
    const part = trades.filter((t) => t.fold === i);
    return { trades: part.length, totalR: +part.reduce((s, t) => s + t.r, 0).toFixed(2),
      avgR: part.length ? +(part.reduce((s, t) => s + t.r, 0) / part.length).toFixed(3) : 0 };
  });
  return { trades: trades.length, winPct: trades.length ? +(100 * trades.filter((t) => t.r > 0).length / trades.length).toFixed(1) : 0,
    avgR: trades.length ? +(totalR / trades.length).toFixed(3) : 0, totalR: +totalR.toFixed(2),
    profitFactor: grossLosses ? +(grossWins / grossLosses).toFixed(3) : (grossWins > 0 ? "∞" : 0),
    maxDrawdownR: +maxDrawdown.toFixed(2), positiveFolds: folds.filter((f) => f.trades && f.totalR > 0).length,
    folds, tp1Trades: trades.filter((t) => t.tp1Reached).length, tp2Trades: trades.filter((t) => t.tp2Reached).length,
    exits: Object.fromEntries(["SL", "BE", "TP2", "TIME", "data_gap_flatten", "end_of_data"].map((x) =>
      [x, trades.filter((t) => t.reason === x).length])) };
}

const first = m1[0].time;
const last = m1.at(-1).time;
const spreads = m1.map((b) => b.spread).sort((a, b) => a - b);
const output = {
  source: "Bougies bid M1 Deriv-Demo MT5 XAUUSD et spread enregistré par minute; signal M5, exécution approximée en M1",
  period: { from: new Date(first).toISOString(), to: new Date(last).toISOString(),
    evaluationFrom: new Date(first + WARMUP).toISOString(), folds: FOLD_COUNT, foldDays: 50 },
  data: { m1Bars: m1.length, m5CompleteBars: m5.length, higherTimeframes: Object.fromEntries(mtf.map((f) => [f.minutes, f.bars.length])),
    spreadMedian: spreads[Math.floor(spreads.length * 0.5)], spreadP75: spreads[Math.floor(spreads.length * 0.75)] },
  rules: { coreEntry: "Entrée KRONOS R2 inchangée : sweep/reprise du plus haut ou bas des 20 M5 précédentes; sous 5 bougies, déplacement/BOS et FVG trois bougies; entrée seulement après confirmation du retest du milieu de la FVG sous 12 bougies.",
    mtf: "Au signal, seule la dernière bougie close des cadres M15/H1/H4/D1 est utilisée. Tendance proxy = clôture du bon côté de l'EMA20, EMA20 du bon côté de l'EMA50 et pente EMA20 sur deux bougies. Les variantes vote exigent 1/4, 2/4 ou 3/4 cadres dans le sens du trade; une variante stricte exige aussi l'accord M15/H1.",
    management: "R2 = 50 % à +1R, 50 % à +1,5R, stop initial. Variante inspirée des captures = 50 % à +0,67R, stop du reliquat déplacé à l'entrée, TP2 à +2R ou +2,5R; sortie temps après 30 minutes. Si TP1 et breakeven sont touchés dans la même bougie M1, le reliquat est compté au breakeven par prudence.",
    execution: "Entrée à l'ouverture de la M1 suivante, spread de la minute et 0,01 $ de slippage par côté; sorties approximées avec bid/ask. Le stop est prioritaire si stop et objectif sont touchés dans la même M1; aucune commission n'est supposée.",
    folds: "Warm-up de 30 jours puis cinq segments chronologiques de 50 jours; règles identiques dans chaque segment." },
  results: [],
  limitations: ["Il s'agit d'une reconstitution à partir de captures, pas de l'indicateur MDT privé ni d'une validation de sa méthode.",
    "Données XAUUSD Deriv-Demo seulement; elles ne prouvent pas la rentabilité en réel et ne s'appliquent pas automatiquement à d'autres symboles ou courtiers.",
    "Les OHLC M1 ne donnent pas l'ordre exact des ticks; les règles prudentes sur le stop et le breakeven réduisent l'incertitude d'exécution sans la supprimer.",
    "Le spread enregistré est utilisé comme estimation minute par minute; commissions, swaps, rejets, latence, marge et slippage variable ne sont pas modélisés.",
    "Les cinq segments chronologiques restent historiques, pas un échantillon futur indépendant. L'échantillon de cette entrée sélective est petit; il ne faut pas choisir un réglage uniquement parce qu'il gagne sur ces données."]
};
for (const variant of variants) for (const spreadMultiple of SPREAD_MULTIPLIERS) {
  output.results.push({ key: variant.key, label: variant.label, spreadMultiple,
    tp1R: variant.tp1R, tp2R: variant.tp2R, moveToBE: variant.moveToBE,
    minVotes: variant.minVotes, requireM15H1Alignment: variant.align15h1,
    ...summarize(simulate(variant, spreadMultiple)) });
}

writeFileSync(join(DIR, "kronos-r3-mtd-inspired-2026-results.json"), JSON.stringify(output, null, 2) + "\n", "utf8");
const md = ["# KRONOS R3 · concepts inspirés des captures MDT · étude XAUUSD Deriv-Demo 2026", "",
  "> Ce test conserve le déclencheur Price Action KRONOS R2. Il ne réplique pas le code privé MDT et ne valide pas une rentabilité future.", "",
  `Données : ${output.period.from} à ${output.period.to}; ${m1.length} bougies M1 appariées; ${m5.length} bougies M5 complètes; spread médian $${output.data.spreadMedian.toFixed(3)}, p75 $${output.data.spreadP75.toFixed(3)}.`, "",
  "| Variante | Spread | Trades | % + net | R/trade | R total | PF | DD max R | Folds + | Fold 1 | Fold 2 | Fold 3 | Fold 4 | Fold 5 | TP1 | TP2 |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"];
for (const r of output.results) md.push(`| ${r.label} | ${r.spreadMultiple}x | ${r.trades} | ${r.winPct} | ${r.avgR} | ${r.totalR} | ${r.profitFactor} | ${r.maxDrawdownR} | ${r.positiveFolds}/5 | ${r.folds.map((f) => `${f.trades}/${f.totalR}R`).join(" | ")} | ${r.tp1Trades} | ${r.tp2Trades} |`);
const baseline = output.results.find((r) => r.key === "r2_reference" && r.spreadMultiple === 1);
const exitsOnly = output.results.find((r) => r.key === "exit_only_067_be_2r" && r.spreadMultiple === 1);
const mtf2 = output.results.find((r) => r.key === "mtf_2of4_r2_exits" && r.spreadMultiple === 1);
md.push("", "## Méthode", "", `- Déclencheur identique à KRONOS R2 : ${output.rules.coreEntry}`,
  `- Filtre de tendance : ${output.rules.mtf}`, `- Sorties : ${output.rules.management}`,
  `- Exécution et frais : ${output.rules.execution}`, "", "## Lecture au spread observé", "",
  `- La référence R2 sans filtre donne ${baseline.trades} trades, ${baseline.totalR}R au total, ${baseline.avgR}R/trade et ${baseline.positiveFolds}/5 segments positifs.`,
  `- La gestion TP1 0,67R + breakeven sur les mêmes entrées donne ${exitsOnly.trades} trades et ${exitsOnly.avgR}R/trade. Elle est en dessous des ${baseline.avgR}R/trade de la référence sur cet échantillon.`,
  `- Le filtre 2/4 donne ${mtf2.trades} trades; le PF infini vient de l'absence de pertes dans seulement ${mtf2.trades} trades et n'est pas une preuve d'avantage. Le filtre réduit aussi le total à ${mtf2.totalR}R contre ${baseline.totalR}R pour la référence.`,
  "- Ces résultats ne justifient pas d'activer par défaut les nouveaux filtres ou sorties. La branche Pine les expose pour recherche, mais démarre avec les réglages de référence.",
  "", "## Limites", "", ...output.limitations.map((x) => `- ${x}`), "");
writeFileSync(join(DIR, "KRONOS_R3_MDT_INSPIRED_2026_REPORT.md"), md.join("\n"), "utf8");
console.log(`Saved ${output.results.length} KRONOS R3 research runs.`);
