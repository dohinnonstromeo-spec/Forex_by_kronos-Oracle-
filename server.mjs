import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const env = await loadEnv(join(root, "secret.dev"));
const port = Number(env.PORT || 4174);
const dataDir = join(root, "data");
const learningPath = join(dataDir, "learning-log.json");
const marketCachePath = join(dataDir, "market-cache.json");
const providerHealth = new Map();
const memoryCache = {
  prices: { value: null, expiresAt: 0 },
  histories: { key: "", value: null, expiresAt: 0 },
  calendar: { value: null, expiresAt: 0 },
};

const GROQ_MODEL = env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_FALLBACK_MODEL = "llama-3.3-70b-versatile";
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
].filter((model, index, list) => model && list.indexOf(model) === index);
const symbols = ["EUR/USD", "XAU/USD", "BTC/USD", "GBP/JPY", "US500", "ETH/USD"];

const fallbackPrices = {
  "EUR/USD": { price: 1.0847, change: 0.32 },
  "XAU/USD": { price: 2384.5, change: 1.21 },
  "BTC/USD": { price: 67420, change: 2.84 },
  "GBP/JPY": { price: 198.42, change: -0.18 },
  US500: { price: 5240.3, change: 0.41 },
  "ETH/USD": { price: 3120.5, change: 1.13 },
};

const fallbackSignals = [
  ["EUR/USD", "ACHAT", 1.0832, 1.081, 1.0865, 1.089, "2.6", 87, "ICT"],
  ["XAU/USD", "ACHAT", 2381.5, 2374, 2395, 2410, "3.8", 91, "Wyckoff"],
  ["GBP/JPY", "VENTE", 198.45, 198.95, 197.6, 196.8, "2.4", 78, "PriceAction"],
  ["BTC/USD", "ACHAT", 67120, 66400, 68500, 70000, "3.1", 84, "Elliott"],
  ["US500", "ACHAT", 5240.3, 5212, 5288, 5320, "2.7", 82, "SMC"],
  ["ETH/USD", "VENTE", 3482, 3530, 3420, 3360, "2.1", 71, "Ichimoku"],
].map(([paire, direction, entree, sl, tp1, tp2, rr, confiance, technique]) => ({
  paire,
  direction,
  entree,
  sl,
  tp1,
  tp2,
  rr,
  confiance,
  technique,
  raison: "Momentum confirme le scénario Kronos.",
}));

const KRONOS_SYSTEM_PROMPT = `Tu es Kronos, le moteur IA d'Oracle Forex.

TECHNIQUES D'ANALYSE — choisis automatiquement la plus adaptée :
1. Smart Money (ICT) → Order Blocks, FVG, Liquidité
2. Wyckoff → Phases accumulation/distribution
3. Elliott Wave → Vagues 1-5, corrections ABC
4. Price Action → S/R, chandeliers, patterns
5. Ichimoku → Nuage Kumo, Tenkan/Kijun
6. SMC → BOS, CHOCH, MSB, liquidité
7. Mixte → compare toutes les techniques et retiens la plus efficace

FORMAT OBLIGATOIRE :
📐 TECHNIQUE UTILISÉE : [nom + raison]
📊 ANALYSE :
- Tendance : [Haussière/Baissière/Neutre]
- Signal détecté : [description]
- Zone d'entrée : [niveau]
- Stop Loss : [niveau]
- Take Profit 1 : [niveau]
- Take Profit 2 : [niveau]
✅ CONFLUENCE : [si plusieurs graphiques]
⚠️ RISQUE : Ce n'est pas un conseil financier.
SCORE_CONFIANCE:[0-100]
TECHNIQUE_UTILISEE:[nom court]
STYLE_EFFICACITE:[style]=[0-100]`;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    sendJson(res, 500, { error: "server_error", message: error.message });
  }
}).listen(port, () => {
  console.log(`Oracle Forex local: http://127.0.0.1:${port}/#signaux`);
});

async function handleApi(req, res, url) {
  if (url.pathname === "/api/market-status") {
    sendJson(res, 200, marketStatus());
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(res, 200, {
      groq: Boolean(env.GROQ_KEY || env.GROQ_API_KEY),
      gemini: Boolean(env.GEMINI_API_KEY || env.GEMINI_KEY),
      twelveData: Boolean(env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY),
      polygon: Boolean(env.POLYGON_API_KEY || env.POLYGON_KEY),
      alphaVantage: Boolean(env.ALPHA_VANTAGE_API_KEY),
      stooqFallback: true,
      dukascopyHistorical: true,
      coinbaseFallback: true,
      frankfurterFallback: true,
      finnhub: Boolean(env.FINNHUB_API_KEY),
      news: Boolean(env.NEWS_API_KEY || env.GNEWS_API_KEY || env.NEWSDATA_API_KEY),
      market: marketStatus(),
    });
    return;
  }

  if (url.pathname === "/api/health") {
    const learning = await loadLearningLog();
    sendJson(res, 200, {
      market: marketStatus(),
      providers: providerHealthSnapshot(),
      cache: await marketCacheSummary(),
      learning: learningSummary(learning),
      recommendations: healthRecommendations(),
    });
    return;
  }

  if (url.pathname === "/api/prices") {
    sendJson(res, 200, { market: marketStatus(), prices: await getPrices() });
    return;
  }

  if (url.pathname === "/api/signals") {
    const prices = await getPrices();
    const market = marketStatus();
    const histories = await getHistories(prices);
    await updateLearningOutcomes(prices);
    const newsRisk = await economicRiskWindow();
    const signals = applyNewsRisk(buildDeterministicSignals(prices, histories), newsRisk);
    sendJson(res, 200, { generatedAt: new Date().toISOString(), market, newsRisk, signals });
    return;
  }

  if (url.pathname === "/api/learning") {
    const prices = await getPrices();
    const learning = await updateLearningOutcomes(prices);
    sendJson(res, 200, learningSummary(learning));
    return;
  }

  if (url.pathname === "/api/comment") {
    const body = await readBody(req);
    const prompt = `${body.pair} vient de passer de ${body.previous} à ${body.current} (${body.changePercent}%). 1 phrase d'analyse trader en français. Maximum 12 mots.`;
    const comment = await groq(prompt, 40, 0.3);
    sendJson(res, 200, { comment: cleanLine(comment) || "Momentum confirmé par Kronos." });
    return;
  }

  if (url.pathname === "/api/news-summary") {
    const body = await readBody(req);
    const prompt = `Actualité : ${body.title}
Résume en 8 mots max style trader.
Identifie : paire impactée + direction.
Format : PAIRE DIRECTION · résumé court`;
    const summary = await groq(prompt, 40, 0.3);
    sendJson(res, 200, { summary: cleanLine(summary).toUpperCase() });
    return;
  }

  if (url.pathname === "/api/confidence") {
    const body = await readBody(req);
    sendJson(res, 200, deterministicConfidence(body));
    return;
  }

  if (url.pathname === "/api/briefing") {
    const body = await readBody(req);
    const prompt = `Événement dans 15min : ${body.name}
Précédent: ${body.previous} / Prévu: ${body.forecast}
Génère un briefing trader en JSON : {"titre":"","paires_surveiller":[],"scenario_positif":"","scenario_negatif":"","conseil":"","pips_potentiels":80}`;
    sendJson(res, 200, { briefing: parseJson(await groq(prompt, 140, 0.3), null) });
    return;
  }

  if (url.pathname === "/api/economic-calendar") {
    sendJson(res, 200, { events: await getEconomicCalendar() });
    return;
  }

  if (url.pathname === "/api/chat") {
    const body = await readBody(req);
    const images = normalizeImages(body.images);
    const question = cleanLine(body.message || body.messages?.at?.(-1)?.content || "");
    const context = Array.isArray(body.messages)
      ? body.messages.slice(-6).map((m) => `${m.role || "user"}: ${m.content || ""}`).join("\n")
      : "";
    const prompt = `${KRONOS_SYSTEM_PROMPT}

QUESTION UTILISATEUR:
${question || "Analyse ces graphiques."}

CONTEXTE RECENT:
${context}

Réponds en français, de façon concise mais utile.`;
    const answer = images.length ? await geminiVision(prompt, images) : await groq(prompt, 420, 0.3);
    if (images.length && !answer) {
      sendJson(res, 200, {
        answer: "Vision Gemini indisponible: je ne peux pas analyser ce graphique de façon fiable. Pose une question texte ou vérifie la clé Gemini.",
        score: 0,
        technique: "Vision indisponible",
      });
      return;
    }
    sendJson(res, 200, normalizeAiAnswer(answer, question));
    return;
  }

  if (url.pathname === "/api/detect-chart-context") {
    const body = await readBody(req);
    const images = normalizeImages(body.images);
    if (!images.length) {
      sendJson(res, 200, { ok: false, reason: "image_required" });
      return;
    }
    if (!env.GEMINI_API_KEY && !env.GEMINI_KEY) {
      sendJson(res, 200, { ok: false, reason: "gemini_required" });
      return;
    }
    const prompt = `Lis ces screenshots de charts trading.
Détecte uniquement ce qui est visible: symbole/paire, timeframe de chaque image, plateforme si visible.
Réponds en JSON strict:
{
  "primaryPair": "EUR/USD ou XAU/USD ou null",
  "timeframes": ["H4","H1","M15"],
  "executionTimeframe": "le plus petit timeframe détecté, ou null",
  "platform": "TradingView|MT4|MT5|cTrader|unknown",
  "confidence": 0-100,
  "needsConfirmation": true|false,
  "reason": "phrase courte"
}`;
    const answer = await geminiVision(prompt, images);
    const detected = normalizeChartDetection(parseJson(answer, null));
    sendJson(res, 200, detected);
    return;
  }

  if (url.pathname === "/api/analyze-chart") {
    const body = await readBody(req);
    const images = normalizeImages(body.images);
    const imageQuality = assessImageQuality(images);
    if (images.length && imageQuality.score < 20) {
      sendJson(res, 200, {
        direction: "AUCUN SIGNAL",
        entry: "—",
        sl: "—",
        tp1: "—",
        tp2: "—",
        rr: "—",
        score: imageQuality.score,
        technique: "Image non validée",
        explanation: `Qualité image trop faible (${imageQuality.reason}). Kronos bloque seulement les images quasi illisibles.`,
        meta: { imageQuality },
        noSignal: true,
      });
      return;
    }
    if (images.length && !env.GEMINI_API_KEY && !env.GEMINI_KEY) {
      sendJson(res, 200, {
        direction: "AUCUN SIGNAL",
        entry: "—",
        sl: "—",
        tp1: "—",
        tp2: "—",
        rr: "—",
        score: 0,
        technique: "Vision indisponible",
        explanation: "Gemini Vision est requis pour analyser un screenshot. Kronos bloque le signal pour éviter une analyse inventée.",
        noSignal: true,
      });
      return;
    }
    const prices = await getPrices();
    const autoDetectEnabled = body.autoDetect === true || body.autoDetect === "on" || body.autoDetect === "true";
    const chartContext = autoDetectEnabled ? normalizeChartDetection(body.detectedContext) : normalizeChartDetection(null);
    const selectedPair = chartContext.primaryPair || body.pair || "EUR/USD";
    const selectedTimeframe = chartContext.executionTimeframe || body.timeframe || "H1";
    const livePrice = prices[selectedPair] || await getExternalPrice(selectedPair);
    const learning = await updateLearningOutcomes(prices);
    const calibration = calibrationFor(learning, body);
    const prompt = `${KRONOS_SYSTEM_PROMPT}

CONTEXTE:
- Paire confirmée: ${selectedPair}
- Timeframe formulaire: ${body.timeframe || "H1"}
- Timeframes détectés: ${(chartContext.timeframes || []).join(", ") || "non détectés"}
- Timeframe final d'exécution: ${selectedTimeframe}
- Style demandé: ${body.style || "Mixte"}
- Gestion du risque: ${body.risk || "Standard 2%"}
- Prix live validé: ${livePrice?.price ?? "indisponible"} (${livePrice?.source || "aucune source"})
- Qualité image estimée: ${images.length ? `${imageQuality.score}/100 (${imageQuality.reason})` : "aucun graphe uploadé: analyse texte/prix live"}
- Calibration historique Kronos: ${calibration.message}

RÈGLE STRICTE:
Nombre de graphes fournis: ${images.length}.
Si aucun graphe n'est fourni, ne prétends jamais voir des chandeliers, order blocks, FVG, nuage Ichimoku, vagues Elliott ou structures visibles. Dans ce cas, écris clairement "Analyse sans screenshot", utilise seulement prix live/contexte formulaire, et plafonne le score à 70.
Si un ou plusieurs graphes sont fournis, distingue ce qui est réellement visible sur les images de ce qui vient du prix live/API.
Si le style demandé est "Mixte", compare ICT, SMC, Wyckoff, Elliott, Price Action et Ichimoku, puis retiens uniquement le style avec la meilleure efficacité visible.
Si le style demandé n'est pas "Mixte" et que sa structure n'est pas clairement visible, baisse le score d'efficacité mais ne bloque pas si les niveaux sont cohérents.
Tu dois citer les éléments techniques visibles qui justifient le style retenu.
Si la détection automatique est désactivée, utilise la paire et le timeframe du formulaire comme contexte confirmé.
Refuse seulement si aucune analyse raisonnable ne peut être estimée. Si le graphe est absent ou incomplet, fais une analyse prudente basée sur la paire, le timeframe et le prix live.
Les niveaux doivent rester cohérents avec la structure du graphique et le ratio risque/rendement doit être calculable.
Si plusieurs graphes sont fournis: utilise les timeframes élevés pour la tendance/contexte et le plus petit timeframe détecté pour l'entrée finale.
Retour obligatoire: direction, entrée, stop loss, TP1, TP2, R/R, SCORE_CONFIANCE, TECHNIQUE_UTILISEE, et une ligne "STYLE_EFFICACITE:[style]=[0-100]".

    Analyse le contexte fourni et donne un setup éducatif exploitable avec prudence.`;
    let answer = images.length ? await geminiVision(prompt, images) : await groq(prompt, 500, 0.3);
    if (!answer) {
      answer = buildDeterministicAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        livePrice,
      });
    }
    const result = normalizeAnalysis(answer, { ...body, pair: selectedPair, timeframe: selectedTimeframe }, { livePrice, imageQuality, calibration, chartContext });
    if (!result.educationalOnly) await recordLearningAnalysis(result, body, { livePrice, imageQuality, calibration });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function getPrices() {
  if (memoryCache.prices.value && Date.now() < memoryCache.prices.expiresAt) return memoryCache.prices.value;
  const cache = await loadMarketCache();
  const entries = await Promise.all(symbols.map(async (symbol) => [symbol, await fetchBestPrice(symbol, cache.prices?.[symbol])]));
  const prices = Object.fromEntries(entries);
  await saveMarketCache({
    ...cache,
    prices: mergeCachedPrices(cache.prices || {}, prices),
  });
  memoryCache.prices = { value: prices, expiresAt: Date.now() + 45 * 1000 };
  return prices;
}

async function fetchBestPrice(symbol, cached) {
  const providers = [fetchTwelveDataPrice, fetchPolygonPrice, fetchAlphaVantagePrice, fetchCoinbasePrice, fetchStooqPrice, fetchFrankfurterPrice];
  const errors = [];
  for (const provider of providers) {
    try {
      const price = await provider(symbol);
      if (price) return price;
    } catch (error) {
      errors.push(error.message);
    }
  }
  if (isRecentCache(cached, cacheTtlMs(symbol))) {
    return pricePayload(symbol, cached, `cache:${cached.source || "last_good"}`, errors.join(" | ") || "using_last_good", {
      stale: true,
      reliability: 55,
    });
  }
  return pricePayload(symbol, fallbackPrices[symbol], "static_fallback", errors.join(" | ") || "all_providers_unavailable", {
    stale: true,
    reliability: 15,
  });
}

async function getExternalPrice(symbol) {
  if (!symbol) return null;
  try {
    return await fetchBestPrice(symbol, null);
  } catch {
    return null;
  }
}

async function fetchTwelveDataPrice(symbol) {
  const key = env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY;
  if (!key) return null;
  try {
    const api = new URL("https://api.twelvedata.com/quote");
    api.searchParams.set("symbol", symbol);
    api.searchParams.set("apikey", key);
    const data = await fetchJson(api);
    const price = Number(data.close || data.price || data.previous_close);
    const change = Number(data.percent_change || data.change || 0);
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("twelve_data", true);
    return pricePayload(symbol, { price, change }, "twelve_data", null, { reliability: 95 });
  } catch (error) {
    recordProviderHealth("twelve_data", false, error.message);
    throw error;
  }
}

async function fetchPolygonPrice(symbol) {
  const key = env.POLYGON_API_KEY || env.POLYGON_KEY;
  if (!key) return null;
  const ticker = toPolygonTicker(symbol);
  if (!ticker) return null;
  try {
    const api = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`);
    api.searchParams.set("adjusted", "true");
    api.searchParams.set("apiKey", key);
    const data = await fetchJson(api);
    const bar = Array.isArray(data.results) ? data.results[0] : null;
    const price = Number(bar?.c);
    const open = Number(bar?.o);
    const change = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;
    if (!Number.isFinite(price)) throw new Error(data.error || "invalid_price");
    recordProviderHealth("polygon_price", true);
    return pricePayload(symbol, { price, change }, "polygon", null, { reliability: 88 });
  } catch (error) {
    recordProviderHealth("polygon_price", false, error.message);
    throw error;
  }
}

async function fetchAlphaVantagePrice(symbol) {
  const key = env.ALPHA_VANTAGE_API_KEY;
  if (!key) return null;
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) && !/BTC|ETH/i.test(symbol)) return null;
  try {
    const [from, to] = symbol.split("/");
    const api = new URL("https://www.alphavantage.co/query");
    api.searchParams.set("function", "CURRENCY_EXCHANGE_RATE");
    api.searchParams.set("from_currency", from);
    api.searchParams.set("to_currency", to || "USD");
    api.searchParams.set("apikey", key);
    const data = await fetchJson(api);
    const payload = data["Realtime Currency Exchange Rate"] || {};
    const price = Number(payload["5. Exchange Rate"]);
    if (!Number.isFinite(price)) throw new Error(data.Note ? "rate_limited" : "invalid_price");
    recordProviderHealth("alpha_vantage", true);
    return pricePayload(symbol, { price, change: 0 }, "alpha_vantage", null, { reliability: 80 });
  } catch (error) {
    recordProviderHealth("alpha_vantage", false, error.message);
    throw error;
  }
}

async function fetchCoinbasePrice(symbol) {
  if (!/^(BTC|ETH)\/USD$/i.test(symbol)) return null;
  try {
    const [asset, currency] = symbol.split("/");
    const api = new URL(`https://api.coinbase.com/v2/prices/${asset}-${currency}/spot`);
    const data = await fetchJson(api);
    const price = Number(data.data?.amount);
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("coinbase", true);
    return pricePayload(symbol, { price, change: 0 }, "coinbase", null, { reliability: 78 });
  } catch (error) {
    recordProviderHealth("coinbase", false, error.message);
    throw error;
  }
}

async function fetchFrankfurterPrice(symbol) {
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) || /XAU|XAG|BTC|ETH/i.test(symbol)) return null;
  try {
    const [from, to] = symbol.split("/");
    const api = new URL("https://api.frankfurter.app/latest");
    api.searchParams.set("from", from);
    api.searchParams.set("to", to);
    const data = await fetchJson(api);
    const price = Number(data.rates?.[to]);
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("frankfurter", true);
    return pricePayload(symbol, { price, change: 0 }, "frankfurter_daily", null, {
      stale: true,
      reliability: 58,
    });
  } catch (error) {
    recordProviderHealth("frankfurter", false, error.message);
    throw error;
  }
}

async function fetchStooqPrice(symbol) {
  const stooqSymbol = toStooqSymbol(symbol);
  if (!stooqSymbol) return null;
  try {
    const api = new URL("https://stooq.com/q/l/");
    api.searchParams.set("s", stooqSymbol);
    api.searchParams.set("f", "sd2t2ohlcv");
    api.searchParams.set("h", "");
    api.searchParams.set("e", "csv");
    const rows = parseCsv(await fetchText(api));
    const row = rows[0] || {};
    const price = Number(row.Close || row.close);
    const open = Number(row.Open || row.open);
    const change = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("stooq_price", true);
    return pricePayload(symbol, { price, change }, "stooq", null, { reliability: 72 });
  } catch (error) {
    recordProviderHealth("stooq_price", false, error.message);
    throw error;
  }
}

async function getHistories(prices) {
  const usableKey = symbols.map((symbol) => `${symbol}:${prices[symbol]?.source || "none"}:${prices[symbol]?.asOf || ""}`).join("|");
  if (memoryCache.histories.value && memoryCache.histories.key === usableKey && Date.now() < memoryCache.histories.expiresAt) {
    return memoryCache.histories.value;
  }
  const key = env.TWELVE_DATA_API_KEY || env.TWELVEDATA_API_KEY;
  const cache = await loadMarketCache();
  if (!key) {
    const histories = await fetchFreeHistories(cache, prices);
    memoryCache.histories = { key: usableKey, value: histories, expiresAt: Date.now() + 15 * 60 * 1000 };
    return histories;
  }
  const entries = await Promise.all(symbols.map(async (symbol) => {
    const price = prices[symbol];
    if (!price?.open || !isUsableLivePrice(price)) return [symbol, cachedHistory(symbol, cache)];
    const errors = [];
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchPolygonHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `polygon:${interval}`, false);
          recordProviderHealth("polygon_history", true);
          return [symbol, bars];
        }
        errors.push(`polygon_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`polygon_${interval}:${error.message}`);
      }
    }
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchTwelveDataHistory(symbol, interval, key);
        if (bars.length >= 30) {
          tagHistory(bars, `twelve_data:${interval}`, false);
          recordProviderHealth("twelve_data_history", true);
          return [symbol, bars];
        }
        errors.push(`${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`${interval}:${error.message}`);
      }
    }
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchPolygonHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `polygon:${interval}`, false);
          recordProviderHealth("polygon_history", true);
          return [symbol, bars];
        }
        errors.push(`polygon_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`polygon_${interval}:${error.message}`);
      }
    }
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchStooqHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `stooq:${interval}`, false);
          recordProviderHealth("stooq_history", true);
          return [symbol, bars];
        }
        errors.push(`stooq_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`stooq_${interval}:${error.message}`);
      }
    }
    try {
      const bars = await fetchDukascopyHistory(symbol);
      if (bars.length >= 30) {
        tagHistory(bars, "dukascopy:daily", true);
        recordProviderHealth("dukascopy_history", true);
        return [symbol, bars];
      }
      errors.push("dukascopy:insufficient_bars");
    } catch (error) {
      errors.push(`dukascopy:${error.message}`);
    }
    recordProviderHealth("twelve_data_history", false, errors.join(" | "));
    return [symbol, cachedHistory(symbol, cache)];
  }));
  const histories = Object.fromEntries(entries);
  await saveMarketCache({
    ...cache,
    histories: mergeCachedHistories(cache.histories || {}, histories),
  });
  memoryCache.histories = { key: usableKey, value: histories, expiresAt: Date.now() + 10 * 60 * 1000 };
  return histories;
}

async function fetchFreeHistories(cache, prices) {
  const entries = await Promise.all(symbols.map(async (symbol) => {
    const price = prices[symbol];
    if (!price?.open) return [symbol, cachedHistory(symbol, cache)];
    const errors = [];
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchStooqHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `stooq:${interval}`, false);
          recordProviderHealth("stooq_history", true);
          return [symbol, bars];
        }
        errors.push(`${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`${interval}:${error.message}`);
      }
    }
    try {
      const bars = await fetchDukascopyHistory(symbol);
      if (bars.length >= 30) {
        tagHistory(bars, "dukascopy:daily", true);
        recordProviderHealth("dukascopy_history", true);
        return [symbol, bars];
      }
      errors.push("dukascopy:insufficient_bars");
    } catch (error) {
      errors.push(`dukascopy:${error.message}`);
    }
    recordProviderHealth("free_history", false, errors.join(" | "));
    return [symbol, cachedHistory(symbol, cache)];
  }));
  const histories = Object.fromEntries(entries);
  await saveMarketCache({
    ...cache,
    histories: mergeCachedHistories(cache.histories || {}, histories),
  });
  return histories;
}

async function fetchTwelveDataHistory(symbol, interval, key) {
  const api = new URL("https://api.twelvedata.com/time_series");
  api.searchParams.set("symbol", symbol);
  api.searchParams.set("interval", interval);
  api.searchParams.set("outputsize", "80");
  api.searchParams.set("apikey", key);
  const data = await fetchJson(api);
  if (data.status === "error" || data.code) throw new Error(data.message || data.code || "api_error");
  const values = Array.isArray(data.values) ? data.values : [];
  return values.map((bar) => ({
    close: Number(bar.close),
    high: Number(bar.high),
    low: Number(bar.low),
    datetime: bar.datetime,
  })).filter((bar) => Number.isFinite(bar.close)).reverse();
}

async function fetchPolygonHistory(symbol, interval) {
  const key = env.POLYGON_API_KEY || env.POLYGON_KEY;
  const ticker = toPolygonTicker(symbol);
  const span = toPolygonTimespan(interval);
  if (!key || !ticker || !span) return [];
  const to = new Date();
  const from = new Date(to.getTime() - polygonLookbackMs(interval));
  const api = new URL(`https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${span.multiplier}/${span.timespan}/${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`);
  api.searchParams.set("adjusted", "true");
  api.searchParams.set("sort", "asc");
  api.searchParams.set("limit", "120");
  api.searchParams.set("apiKey", key);
  const data = await fetchJson(api);
  if (data.status === "ERROR" || data.error) throw new Error(data.error || "api_error");
  const values = Array.isArray(data.results) ? data.results : [];
  return values.map((bar) => ({
    close: Number(bar.c),
    high: Number(bar.h),
    low: Number(bar.l),
    datetime: bar.t ? new Date(bar.t).toISOString() : null,
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low)).slice(-80);
}

async function fetchStooqHistory(symbol, interval) {
  const stooqSymbol = toStooqSymbol(symbol);
  const stooqInterval = toStooqInterval(interval);
  if (!stooqSymbol || !stooqInterval) return [];
  const api = new URL("https://stooq.com/q/d/l/");
  api.searchParams.set("s", stooqSymbol);
  api.searchParams.set("i", stooqInterval);
  const rows = parseCsv(await fetchText(api));
  const bars = rows.map((row) => ({
    close: Number(row.Close || row.close),
    high: Number(row.High || row.high),
    low: Number(row.Low || row.low),
    datetime: `${row.Date || row.date || ""} ${row.Time || row.time || ""}`.trim(),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
  if (!bars.length) throw new Error("invalid_history");
  return bars.slice(-80);
}

async function fetchDukascopyHistory(symbol) {
  const stooqSymbol = toStooqSymbol(symbol);
  if (!stooqSymbol || /US500|NAS|SPX/i.test(symbol)) return [];
  const api = new URL("https://stooq.com/q/d/l/");
  api.searchParams.set("s", stooqSymbol);
  api.searchParams.set("i", "d");
  const rows = parseCsv(await fetchText(api));
  const bars = rows.map((row) => ({
    close: Number(row.Close || row.close),
    high: Number(row.High || row.high),
    low: Number(row.Low || row.low),
    datetime: row.Date || row.date,
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
  if (!bars.length) throw new Error("invalid_history");
  return bars.slice(-80);
}

function historyIntervals(symbol) {
  if (/BTC|ETH/i.test(symbol)) return ["15min", "30min", "1h"];
  if (/US500|NAS|SPX/i.test(symbol)) return ["30min", "1h", "1day"];
  return ["15min", "30min", "1h", "1day"];
}

function toStooqSymbol(symbol = "") {
  const normalized = String(symbol).toUpperCase().replace(/[^A-Z0-9/]/g, "");
  const aliases = {
    "EUR/USD": "eurusd",
    "GBP/USD": "gbpusd",
    "USD/JPY": "usdjpy",
    "USD/CHF": "usdchf",
    "USD/CAD": "usdcad",
    "AUD/USD": "audusd",
    "NZD/USD": "nzdusd",
    "GBP/JPY": "gbpjpy",
    "EUR/JPY": "eurjpy",
    "XAU/USD": "xauusd",
    "XAG/USD": "xagusd",
    "BTC/USD": "btcusd",
    "ETH/USD": "ethusd",
    US500: "^spx",
    NAS100: "^ndx",
  };
  if (aliases[normalized]) return aliases[normalized];
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(normalized)) return normalized.replace("/", "").toLowerCase();
  return null;
}

function toStooqInterval(interval = "") {
  return ({
    "15min": "15",
    "30min": "30",
    "1h": "60",
    "1day": "d",
    "1d": "d",
  })[interval] || null;
}

function toPolygonTicker(symbol = "") {
  const normalized = String(symbol).toUpperCase().replace(/[^A-Z0-9/]/g, "");
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(normalized)) return `C:${normalized.replace("/", "")}`;
  if (normalized === "XAU/USD") return "C:XAUUSD";
  if (normalized === "XAG/USD") return "C:XAGUSD";
  if (normalized === "BTC/USD") return "X:BTCUSD";
  if (normalized === "ETH/USD") return "X:ETHUSD";
  if (normalized === "US500") return "I:SPX";
  if (normalized === "NAS100") return "I:NDX";
  return null;
}

function toPolygonTimespan(interval = "") {
  return ({
    "15min": { multiplier: 15, timespan: "minute" },
    "30min": { multiplier: 30, timespan: "minute" },
    "1h": { multiplier: 1, timespan: "hour" },
    "1day": { multiplier: 1, timespan: "day" },
    "1d": { multiplier: 1, timespan: "day" },
  })[interval] || null;
}

function polygonLookbackMs(interval = "") {
  if (interval === "1day" || interval === "1d") return 140 * 24 * 60 * 60 * 1000;
  return 7 * 24 * 60 * 60 * 1000;
}

function cachedHistories(cache, prices) {
  return Object.fromEntries(symbols.map((symbol) => {
    const price = prices[symbol];
    return [symbol, price?.open && isUsableLivePrice(price) ? cachedHistory(symbol, cache) : []];
  }));
}

function cachedHistory(symbol, cache) {
  const cached = cache.histories?.[symbol];
  if (!cached || !Array.isArray(cached.bars) || !isRecentCache(cached, 6 * 60 * 60 * 1000)) return [];
  const bars = cached.bars
    .map((bar) => ({ close: Number(bar.close), high: Number(bar.high), low: Number(bar.low), datetime: bar.datetime }))
    .filter((bar) => Number.isFinite(bar.close));
  tagHistory(bars, `cache:${cached.source || "history"}`, !isRecentCache(cached, 20 * 60 * 1000));
  return bars;
}

function tagHistory(bars, source, stale) {
  Object.defineProperty(bars, "_meta", {
    value: { source, stale, asOf: new Date().toISOString() },
    enumerable: false,
  });
  return bars;
}

function buildDeterministicSignals(prices, histories) {
  return symbols.map((symbol) => {
    const price = prices[symbol] || pricePayload(symbol, fallbackPrices[symbol], "fallback", "missing_price");
    const history = histories[symbol] || [];
    const base = fallbackSignals.find((signal) => signal.paire === symbol) || fallbackSignals[0];
    const inactive = (reason) => ({
      ...base,
      paire: symbol,
      raison: reason,
      open: price.open,
      direct: false,
      source: price.source,
      suspended: true,
      nextOpen: !price.open && assetClass(symbol) !== "crypto" ? marketStatus().forex.nextOpen : null,
      quality: qualityPayload(price, history, false, reason),
    });

    if (!price.open) return inactive("Marché fermé · analyse auto suspendue jusqu'à la réouverture.");
    if (!isUsableLivePrice(price)) return inactive("Analyse auto suspendue · donnée non fiable ou fallback.");
    if (history.length < 30) return cautiousSignal(symbol, price, base, "Historique gratuit insuffisant · signal prudent basé sur prix live.");

    const closes = history.map((bar) => bar.close);
    const last = Number(price.price);
    const sma10 = average(closes.slice(-10));
    const sma30 = average(closes.slice(-30));
    const atr = average(history.slice(-14).map((bar) => Math.max(0, Number(bar.high) - Number(bar.low)))) || last * 0.004;
    const momentum = ((sma10 - sma30) / sma30) * 100;
    const rsi = calculateRsi(closes.slice(-15));
    const move = Number(price.change) || 0;
    const trendAligned = momentum >= 0 ? rsi >= 52 : rsi <= 48;
    const volatilityOk = atr / last >= 0.0008;
    const historyFresh = !history._meta?.stale;
    const confluence = [trendAligned, volatilityOk, historyFresh, Math.abs(move) >= 0.05].filter(Boolean).length;
    const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;

    if (!Number.isFinite(last) || !Number.isFinite(momentum) || !Number.isFinite(rsi)) {
      return cautiousSignal(symbol, price, base, "Indicateurs incomplets · signal prudent basé sur prix live.");
    }

    if (strength < 0.18 || confluence < 2 || !trendAligned) {
      return cautiousSignal(symbol, price, base, `Momentum faible · signal prudent, confluence ${confluence}/4.`);
    }

    const direction = momentum >= 0 ? "ACHAT" : "VENTE";
    const risk = Math.max(atr * 1.2, last * 0.0025);
    const entry = last;
    const sl = direction === "ACHAT" ? entry - risk : entry + risk;
    const tp1 = direction === "ACHAT" ? entry + risk * 1.6 : entry - risk * 1.6;
    const tp2 = direction === "ACHAT" ? entry + risk * 2.5 : entry - risk * 2.5;
    const freshnessPenalty = historyFresh ? 0 : 10;
    const confidence = Math.round(Math.max(48, Math.min(88, 52 + strength * 8 + history.length / 12 + confluence * 4 + (price.reliability || 60) / 12 - freshnessPenalty)));
    const technique = chooseTechnique(symbol, momentum, move);

    return {
      paire: symbol,
      direction,
      entree: roundLevel(entry),
      sl: roundLevel(sl),
      tp1: roundLevel(tp1),
      tp2: roundLevel(tp2),
      rr: "1:2.0",
      confiance: confidence,
      technique,
      raison: `Signal calculé: SMA10 ${direction === "ACHAT" ? ">" : "<"} SMA30, RSI ${rsi.toFixed(0)}, confluence ${confluence}/4.`,
      open: true,
      direct: true,
      source: price.source,
      suspended: false,
      nextOpen: null,
      quality: qualityPayload(price, history, true, `Source ${price.source}, historique ${history._meta?.source || "twelve_data"}, confluence ${confluence}/4.`),
      indicators: { sma10: roundLevel(sma10), sma30: roundLevel(sma30), rsi: Math.round(rsi), confluence },
    };
  });
}

function cautiousSignal(symbol, price, base, reason) {
  const last = Number(price.price || base.entree);
  const direction = Number(price.change) < 0 ? "VENTE" : "ACHAT";
  const risk = assistedRiskDistance(last, symbol);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.4 : entry - risk * 1.4;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.1 : entry - risk * 2.1;
  const confidence = Math.max(42, Math.min(62, Math.round((price.reliability || 55) * 0.65)));
  return {
    paire: symbol,
    direction,
    entree: roundLevel(entry),
    sl: roundLevel(sl),
    tp1: roundLevel(tp1),
    tp2: roundLevel(tp2),
    rr: "1:1.4",
    confiance: confidence,
    technique: chooseTechnique(symbol, 0, Number(price.change) || 0),
    raison: reason,
    open: price.open,
    direct: true,
    source: price.source,
    suspended: false,
    nextOpen: null,
    quality: qualityPayload(price, [], true, reason),
    cautious: true,
  };
}

function deterministicConfidence(body) {
  const entry = Number(body.entry);
  const current = Number(body.current);
  if (!Number.isFinite(entry) || !Number.isFinite(current) || entry <= 0) {
    return { score: 0, statut: "INVALIDE", message: "Donnée invalide" };
  }
  const direction = body.direction === "VENTE" ? -1 : 1;
  const move = ((current - entry) / entry) * 100 * direction;
  const score = Math.round(Math.max(5, Math.min(95, 62 + move * 18)));
  return {
    score,
    statut: score < 20 ? "INVALIDE" : score < 40 ? "FAIBLE" : score < 70 ? "MOYEN" : "FORT",
    message: score < 40 ? "Signal fragilisé" : "Signal cohérent",
  };
}

function qualityPayload(price, history, valid, reason) {
  return {
    valid,
    reason,
    source: price.source,
    stale: Boolean(price.stale),
    open: Boolean(price.open),
    reliability: price.reliability || 0,
    historySource: history._meta?.source || (history.length ? "twelve_data" : "none"),
    historyStale: Boolean(history._meta?.stale),
    bars: history.length,
    asOf: price.asOf,
  };
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : NaN;
}

function calculateRsi(closes) {
  if (!Array.isArray(closes) || closes.length < 15) return NaN;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

function chooseTechnique(symbol, momentum, move) {
  if (/BTC|ETH/i.test(symbol)) return Math.abs(momentum) > 0.6 ? "Elliott" : "Price Action";
  if (/XAU|XAG/i.test(symbol)) return Math.abs(move) > 0.8 ? "Wyckoff" : "SMC";
  if (/JPY/i.test(symbol)) return "Ichimoku";
  return Math.abs(momentum) > 0.35 ? "SMC" : "Price Action";
}

function roundLevel(value) {
  if (value >= 1000) return Number(value.toFixed(1));
  if (value >= 100) return Number(value.toFixed(2));
  return Number(value.toFixed(5));
}

function withMarketMeta(prices, source, error) {
  return Object.fromEntries(Object.entries(prices).map(([symbol, value]) => [symbol, pricePayload(symbol, value, source, error)]));
}

function pricePayload(symbol, value, source, error, options = {}) {
  const open = isSymbolOpen(symbol);
  const live = isLivePriceSource(source);
  return {
    ...value,
    source,
    error,
    open,
    stale: options.stale ?? (!live || !open),
    reliability: options.reliability ?? (live ? 85 : 20),
    assetClass: assetClass(symbol),
    asOf: new Date().toISOString(),
  };
}

function isLivePriceSource(source = "") {
  return ["twelve_data", "polygon", "alpha_vantage", "coinbase", "stooq"].includes(source);
}

function isUsableLivePrice(price) {
  return Boolean(price?.open && !price.stale && isLivePriceSource(price.source) && Number(price.reliability || 0) >= 70);
}

function marketStatus(now = new Date()) {
  const forexOpen = isForexOpen(now);
  const nextOpen = forexOpen ? null : nextForexOpen(now).toISOString();
  return {
    forex: {
      open: forexOpen,
      label: forexOpen ? "Forex ouvert" : "Forex fermé",
      nextOpen,
      reason: forexOpen ? "Session Forex active." : "Hors horaires Forex spot.",
      note: "Forex spot: dimanche 17:00 New York à vendredi 17:00 New York, hors jours fériés/liquidité réduite.",
    },
    crypto: { open: true, label: "Crypto ouvert 24/7" },
    serverTime: now.toISOString(),
    newYorkTime: formatInTimeZone(now, "America/New_York"),
    timezone: "America/New_York",
    generatedAt: now.toISOString(),
  };
}

function isSymbolOpen(symbol) {
  const type = assetClass(symbol);
  if (type === "crypto") return true;
  return isForexOpen();
}

function assetClass(symbol) {
  if (/BTC|ETH/i.test(symbol)) return "crypto";
  if (/XAU|XAG|OIL|WTI/i.test(symbol)) return "commodities";
  if (/US500|NAS|DAX|SPX/i.test(symbol)) return "indices";
  return "forex";
}

function isForexOpen(now = new Date()) {
  const ny = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now).reduce((acc, part) => ({ ...acc, [part.type]: part.value }), {});
  const day = ny.weekday;
  const minutes = Number(ny.hour) * 60 + Number(ny.minute);
  if (day === "Sat") return false;
  if (day === "Sun") return minutes >= 17 * 60;
  if (day === "Fri") return minutes < 17 * 60;
  return true;
}

function nextForexOpen(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  for (let i = 0; i < 8 * 24 * 60; i++) {
    if (isForexOpen(next)) return next;
    next.setMinutes(next.getMinutes() + 1);
  }
  return next;
}

function formatInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

async function getEconomicCalendar() {
  if (memoryCache.calendar.value && Date.now() < memoryCache.calendar.expiresAt) return memoryCache.calendar.value;
  const key = env.FINNHUB_API_KEY;
  if (!key) return [];
  try {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    const api = new URL("https://finnhub.io/api/v1/calendar/economic");
    api.searchParams.set("from", from);
    api.searchParams.set("to", to);
    api.searchParams.set("token", key);
    const data = await fetchJson(api);
    const events = data.economicCalendar || [];
    memoryCache.calendar = { value: events, expiresAt: Date.now() + 30 * 60 * 1000 };
    recordProviderHealth("finnhub_calendar", true);
    return events;
  } catch (error) {
    recordProviderHealth("finnhub_calendar", false, error.message);
    return [];
  }
}

async function economicRiskWindow(now = new Date()) {
  const events = await getEconomicCalendar();
  const windowMs = 45 * 60 * 1000;
  const relevant = events
    .map(normalizeCalendarEvent)
    .filter((event) => event.time && Math.abs(event.time.getTime() - now.getTime()) <= windowMs)
    .filter((event) => event.impact === "high");
  return {
    active: relevant.length > 0,
    events: relevant.slice(0, 5).map((event) => ({
      name: event.name,
      currency: event.currency,
      time: event.time.toISOString(),
      impact: event.impact,
    })),
    reason: relevant.length ? "News économique forte proche: signaux concernés suspendus." : "Aucune news rouge proche.",
  };
}

function normalizeCalendarEvent(event = {}) {
  const rawTime = event.time || event.datetime || event.date || event.period;
  const time = rawTime ? new Date(rawTime) : null;
  const impact = String(event.impact || event.importance || "").toLowerCase();
  return {
    name: String(event.event || event.name || event.title || "Événement macro"),
    currency: String(event.country || event.currency || event.region || "").toUpperCase(),
    impact: /high|3|rouge|important/.test(impact) ? "high" : /medium|2|moyen/.test(impact) ? "medium" : "low",
    time: time && Number.isFinite(time.getTime()) ? time : null,
  };
}

function applyNewsRisk(signals, newsRisk) {
  if (!newsRisk?.active) return signals;
  return signals.map((signal) => {
    const affected = newsRisk.events.some((event) => signalAffectedByNews(signal.paire, event.currency));
    if (!affected || signal.suspended) return signal;
    return {
      ...signal,
      direct: false,
      suspended: true,
      raison: `Analyse auto suspendue · ${newsRisk.reason}`,
      quality: { ...signal.quality, valid: false, reason: newsRisk.reason, newsBlocked: true },
    };
  });
}

function signalAffectedByNews(pair, currency) {
  if (!currency) return false;
  if (pair.includes(currency)) return true;
  if (currency === "USD" && /XAU|BTC|ETH|US500|NAS|SPX/i.test(pair)) return true;
  return false;
}

async function groq(prompt, maxTokens = 150, temperature = 0.3) {
  const key = env.GROQ_KEY || env.GROQ_API_KEY;
  if (!key) return geminiText(prompt, maxTokens, temperature);
  const models = [...new Set([GROQ_MODEL, GROQ_FALLBACK_MODEL])];
  for (const model of models) {
    try {
      return await groqOnce(key, model, prompt, maxTokens, temperature);
    } catch (error) {
      recordProviderHealth("groq", false, error.message);
      console.warn(`Groq failed with ${model}: ${error.message}`);
    }
  }
  return geminiText(prompt, maxTokens, temperature);
}

async function groqOnce(key, model, prompt, maxTokens, temperature) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
    }),
  });
  if (!response.ok) throw new Error(`groq_${response.status}`);
  const data = await response.json();
  recordProviderHealth("groq", true);
  return data.choices?.[0]?.message?.content?.trim() || "";
}

async function geminiText(prompt, maxTokens = 500, temperature = 0.3) {
  const key = env.GEMINI_API_KEY || env.GEMINI_KEY;
  if (!key) return "";
  for (const model of GEMINI_FALLBACK_MODELS) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      });
      if (!response.ok) throw new Error(`gemini_text_${response.status}_${model}`);
      const data = await response.json();
      recordProviderHealth("gemini_text", true);
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
    } catch (error) {
      recordProviderHealth("gemini_text", false, error.message);
      console.warn(`Gemini text failed with ${model}: ${error.message}`);
    }
  }
  return "";
}

async function geminiVision(prompt, images) {
  const key = env.GEMINI_API_KEY || env.GEMINI_KEY;
  if (!key) return "";
  for (const model of GEMINI_FALLBACK_MODELS) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              ...images.map((image) => ({ inline_data: { mime_type: image.mimeType, data: image.data } })),
            ],
          }],
          generationConfig: { temperature: 0.25, maxOutputTokens: 700 },
        }),
      });
      if (!response.ok) throw new Error(`gemini_${response.status}_${model}`);
      const data = await response.json();
      recordProviderHealth("gemini_vision", true);
      return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
    } catch (error) {
      recordProviderHealth("gemini_vision", false, error.message);
      console.warn(`Gemini failed with ${model}: ${error.message}`);
    }
  }
  return "";
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

function parseCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = splitCsvLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]));
  });
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (const char of String(line)) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function normalizeImages(images) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, 2).map((image) => {
    if (typeof image !== "string") return null;
    const match = image.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/i);
    return match ? { mimeType: match[1].toLowerCase(), data: match[2] } : null;
  }).filter(Boolean);
}

function normalizeChartDetection(value) {
  const raw = value && typeof value === "object" ? value : {};
  const pair = normalizePair(raw.primaryPair || raw.pair || raw.symbol);
  const timeframes = Array.isArray(raw.timeframes)
    ? raw.timeframes.map(normalizeTimeframe).filter(Boolean)
    : [normalizeTimeframe(raw.timeframe)].filter(Boolean);
  const uniqueTimeframes = [...new Set(timeframes)];
  const executionTimeframe = normalizeTimeframe(raw.executionTimeframe) || smallestTimeframe(uniqueTimeframes);
  const confidence = Math.max(0, Math.min(100, Number(raw.confidence) || 0));
  return {
    ok: Boolean(pair || uniqueTimeframes.length),
    primaryPair: pair,
    timeframes: uniqueTimeframes,
    executionTimeframe,
    platform: cleanLine(raw.platform || "unknown"),
    confidence,
    needsConfirmation: raw.needsConfirmation !== false || confidence < 85,
    reason: cleanLine(raw.reason || "Détection à confirmer par l'utilisateur."),
  };
}

function normalizePair(value) {
  const text = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!text) return null;
  const aliases = {
    GOLD: "XAU/USD",
    XAUUSD: "XAU/USD",
    SILVER: "XAG/USD",
    XAGUSD: "XAG/USD",
    PLATINUM: "XPT/USD",
    XPTUSD: "XPT/USD",
    PALLADIUM: "XPD/USD",
    XPDUSD: "XPD/USD",
    BTCUSD: "BTC/USD",
    ETHUSD: "ETH/USD",
    NAS100: "NAS100",
    US500: "US500",
  };
  if (aliases[text]) return aliases[text];
  if (/^[A-Z]{6}$/.test(text)) return `${text.slice(0, 3)}/${text.slice(3)}`;
  return null;
}

function normalizeTimeframe(value) {
  const text = String(value || "").toUpperCase().replace(/\s/g, "");
  const match = text.match(/^(M|H|D|W|MN)?(\d+)$/) || text.match(/^(\d+)(M|MIN|H|D|W)$/);
  if (!match) return ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN1"].includes(text) ? text : null;
  if (match[1] && match[2]) return `${match[1] === "MN" ? "MN" : match[1]}${match[2]}`;
  const unit = match[2] === "MIN" ? "M" : match[2];
  return `${unit}${match[1]}`;
}

function smallestTimeframe(timeframes) {
  return [...timeframes].sort((a, b) => timeframeMinutes(a) - timeframeMinutes(b))[0] || null;
}

function timeframeMinutes(tf) {
  const match = String(tf || "").match(/^(M|H|D|W|MN)(\d+)$/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[2]);
  const unit = match[1];
  if (unit === "M") return value;
  if (unit === "H") return value * 60;
  if (unit === "D") return value * 1440;
  if (unit === "W") return value * 10080;
  return value * 43200;
}

function parseJson(text, fallback) {
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }
}

function normalizeSignals(value, prices = {}) {
  const raw = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  const normalized = raw.map((signal, index) => {
    const fallback = fallbackSignals[index % fallbackSignals.length];
    const confidence = Number(signal.confiance ?? signal.confidence ?? fallback.confiance);
    const pair = String(signal.paire ?? signal.pair ?? fallback.paire);
    const price = prices[pair];
    const open = price?.open ?? isSymbolOpen(pair);
    const direct = isUsableLivePrice(price);
    return {
      paire: pair,
      direction: signal.direction === "VENTE" ? "VENTE" : "ACHAT",
      entree: finiteNumber(signal.entree ?? signal.entry, fallback.entree),
      sl: finiteNumber(signal.sl, fallback.sl),
      tp1: finiteNumber(signal.tp1, fallback.tp1),
      tp2: finiteNumber(signal.tp2, fallback.tp2),
      rr: String(signal.rr ?? fallback.rr),
      confiance: confidence <= 1 ? Math.round(confidence * 100) : Math.round(Math.max(0, Math.min(100, confidence))),
      technique: String(signal.technique ?? signal.tech ?? fallback.technique),
      raison: direct
        ? cleanLine(signal.raison ?? signal.reason ?? fallback.raison)
        : `${open ? "Analyse auto suspendue · donnée non fiable." : "Marché fermé · analyse auto suspendue jusqu'à la réouverture."}`,
      open,
      direct,
      source: price?.source || "fallback",
      suspended: !direct,
      nextOpen: !open && assetClass(pair) !== "crypto" ? marketStatus().forex.nextOpen : null,
    };
  });
  return [...normalized, ...fallbackSignals.slice(normalized.length)].slice(0, 6);
}

function normalizeAiAnswer(answer, seed = "") {
  const text = cleanLine(answer) || `📐 TECHNIQUE UTILISÉE : Price Action
📊 ANALYSE :
- Tendance : Neutre
- Signal détecté : Attendre confirmation
- Zone d'entrée : Marché actuel
- Stop Loss : Sous le dernier creux
- Take Profit : Prochaine résistance
⚠️ RISQUE : Ce n'est pas un conseil financier.
SCORE_CONFIANCE:62
TECHNIQUE_UTILISEE:Price Action`;
  return { answer: text, score: extractScore(text, seed), technique: extractTechnique(text) };
}

function buildDeterministicAnalysisText({ pair = "EUR/USD", timeframe = "H1", style = "Mixte", livePrice }) {
  const price = Number.isFinite(Number(livePrice?.price))
    ? Number(livePrice.price)
    : Number(fallbackPrices[pair]?.price) || 1;
  const direction = Number(livePrice?.change) < 0 ? "VENTE" : "ACHAT";
  const levels = buildAssistedLevels({
    direction,
    entry: Number.isFinite(price) ? price : NaN,
    sl: NaN,
    tp: NaN,
    tp2: NaN,
    live: price,
    pair,
  });
  const technique = style === "Mixte" ? "Price Action" : style;
  return `📐 TECHNIQUE UTILISÉE : ${technique} + prix live, car la vision IA n'a pas fourni un setup complet.
📊 ANALYSE :
- Tendance : ${direction === "ACHAT" ? "Haussière" : "Baissière"}
- Signal détecté : Setup prudent basé sur support/résistance, retest et prix live ${timeframe}
- Zone d'entrée : ${formatLevel(levels.entry)}
- Stop Loss : ${formatLevel(levels.sl)}
- Take Profit 1 : ${formatLevel(levels.tp)}
- Take Profit 2 : ${formatLevel(levels.tp2)}
✅ CONFLUENCE : Prix live ${pair} à confirmer sur le graphe
⚠️ RISQUE : Ce n'est pas un conseil financier.
SCORE_CONFIANCE:58
TECHNIQUE_UTILISEE:${technique}
STYLE_EFFICACITE:${technique}=58`;
}

function normalizeAnalysis(answer, body = {}, context = {}) {
  const normalized = normalizeAiAnswer(answer, body.pair || "");
  const text = normalized.answer;
  const validation = validateAnalysisStyle(text, body.style || "Mixte");
  const imageQuality = context.imageQuality || { score: 0, reason: "Non mesurée" };
  const hasChartImages = Number(imageQuality.images || 0) > 0;
  const calibration = context.calibration || { adjustment: 0, message: "Aucune calibration." };
  const livePrice = context.livePrice;
  const chartContext = context.chartContext || {};
  const live = Number(livePrice?.price);
  const meta = {
    pair: body.pair || "EUR/USD",
    timeframe: body.timeframe || "H1",
    style: body.style || "Mixte",
    risk: body.risk || "Standard 2%",
    livePrice: Number.isFinite(live) ? live : null,
    imageQuality,
    calibration,
    chartContext,
    styleComparison: validation.styleComparison,
  };
  if (hasChartImages && imageQuality.score < 20) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, imageQuality.score),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: qualité image insuffisante (${imageQuality.reason}).`,
      validation: { ...validation, valid: false, reason: `Qualité image insuffisante: ${imageQuality.reason}` },
      meta,
    });
  }
  const direction = /vente|baissi/i.test(text) ? "VENTE" : /achat|haussi/i.test(text) ? "ACHAT" : "ACHAT";
  let entry = extractLevel(text, /(?:zone d'entrée|entrée|entry)\s*:?\s*([0-9.,]+)/i, NaN);
  let sl = extractLevel(text, /(?:stop loss|sl)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp = extractLevel(text, /(?:take profit\s*1|tp1|take profit|tp)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp2 = extractLevel(text, /(?:take profit\s*2|tp2)\s*:?\s*([0-9.,]+)/i, NaN);
  let assistedLevels = buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair: body.pair });
  if (assistedLevels.used) {
    entry = assistedLevels.entry;
    sl = assistedLevels.sl;
    tp = assistedLevels.tp;
    tp2 = assistedLevels.tp2;
  }
  if (![entry, sl, tp].every(Number.isFinite)) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, 35),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: niveaux entrée/SL/TP incomplets et aucun prix live disponible pour générer un plan prudent.`,
      validation: { ...validation, valid: false, reason: "Niveaux entrée/SL/TP incomplets." },
      meta,
    });
  }
  let levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair });
  if (!levelCheck.valid) {
    const repairedLevels = buildAssistedLevels({ direction, entry: NaN, sl: NaN, tp: NaN, tp2: NaN, live, pair: body.pair });
    if (repairedLevels.used) {
      entry = repairedLevels.entry;
      sl = repairedLevels.sl;
      tp = repairedLevels.tp;
      tp2 = repairedLevels.tp2;
      assistedLevels = repairedLevels;
      levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair });
    }
  }
  if (!levelCheck.valid) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, levelCheck.score),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: ${levelCheck.reason}`,
      validation: { ...validation, valid: false, reason: levelCheck.reason },
      meta: { ...meta, levelCheck },
    });
  }
  const rr = rewardRisk(direction, entry, sl, tp);
  const effectiveImageScore = hasChartImages ? imageQuality.score : 65;
  const calibratedScore = Math.max(0, Math.min(100, Math.round(
    normalized.score * 0.42 + validation.score * 0.18 + effectiveImageScore * 0.2 + levelCheck.score * 0.2 + calibration.adjustment,
  )));
  if (calibratedScore < 30) {
    return blockAnalysis(normalized, {
      score: calibratedScore,
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: score d'efficacité insuffisant (${calibratedScore}%).`,
      validation: { ...validation, valid: false, reason: "Score d'efficacité insuffisant." },
      meta: { ...meta, levelCheck, rr },
    });
  }
  return {
    ...normalized,
    direction,
    entry: formatLevel(entry),
    sl: formatLevel(sl),
    tp1: formatLevel(tp),
    tp2: formatLevel(Number.isFinite(tp2) ? tp2 : projectTp2(direction, entry, sl, tp)),
    rr: `1:${rr.toFixed(1)}`,
    score: calibratedScore,
    explanation: `${text}\n\nVALIDATION KRONOS: ${validation.reason} Niveaux cohérents. R/R calculé 1:${rr.toFixed(1)}. ${calibration.message}`,
    validation,
    meta: { ...meta, levelCheck, rr, styleComparison: validation.styleComparison, assistedLevels: assistedLevels.used ? assistedLevels.reason : null },
  };
}

function blockAnalysis(normalized, details) {
  return {
    ...normalized,
    direction: "AUCUN SIGNAL",
    entry: "—",
    sl: "—",
    tp1: "—",
    tp2: "—",
    rr: "—",
    score: details.score,
    technique: details.technique,
    explanation: details.explanation,
    validation: details.validation,
    meta: details.meta,
    noSignal: true,
  };
}

const styleRules = {
  ICT: {
    technique: "ICT",
    groups: [["order block", "ob", "fvg", "fair value gap"], ["liquidité", "liquidity", "sweep"], ["bos", "choch", "break of structure"]],
  },
  SMC: {
    technique: "SMC",
    groups: [["bos", "break of structure"], ["choch", "msb", "market structure"], ["liquidité", "liquidity", "inducement"]],
  },
  Wyckoff: {
    technique: "Wyckoff",
    groups: [["accumulation", "distribution", "spring", "utad"], ["phase", "range"], ["volume", "effort", "résultat"]],
  },
  Elliott: {
    technique: "Elliott",
    groups: [["vague", "wave"], ["1", "2", "3", "4", "5", "abc"], ["invalidation", "correction", "impulsion"]],
  },
  "Price Action": {
    technique: "Price Action",
    groups: [["support", "résistance", "resistance"], ["cassure", "breakout", "retest"], ["chandelier", "bougie", "pattern"]],
  },
  Ichimoku: {
    technique: "Ichimoku",
    groups: [["kumo", "nuage"], ["tenkan", "kijun"], ["chikou", "span"]],
  },
  "Hybride SMC+Chartiste": {
    technique: "Hybride",
    groups: [["bos", "choch", "liquidité", "order block", "smc"], ["support", "résistance", "cassure", "retest"], ["confluence", "confirmation"]],
  },
};

function validateAnalysisStyle(text, style) {
  if (style === "Mixte") return validateMixedStyle(text);
  const selected = styleRules[style] || styleRules["Hybride SMC+Chartiste"];
  const scored = scoreStyleRule(text, selected);
  const valid = scored.matchedGroups.length >= 1 && scored.hasDirection && scored.hasRisk && scored.hasLevels && scored.score >= 45;
  return {
    valid,
    style,
    technique: selected.technique,
    score: scored.score,
    matched: scored.matchedGroups.length,
    required: selected.groups.length,
    reason: valid
      ? `Style ${style} validé: ${scored.matchedGroups.length}/${selected.groups.length} familles confirmées.`
      : `Style ${style} faible mais utilisable: ${scored.matchedGroups.length}/${selected.groups.length} familles confirmées, direction=${scored.hasDirection}, risque=${scored.hasRisk}, niveaux=${scored.hasLevels}.`,
  };
}

function validateMixedStyle(text) {
  const candidates = Object.entries(styleRules)
    .filter(([style]) => style !== "Hybride SMC+Chartiste")
    .map(([style, rule]) => {
      const scored = scoreStyleRule(text, rule);
      return {
        style,
        technique: rule.technique,
        score: scored.score,
        matched: scored.matchedGroups.length,
        required: rule.groups.length,
        hasDirection: scored.hasDirection,
        hasRisk: scored.hasRisk,
        hasLevels: scored.hasLevels,
      };
    })
    .sort((a, b) => b.score - a.score || b.matched - a.matched);
  const best = candidates[0] || { style: "Price Action", technique: "Price Action", score: 0, matched: 0, required: 3 };
  const valid = best.matched >= 1 && best.hasDirection && best.hasRisk && best.hasLevels && best.score >= 45;
  return {
    valid,
    style: "Mixte",
    technique: best.technique,
    score: best.score,
    matched: best.matched,
    required: best.required,
    styleComparison: {
      bestStyle: best.style,
      bestScore: best.score,
      candidates: candidates.map((item) => ({ style: item.style, score: item.score, matched: item.matched, required: item.required })),
    },
    reason: valid
      ? `Mode Mixte: ${best.style} retenu avec ${best.score}% d'efficacité visible (${best.matched}/${best.required} familles).`
      : `Mode Mixte prudent: meilleur style ${best.style} à ${best.score}%, confirmations partielles.`,
  };
}

function scoreStyleRule(text, selected) {
  const haystack = normalizeForSearch(text);
  const matchedGroups = selected.groups.filter((group) => group.some((term) => haystack.includes(normalizeForSearch(term))));
  const hasDirection = /achat|vente|haussi|baissi|neutre/i.test(text);
  const hasRisk = /risque|stop loss|sl/i.test(text);
  const hasLevels = /(?:zone d'entrée|entrée|entry).{0,30}[0-9]/i.test(text)
    && /(?:stop loss|sl).{0,30}[0-9]/i.test(text)
    && /(?:take profit|tp).{0,30}[0-9]/i.test(text);
  const score = Math.max(0, Math.min(100, Math.round((matchedGroups.length / selected.groups.length) * 70 + (hasDirection ? 10 : 0) + (hasRisk ? 10 : 0) + (hasLevels ? 10 : 0))));
  return {
    score,
    matchedGroups,
    hasDirection,
    hasRisk,
    hasLevels,
  };
}

function assessImageQuality(images) {
  if (!images.length) return { score: 0, reason: "aucune image" };
  const sizes = images.map((image) => Math.round((image.data.length * 3) / 4));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const avg = total / images.length;
  let score = 45;
  if (images.length >= 2) score += 12;
  if (avg > 120000) score += 15;
  if (avg > 300000) score += 10;
  if (avg < 45000) score -= 22;
  score = Math.max(0, Math.min(100, Math.round(score)));
  const reason = `${images.length} image(s), taille moyenne ${Math.round(avg / 1024)}KB`;
  return { score, reason, images: images.length, averageBytes: Math.round(avg) };
}

function validateTradeLevels({ direction, entry, sl, tp, live, pair }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { valid: false, score: 0, reason: "Niveaux numériques invalides." };
  const buy = direction === "ACHAT";
  if (buy && !(sl < entry && tp > entry)) return { valid: false, score: 20, reason: "Pour un achat, SL doit être sous l'entrée et TP au-dessus." };
  if (!buy && !(sl > entry && tp < entry)) return { valid: false, score: 20, reason: "Pour une vente, SL doit être au-dessus de l'entrée et TP sous l'entrée." };
  const rr = rewardRisk(direction, entry, sl, tp);
  if (!Number.isFinite(rr) || rr < 1.2) return { valid: false, score: 35, reason: `R/R trop faible (${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}).` };
  if (Number.isFinite(live)) {
    const distance = Math.abs(entry - live) / Math.max(Math.abs(live), 1);
    const tolerance = levelTolerance(pair);
    if (distance > tolerance) {
      return { valid: true, score: 50, reason: `Niveaux cohérents, mais entrée éloignée du prix live (${(distance * 100).toFixed(2)}%). À confirmer avant exécution.` };
    }
  }
  return { valid: true, score: Math.max(55, Math.min(100, Math.round(55 + rr * 12))), reason: "Niveaux cohérents avec direction, R/R et prix live." };
}

function buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair }) {
  if ([entry, sl, tp].every(Number.isFinite)) {
    return { used: false, entry, sl, tp, tp2 };
  }
  if (!Number.isFinite(live) || live <= 0) {
    return { used: false, entry, sl, tp, tp2 };
  }
  const buy = direction !== "VENTE";
  const risk = assistedRiskDistance(live, pair);
  const finalEntry = Number.isFinite(entry) ? entry : live;
  const finalSl = Number.isFinite(sl) ? sl : buy ? finalEntry - risk : finalEntry + risk;
  const finalTp = Number.isFinite(tp) ? tp : buy ? finalEntry + risk * 1.6 : finalEntry - risk * 1.6;
  const finalTp2 = Number.isFinite(tp2) ? tp2 : buy ? finalEntry + risk * 2.4 : finalEntry - risk * 2.4;
  return {
    used: true,
    entry: finalEntry,
    sl: finalSl,
    tp: finalTp,
    tp2: finalTp2,
    reason: "Niveaux assistés générés depuis le prix live car Gemini n'a pas fourni tous les chiffres.",
  };
}

function assistedRiskDistance(price, pair = "") {
  if (/BTC/i.test(pair)) return Math.max(price * 0.006, 250);
  if (/ETH/i.test(pair)) return Math.max(price * 0.008, 12);
  if (/XAU/i.test(pair)) return Math.max(price * 0.0025, 8);
  if (/XAG/i.test(pair)) return Math.max(price * 0.006, 0.18);
  if (/US500|NAS|SPX/i.test(pair)) return Math.max(price * 0.0035, 18);
  if (/JPY/i.test(pair)) return Math.max(price * 0.0025, 0.25);
  return Math.max(price * 0.0018, 0.0018);
}

function levelTolerance(pair = "") {
  if (/BTC|ETH/i.test(pair)) return 0.035;
  if (/XAU|XAG|US500|NAS|SPX/i.test(pair)) return 0.025;
  if (/JPY/i.test(pair)) return 0.018;
  return 0.012;
}

function rewardRisk(direction, entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return risk > 0 ? reward / risk : NaN;
}

function projectTp2(direction, entry, sl, tp1) {
  const risk = Math.abs(entry - sl);
  const rr2 = Math.max(rewardRisk(direction, entry, sl, tp1), 2.0);
  return direction === "ACHAT" ? entry + risk * Math.min(rr2 + 0.8, 4) : entry - risk * Math.min(rr2 + 0.8, 4);
}

async function loadMarketCache() {
  try {
    const raw = await readFile(marketCachePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      prices: parsed.prices && typeof parsed.prices === "object" ? parsed.prices : {},
      histories: parsed.histories && typeof parsed.histories === "object" ? parsed.histories : {},
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { version: 1, prices: {}, histories: {}, updatedAt: null };
  }
}

async function saveMarketCache(cache) {
  await mkdir(dataDir, { recursive: true });
  const trimmed = {
    version: 1,
    prices: cache.prices || {},
    histories: Object.fromEntries(Object.entries(cache.histories || {}).map(([symbol, history]) => [symbol, {
      source: history.source,
      asOf: history.asOf,
      bars: Array.isArray(history.bars) ? history.bars.slice(-80) : [],
    }])),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(marketCachePath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  return trimmed;
}

function mergeCachedPrices(existing, prices) {
  const next = { ...existing };
  for (const [symbol, price] of Object.entries(prices)) {
    if (isLivePriceSource(price.source) && Number.isFinite(Number(price.price))) {
      next[symbol] = {
        price: Number(price.price),
        change: Number(price.change) || 0,
        source: price.source,
        reliability: price.reliability,
        asOf: price.asOf,
      };
    }
  }
  return next;
}

function mergeCachedHistories(existing, histories) {
  const next = { ...existing };
  for (const [symbol, bars] of Object.entries(histories)) {
    if (Array.isArray(bars) && bars.length >= 30 && !bars._meta?.stale) {
      next[symbol] = {
        source: bars._meta?.source || "twelve_data",
        asOf: new Date().toISOString(),
        bars: bars.slice(-80),
      };
    }
  }
  return next;
}

function isRecentCache(item, ttlMs) {
  const asOf = item?.asOf ? new Date(item.asOf).getTime() : 0;
  return Boolean(asOf && Date.now() - asOf <= ttlMs);
}

function cacheTtlMs(symbol) {
  if (/BTC|ETH/i.test(symbol)) return 5 * 60 * 1000;
  return isSymbolOpen(symbol) ? 10 * 60 * 1000 : 12 * 60 * 60 * 1000;
}

async function marketCacheSummary() {
  const cache = await loadMarketCache();
  return {
    updatedAt: cache.updatedAt,
    prices: Object.fromEntries(symbols.map((symbol) => [symbol, {
      cached: Boolean(cache.prices?.[symbol]),
      asOf: cache.prices?.[symbol]?.asOf || null,
      source: cache.prices?.[symbol]?.source || null,
    }])),
    histories: Object.fromEntries(symbols.map((symbol) => [symbol, {
      cached: Boolean(cache.histories?.[symbol]?.bars?.length),
      bars: cache.histories?.[symbol]?.bars?.length || 0,
      asOf: cache.histories?.[symbol]?.asOf || null,
    }])),
  };
}

function recordProviderHealth(provider, ok, error = null) {
  const previous = providerHealth.get(provider) || { ok: 0, fail: 0 };
  providerHealth.set(provider, {
    ok: previous.ok + (ok ? 1 : 0),
    fail: previous.fail + (ok ? 0 : 1),
    lastOk: ok ? new Date().toISOString() : previous.lastOk || null,
    lastFail: ok ? previous.lastFail || null : new Date().toISOString(),
    lastError: ok ? null : error,
  });
}

function providerHealthSnapshot() {
  return Object.fromEntries([...providerHealth.entries()].map(([name, value]) => [name, {
    ...value,
    status: value.fail > value.ok && !value.lastOk ? "down" : value.fail > value.ok ? "degraded" : "ok",
  }]));
}

function healthRecommendations() {
  const tips = [];
  if (!env.ALPHA_VANTAGE_API_KEY) tips.push("Ajouter ALPHA_VANTAGE_API_KEY dans secret.dev pour un fallback prix Forex/Crypto.");
  tips.push("Fallbacks sans clé actifs: Coinbase pour BTC/ETH spot, Frankfurter pour Forex fiat indicatif journalier.");
  if (!env.TWELVE_DATA_API_KEY && !env.TWELVEDATA_API_KEY) tips.push("Ajouter TWELVE_DATA_API_KEY: source principale prix + historiques.");
  if (!env.GEMINI_API_KEY && !env.GEMINI_KEY) tips.push("Ajouter GEMINI_API_KEY: obligatoire pour analyser les screenshots.");
  if (!tips.length) tips.push("Toutes les clés principales sont présentes; surveiller /api/health pour les dégradations.");
  return tips;
}

async function loadLearningLog() {
  try {
    const raw = await readFile(learningPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { version: 1, analyses: [], outcomes: [], updatedAt: null };
  }
}

async function saveLearningLog(log) {
  await mkdir(dataDir, { recursive: true });
  const trimmed = {
    version: 1,
    analyses: log.analyses.slice(-600),
    outcomes: log.outcomes.slice(-1000),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(learningPath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  return trimmed;
}

async function recordLearningAnalysis(result, body, context) {
  const log = await loadLearningLog();
  const id = `ana_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const active = !result.noSignal && result.direction !== "AUCUN SIGNAL";
  const entry = parseFormattedNumber(result.entry);
  const sl = parseFormattedNumber(result.sl);
  const tp1 = parseFormattedNumber(result.tp1);
  log.analyses.push({
    id,
    createdAt: new Date().toISOString(),
    pair: body.pair || "EUR/USD",
    timeframe: body.timeframe || "H1",
    style: body.style || "Hybride SMC+Chartiste",
    risk: body.risk || "Standard 2%",
    direction: result.direction,
    entry,
    sl,
    tp1,
    rr: result.rr,
    score: Number(result.score) || 0,
    active,
    status: active ? "OPEN" : "BLOCKED",
    blockReason: active ? null : result.validation?.reason || "Signal bloqué",
    livePriceAtSignal: context.livePrice?.price ?? null,
    imageQuality: context.imageQuality,
    calibration: context.calibration,
    validation: result.validation,
  });
  await saveLearningLog(log);
  result.learningId = id;
  return id;
}

async function updateLearningOutcomes(prices = null) {
  const log = await loadLearningLog();
  const livePrices = prices || await getPrices();
  let changed = false;
  for (const analysis of log.analyses) {
    if (analysis.status !== "OPEN" || !analysis.active) continue;
    const price = Number(livePrices[analysis.pair]?.price);
    if (!Number.isFinite(price)) continue;
    const outcome = evaluateOutcome(analysis, price);
    const ageHours = (Date.now() - new Date(analysis.createdAt).getTime()) / 3600000;
    if (outcome || ageHours >= 24) {
      const finalOutcome = outcome || {
        status: "EXPIRED",
        result: "neutral",
        price,
        reason: "Ni TP1 ni SL touché après 24h.",
      };
      analysis.status = finalOutcome.status;
      analysis.closedAt = new Date().toISOString();
      analysis.closePrice = price;
      analysis.outcome = finalOutcome.result;
      analysis.outcomeReason = finalOutcome.reason;
      log.outcomes.push({
        id: analysis.id,
        pair: analysis.pair,
        timeframe: analysis.timeframe,
        style: analysis.style,
        score: analysis.score,
        result: finalOutcome.result,
        status: finalOutcome.status,
        closedAt: analysis.closedAt,
      });
      changed = true;
    }
  }
  return changed ? saveLearningLog(log) : log;
}

function evaluateOutcome(analysis, price) {
  const buy = analysis.direction === "ACHAT";
  if (![analysis.entry, analysis.sl, analysis.tp1].every(Number.isFinite)) return null;
  if (buy && price >= analysis.tp1) return { status: "TP1_HIT", result: "win", price, reason: "TP1 touché." };
  if (buy && price <= analysis.sl) return { status: "SL_HIT", result: "loss", price, reason: "Stop Loss touché." };
  if (!buy && price <= analysis.tp1) return { status: "TP1_HIT", result: "win", price, reason: "TP1 touché." };
  if (!buy && price >= analysis.sl) return { status: "SL_HIT", result: "loss", price, reason: "Stop Loss touché." };
  return null;
}

function calibrationFor(log, body = {}) {
  const pair = body.pair || "EUR/USD";
  const timeframe = body.timeframe || "H1";
  const style = body.style || "Mixte";
  const buckets = [
    (item) => item.style === style && item.pair === pair && item.timeframe === timeframe,
    (item) => item.style === style && item.pair === pair,
    (item) => item.style === style,
  ];
  for (const matches of buckets) {
    const sample = log.outcomes.filter((item) => matches(item) && ["win", "loss"].includes(item.result)).slice(-50);
    if (sample.length >= 5) {
      const wins = sample.filter((item) => item.result === "win").length;
      const winRate = wins / sample.length;
      const adjustment = Math.round((winRate - 0.55) * 35);
      return {
        samples: sample.length,
        winRate: Math.round(winRate * 100),
        adjustment: Math.max(-15, Math.min(12, adjustment)),
        message: `${sample.length} résultats historiques, winrate ${Math.round(winRate * 100)}%, ajustement ${Math.max(-15, Math.min(12, adjustment))}.`,
      };
    }
  }
  return { samples: 0, winRate: null, adjustment: -3, message: "Pas assez d'historique: prudence automatique -3." };
}

function learningSummary(log) {
  const closed = log.outcomes.filter((item) => ["win", "loss"].includes(item.result));
  const wins = closed.filter((item) => item.result === "win").length;
  const byStyle = Object.fromEntries(Object.keys(styleRules).map((style) => {
    const items = closed.filter((item) => item.style === style);
    const styleWins = items.filter((item) => item.result === "win").length;
    return [style, {
      samples: items.length,
      winRate: items.length ? Math.round((styleWins / items.length) * 100) : null,
    }];
  }));
  return {
    updatedAt: log.updatedAt,
    totalAnalyses: log.analyses.length,
    openAnalyses: log.analyses.filter((item) => item.status === "OPEN").length,
    blockedAnalyses: log.analyses.filter((item) => item.status === "BLOCKED").length,
    closedAnalyses: closed.length,
    globalWinRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    byStyle,
    note: "Apprentissage contrôlé: Kronos calibre ses scores avec les résultats, sans modifier le code automatiquement.",
  };
}

function parseFormattedNumber(value) {
  if (typeof value === "number") return value;
  const normalized = String(value || "").replace(/\s/g, "").replace(",", ".");
  const number = Number(normalized);
  return Number.isFinite(number) ? number : NaN;
}

function normalizeForSearch(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function extractScore(text, seed = "") {
  const match = String(text).match(/SCORE_CONFIANCE\s*:?\s*(\d{1,3})/i);
  if (match) return Math.max(0, Math.min(100, Number(match[1])));
  return 64 + (seed.length % 24);
}

function extractTechnique(text) {
  const known = ["Mixte", "ICT", "Wyckoff", "Elliott", "Price Action", "Ichimoku", "SMC"];
  const match = String(text).match(/TECHNIQUE_UTILISEE\s*:?\s*([^\n\r]+)/i);
  if (match) {
    const captured = cleanLine(match[1])
      .replace(/\b(?:SCORE_CONFIANCE|STYLE_EFFICACITE)\b.*$/i, "")
      .trim();
    if (/^PA\b/i.test(captured)) return "Price Action";
    return known.find((item) => new RegExp(`\\b${item.replace(" ", "\\s+")}\\b`, "i").test(captured)) || captured.slice(0, 28);
  }
  return known.find((item) => new RegExp(item, "i").test(text)) || "Price Action";
}

function extractLevel(text, regex, fallback) {
  const match = String(text).match(regex);
  if (!match) return fallback;
  const value = Number(match[1].replace(",", "."));
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatLevel(value) {
  if (value >= 1000) return Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  if (value >= 100) return Number(value).toFixed(2);
  return Number(value).toFixed(4);
}

function cleanLine(text) {
  return String(text || "").replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

async function serveStatic(res, pathname) {
  if ((pathname === "/admin" || pathname === "/admin-health" || pathname === "/admin-health.html") && env.ADMIN_HEALTH_PUBLIC !== "true") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const aliases = {
    "/analyse": "/analyse.html",
    "/paiement": "/paiement.html",
    "/abonnement": "/paiement.html",
    "/admin-health": "/admin-health.html",
    "/admin": "/admin-health.html",
    "/legal": "/legal.html",
    "/cgu": "/legal.html",
    "/confidentialite": "/legal.html",
    "/mentions-legales": "/legal.html",
    "/risques": "/legal.html",
  };
  pathname = aliases[pathname] || pathname;
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, safe === "/" ? "index.html" : safe);
  if (!existsSync(file) && !extname(file)) file = join(root, "index.html");
  if (!existsSync(file)) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
