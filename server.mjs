import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { MongoClient } from "mongodb";

const root = fileURLToPath(new URL(".", import.meta.url));
const env = await loadEnv(join(root, "secret.dev"));
const port = Number(env.PORT || 4174);
const dataDir = join(root, "data");
const learningPath = join(dataDir, "learning-log.json");
const marketCachePath = join(dataDir, "market-cache.json");
const authPath = join(dataDir, "auth-store.json");
const mongoUri = env.MONGODB_URI || env.MONGO_URI || "";
const mongoDbName = env.MONGODB_DB || env.MONGO_DB || inferMongoDbName(mongoUri) || "oracle_forex";
let mongoClientPromise = null;
let mongoUnavailable = false;
let mongoLastError = null;
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
const TWELVE_DATA_KEYS = collectEnvKeys("TWELVE_DATA_API_KEY", "TWELVEDATA_API_KEY");
const MASSIVE_KEYS = collectEnvKeys("MASSIVE_API_KEY", "MASSIVE_KEY");
const ALPHA_VANTAGE_KEYS = collectEnvKeys("ALPHA_VANTAGE_API_KEY");
const EXCHANGERATE_KEYS = collectEnvKeys("EXCHANGERATE_API_KEY");
const GROQ_KEYS = collectEnvKeys("GROQ_KEY", "GROQ_API_KEY");
const GEMINI_KEYS = collectEnvKeys("GEMINI_API_KEY", "GEMINI_KEY");
const FINNHUB_KEYS = collectEnvKeys("FINNHUB_API_KEY");
const MARKETAUX_KEYS = collectEnvKeys("MARKETAUX_API_KEY");
const rotationCounters = {
  twelveData: 0,
  alphaVantage: 0,
  exchangeRate: 0,
  groq: 0,
  finnhub: 0,
  marketaux: 0,
};
const exhaustedKeys = new Map();
const symbols = ["EUR/USD", "XAU/USD", "BTC/USD", "GBP/JPY", "US500", "ETH/USD"];

// Static fallback only: emergency display values when every live source fails.
// They are intentionally low-reliability and must never validate a direct setup.
const fallbackPrices = {
  "EUR/USD": { price: 1.0850, change: 0 },
  "XAU/USD": { price: 2350.0, change: 0 },
  "BTC/USD": { price: 65000, change: 0 },
  "GBP/JPY": { price: 195.0, change: 0 },
  US500: { price: 5200.0, change: 0 },
  "ETH/USD": { price: 3000.0, change: 0 },
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

const KRONOS_DATA_POLICY = `DONNÉES ET FIABILITÉ DISPONIBLES
Les sources à clés utilisent une rotation automatique multi-clés. Une clé épuisée ou en quota est mise en pause temporaire, puis une autre clé est essayée.
- Twelve Data: source principale prix/historique Forex, métaux, indices si clé disponible; fiabilité cible 95.
- Massive: source de secours prix/historique si clé disponible; fiabilité cible 88.
- Binance: crypto uniquement, sans clé; fiabilité cible 90. Ne l'utilise pas pour l'or, les indices ou le Forex fiat.
- Alpha Vantage: fallback Forex/crypto; fiabilité cible 80.
- Coinbase: fallback crypto spot BTC/ETH; fiabilité cible 78.
- Stooq: fallback historique/indicatif, souvent différé; fiabilité cible 72.
- ExchangeRate-API: taux fiat indicatifs uniquement; fiabilité cible 62. Ne valide jamais un setup direct avec cette seule source.
- Frankfurter/BCE: taux quotidiens de dernier recours; ne sert pas à produire un signal intraday.
- Finnhub: calendrier économique quand disponible. Marketaux: actualités quand disponible.
- Vision: Groq Vision LLaMA 4 Scout/Maverick en priorité, Gemini Vision en fallback.
- Historique: jusqu'à 80 bougies; >=50 bougies = analyse technique complète, 30-49 = partielle, <30 = prudence/prix live seulement.
- Si la source live est absente, faible, différée ou incohérente, baisse le score et signale la limite. N'invente jamais une donnée manquante.`;

const KRONOS_CHART_POLICY = `LECTURE DES GRAPHES
Lis uniquement ce qui est visible. Ne prétends jamais voir un order block, FVG, nuage Ichimoku, vague Elliott, divergence ou chandelier si l'image ne le montre pas clairement.
Plateformes possibles: TradingView, MT4, MT5, cTrader, Binance, Coinbase Advanced, OANDA, XTB, IG ou inconnue.
Pour chaque image, identifie si visible: plateforme, instrument, timeframe, type de graphe, tendance, structure HH/HL ou LH/LL, supports/résistances, liquidité, patterns, indicateurs, dessins utilisateur.
Le site accepte 2 graphes maximum. Avec 2 graphes: le timeframe le plus élevé donne le biais, le plus petit donne l'entrée. S'ils se contredisent, retourne AUCUN SIGNAL ou un score faible.
Qualité image: >=70 analyse complète; 50-69 analyse partielle; 30-49 analyse prudente croisée avec API; <30 bloque l'analyse visuelle directe.
Si aucun graphe n'est fourni, écris "Analyse sans screenshot", utilise seulement le prix live et le formulaire, et ne cite aucun élément visuel. Si un prix live fiable est disponible, tu peux proposer un plan éducatif prudent avec score plafonné à 60; sinon retourne AUCUN SIGNAL.`;

const KRONOS_METHOD_POLICY = `MÉTHODES D'ANALYSE SUPPORTÉES
Techniques finales autorisées pour TECHNIQUE_UTILISEE: ICT, SMC, Wyckoff, Elliott, Price Action, Ichimoku, Hybride SMC+Chartiste.
Confluences secondaires possibles dans l'explication: Supply/Demand, VSA, Harmonic, Fibonacci, chartisme classique, chandeliers japonais, volume, psychologie du marché. Elles ne doivent pas remplacer la technique finale autorisée.

Price Action: structure HH/HL ou LH/LL, range, supports/résistances, cassure/retest, measured move, chandeliers de confirmation. Le contexte prime toujours sur une bougie isolée.
SMC: order block, FVG, BOS, CHOCH, MSB, inducement, liquidité, mitigation, premium/discount, breaker block. Un CHOCH seul est une alerte, pas une confirmation.
ICT: kill zones, liquidity sweep, Judas swing, OTE, Power of 3, Silver Bullet et macros uniquement si l'heure/session ou le contexte est fourni.
Wyckoff: accumulation/distribution, Selling Climax, Automatic Rally, Spring, SOS, LPS, Buying Climax, UTAD, effort/résultat. Un Spring/UTAD visible est prioritaire.
Elliott: impulsion 1-5, correction ABC, invalidation claire, règles absolues de vague 2, vague 3 et vague 4. Ne force jamais un comptage ambigu.
Ichimoku: prix vs Kumo, Tenkan/Kijun, Chikou, twist, Kijun bounce. Signal fort seulement si au moins 2-3 confirmations sont alignées.
Supply & Demand: DBR/RBD, zones fraîches, nombre de retests. Une zone fraîche + OB/FVG au même niveau renforce la confluence.
Harmonic: XABCD, Gartley, Bat, Butterfly, Crab, Cypher seulement si les points et ratios sont visibles; attendre confirmation au point D.
VSA: No Supply, No Demand, Stopping Volume, Upthrust, effort/résultat seulement si volume ou spread est visible.
Chartisme: H&S, double top/bottom, triangles, drapeaux, fanions, wedges, cup & handle. Attendre clôture et retest avant breakout.
Indicateurs: RSI, MACD, Bollinger, ATR, moyennes mobiles seulement quand visibles ou fournis par le serveur.
Mixte: compare les techniques supportées, retiens celle qui possède les preuves les plus nettes et donne STYLE_EFFICACITE.`;

const KRONOS_STRATEGY_POLICY = `STRATÉGIES DE TRADING
Scalping: M1-M15, idéalement London Open ou NY Open, SL court, TP court, R:R minimum 1:1.5, risque réduit.
Day Trading: contexte H1/H4, entrée M15/M30, volatilité session London/NY, R:R minimum 1:2.
Swing Trading: contexte Daily/H4, entrée H4/H1, niveaux majeurs, R:R minimum 1:2.5.
Position Trading: Weekly/Daily, drivers fondamentaux, SL plus large, R:R minimum 1:3.
Breakout: cassure + clôture + retest; signal faible si la cassure n'est pas confirmée.
Reversal: rejet clair + divergence/CHOCH/invalidation; jamais uniquement parce que le prix est haut ou bas.
Adaptation automatique: M1-M15 = scalping, M30-H4 = day/swing, D1+ = swing/position.
Un signal exploitable doit avoir direction, entrée, SL structurel, TP1, TP2 et R/R cohérents. Sinon: AUCUN SIGNAL.`;

const KRONOS_RISK_POLICY = `GESTION DU RISQUE
R:R minimum: 1:1.5. Optimal: 1:2 ou 1:3. Évite toute entrée sous 1:1.5.
R:R > 10 = niveaux suspects: marque "Trade risqué" et ne présente pas le plan comme directement tradable.
TP1 trop rond/fallback évident (1.0000, 2.0000, 100.0000) = niveaux suspects: marque "Trade risqué".
SL trop proche (< 2 pips sur Forex, < 0.02 sur JPY, < 0.20 sur XAU) = niveaux suspects: marque "Trade risqué".
Risk par trade: Conservateur 1%, Standard 2%, Agressif 3% uniquement si score très fort, pas de news rouge et confluences solides.
SL toujours structurel: sous support/demand/OB/FVG pour achat, au-dessus résistance/supply/OB/FVG pour vente. Jamais un nombre arbitraire.
Corrélation: signale les expositions doublées, par exemple long EUR/USD + long GBP/USD = double risque USD.
Si événement macro fort proche, données faibles, MTF contradictoire ou image mauvaise, baisse le score ou bloque.
Scoring: >=85 FORT, 71-84 STANDARD, 55-70 PRUDENT, <55 BLOQUÉ.`;

const KRONOS_FUNDAMENTAL_POLICY = `ANALYSE FONDAMENTALE À CITER SI UTILE
EUR/USD: différentiel Fed/BCE, inflation, croissance, DXY.
GBP/JPY: paire très volatile, sensible au risque global et aux politiques BOE/BOJ.
XAU/USD: or refuge, sensible au DXY, taux réels US, inflation, tensions géopolitiques.
BTC/USD et ETH/USD: 24/7, corrélation fréquente avec le risque et les indices US.
US500/NAS100: indices sensibles aux taux, earnings, inflation, Fed, sentiment risque.
News high impact: NFP, FOMC, CPI, PPI, BCE, BOE, BOJ. Si un risque news est transmis par le serveur, respecte-le strictement.`;

const KRONOS_OUTPUT_POLICY = `FORMAT OBLIGATOIRE
📸 LECTURE DES GRAPHIQUES :
[Si image] Plateforme: [X] | Paire: [X] | Timeframe: [X] | Structure visible: [description]
[Sans image] Analyse sans screenshot — utilise uniquement prix live + formulaire + synthèse technique API.

📡 DONNÉES LIVE :
- Prix live: [valeur] | Source: [source] | Fiabilité: [si connue]
- Historique: [bougies] | SMA10/SMA30: [X] | RSI: [X] | ATR: [X]

📐 TECHNIQUE UTILISÉE : [nom + raison courte]
📊 ANALYSE :
- Tendance : [Haussière/Baissière/Neutre]
- Signal détecté : [description courte ou AUCUN SIGNAL]
- Zone d'entrée : [niveau numérique ou —]
- Stop Loss : [niveau numérique ou —]
- Take Profit 1 : [niveau numérique ou —]
- Take Profit 2 : [niveau numérique ou —]
- R/R ratio : [1:X]
✅ CONFLUENCE : [alignement multi-graphe/API/news ou limite]
⚠️ RISQUE : Ce n'est pas un conseil financier.
SCORE_CONFIANCE:[0-100]
TECHNIQUE_UTILISEE:[ICT|SMC|Wyckoff|Elliott|Price Action|Ichimoku|Hybride SMC+Chartiste]
STYLE_EFFICACITE:[style]=[0-100]
Si le signal n'est pas assez confirmé, écris explicitement AUCUN SIGNAL et n'ajoute pas de faux niveaux.
Si les niveaux sont seulement indicatifs parce que le graphique n'a pas pu être lu, écris:
⚠️ NIVEAUX INDICATIFS UNIQUEMENT — Kronos n'a pas pu lire le graphique. Ne pas trader ces niveaux directement.`;

const KRONOS_SYSTEM_PROMPT = [
  "Tu es Kronos, le moteur IA éducatif d'Oracle Forex. Tu analyses comme un analyste senior: précis, prudent, structuré, jamais vendeur de rêve. Tu ne donnes jamais de conseil financier; tu fournis une lecture éducative du marché.",
  KRONOS_DATA_POLICY,
  KRONOS_CHART_POLICY,
  KRONOS_METHOD_POLICY,
  KRONOS_STRATEGY_POLICY,
  KRONOS_RISK_POLICY,
  KRONOS_FUNDAMENTAL_POLICY,
  KRONOS_OUTPUT_POLICY,
].join("\n\n");

const CHATBOT_SYSTEM_PROMPT = `Tu es ChatBot Kronos, l'assistant conversationnel trading d'Oracle Forex.

Rôle:
- Discuter naturellement avec l'utilisateur, comme un vrai chatbot.
- Répondre à toute question liée au trading: Forex, crypto, indices, métaux, psychologie, money management, brokers, lots, pips, spreads, sessions, news, stratégies, erreurs de débutant, lecture de graphe.
- Expliquer simplement quand l'utilisateur apprend.
- Être capable de proposer un plan d'action éducatif quand l'utilisateur demande quoi faire.
- Basculer en mode analyse/setup seulement quand l'utilisateur demande un signal, une entrée, TP/SL, une analyse de paire ou envoie un graphe.

Capital faible:
- Si l'utilisateur parle d'un petit capital comme 10$, ne le bloque pas sèchement. Explique ce qui est possible et impossible.
- Propose une approche réaliste: cent account, micro-lots si disponible, risque très faible, patience, objectif d'apprentissage, pas de martingale.
- Tu peux proposer des scénarios éducatifs ou une watchlist, mais tu ne promets jamais de gagner vite ou facilement.

Sécurité:
- Ne donne jamais de garantie de profit.
- Ne présente jamais une réponse comme un conseil financier.
- Si une demande est risquée, réponds utilement: explique le risque et propose une alternative plus saine.

Style:
- Français naturel, direct, humain.
- Réponse courte par défaut, plus détaillée si la question le demande.
- Pose une question de clarification quand il manque la paire, le timeframe, le capital, le style ou le risque.
- Pour un signal exploitable: donne direction, entrée, SL, TP1, TP2, R/R, score et raison, uniquement si le contexte est suffisant.`;

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
  if (url.pathname === "/api/signup") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const body = await readBody(req);
    const result = await signupUser(body);
    if (!result.ok) return sendJson(res, 400, result);
    setSessionCookie(res, result.session.token);
    sendJson(res, 200, { ok: true, user: publicUser(result.user) });
    return;
  }

  if (url.pathname === "/api/login") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const body = await readBody(req);
    const result = await loginUser(body);
    if (!result.ok) return sendJson(res, 401, result);
    setSessionCookie(res, result.session.token);
    sendJson(res, 200, { ok: true, user: publicUser(result.user) });
    return;
  }

  if (url.pathname === "/api/me") {
    const session = await currentSession(req);
    sendJson(res, 200, { ok: Boolean(session), user: session ? publicUser(session.user) : null });
    return;
  }

  if (url.pathname === "/api/logout") {
    const token = cookieValue(req, "oracle_session");
    if (token) await destroySession(token);
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/market-status") {
    sendJson(res, 200, marketStatus());
    return;
  }

  if (url.pathname === "/api/provider-status") {
    sendJson(res, 200, getApiStatus());
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(res, 200, {
      groq: GROQ_KEYS.length > 0,
      gemini: GEMINI_KEYS.length > 0,
      twelveData: TWELVE_DATA_KEYS.length > 0,
      massive: MASSIVE_KEYS.length > 0,
      alphaVantage: ALPHA_VANTAGE_KEYS.length > 0,
      exchangeRateApi: EXCHANGERATE_KEYS.length > 0,
      binanceFallback: true,
      mongoDb: Boolean(mongoUri),
      stooqFallback: true,
      dukascopyHistorical: true,
      coinbaseFallback: true,
      frankfurterFallback: true,
      finnhub: FINNHUB_KEYS.length > 0,
      marketaux: MARKETAUX_KEYS.length > 0,
      news: Boolean(env.NEWS_API_KEY || env.GNEWS_API_KEY || env.NEWSDATA_API_KEY || MARKETAUX_KEYS.length),
      market: marketStatus(),
    });
    return;
  }

  if (url.pathname === "/api/health") {
    const learning = await loadLearningLog();
    sendJson(res, 200, {
      market: marketStatus(),
      providers: providerHealthSnapshot(),
      database: await databaseSummary(),
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

  if (url.pathname === "/api/performance") {
    const prices = await getPrices();
    const learning = await updateLearningOutcomes(prices);
    sendJson(res, 200, performancePayload(learning));
    return;
  }

  if (url.pathname === "/api/my-analyses") {
    const session = await currentSession(req);
    if (!session) {
      sendJson(res, 401, { ok: false, error: "auth_required" });
      return;
    }
    const prices = await getPrices();
    const learning = await updateLearningOutcomes(prices);
    sendJson(res, 200, personalAnalysesPayload(learning, session.user.id));
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

  if (url.pathname === "/api/news") {
    const symbol = url.searchParams.get("symbol") || "EURUSD";
    sendJson(res, 200, { provider: "marketaux", news: await getMarketauxNews(symbol) });
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
    const localAnswer = quickChatAnswer(question, images);
    if (localAnswer) {
      sendJson(res, 200, { ok: true, ...localAnswer });
      return;
    }
    const chatPair = detectPairFromText(question) || body.pair || "EUR/USD";
    const intent = classifyChatIntent(question, images);
    const needsMarketContext = intent.needsMarketContext;
    const prices = needsMarketContext ? await getPrices() : {};
    const livePrice = needsMarketContext ? prices[chatPair] || await getExternalPrice(chatPair) : null;
    const history = needsMarketContext ? await getHistoryForSymbol(chatPair, livePrice) : [];
    const technicalSnapshot = needsMarketContext ? buildTechnicalSnapshot(chatPair, history, livePrice) : { text: "Non requis pour cette question conversationnelle." };
    const context = Array.isArray(body.messages)
      ? body.messages.slice(-6).map((m) => `${m.role || "user"}: ${m.content || ""}`).join("\n")
      : "";
    const marketBlock = needsMarketContext
      ? `CONTEXTE MARCHÉ DISPONIBLE:
- Instrument détecté: ${chatPair}
- Prix live: ${livePrice?.price ?? "indisponible"} (${livePrice?.source || "aucune source"})
- Synthèse technique interne: ${technicalSnapshot.text}`
      : "CONTEXTE MARCHÉ DISPONIBLE: non demandé pour cette question. Ne cite pas EUR/USD ou une autre paire sauf si l'utilisateur la mentionne.";
    const prompt = `${CHATBOT_SYSTEM_PROMPT}

QUESTION UTILISATEUR:
${question || "Analyse ces graphiques."}

CONTEXTE RECENT:
${context}

MODE DÉTECTÉ:
- Type: ${intent.type}
- Besoin contexte marché: ${needsMarketContext ? "oui" : "non"}

${marketBlock}

INSTRUCTIONS DE RÉPONSE:
- Si c'est une conversation ou une question générale, réponds naturellement sans format rigide.
- Si l'utilisateur demande une méthode, donne des étapes concrètes.
- Si l'utilisateur demande un signal/setup, utilise le contexte marché ci-dessus, explique les limites, et demande confirmation si les données sont insuffisantes.
- Si l'utilisateur veut gagner vite/facilement, recadre sans moraliser et propose une voie prudente.
- Termine par une prochaine action utile.`;
    const answer = images.length ? await analyzeChartImage(prompt, images) : await groq(prompt, 420, 0.3);
    if (images.length && !answer) {
      sendJson(res, 200, {
        ok: false,
        offline: true,
        answer: "Vision indisponible: impossible d'analyser ce graphique de façon fiable. Vérifie que Groq ou Gemini est configuré, ou pose une question texte.",
        score: 0,
        technique: "Vision indisponible",
      });
      return;
    }
    if (!answer) {
      sendJson(res, 200, {
        ok: false,
        offline: true,
        answer: "ChatBot hors service pour l'instant: le moteur IA ne répond pas. Réessaie dans quelques minutes.",
        score: 0,
        technique: "Hors service",
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...normalizeChatAnswer(answer, intent, question) });
    return;
  }

  if (url.pathname === "/api/detect-chart-context") {
    const body = await readBody(req);
    const images = normalizeImages(body.images);
    if (!images.length) {
      sendJson(res, 200, { ok: false, reason: "image_required" });
      return;
    }
    if (!hasVisionProvider()) {
      sendJson(res, 200, { ok: false, reason: "vision_provider_required" });
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
    const answer = await analyzeChartImage(prompt, images);
    const detected = normalizeChartDetection(parseJson(answer, null));
    sendJson(res, 200, detected);
    return;
  }

  if (url.pathname === "/api/analyze-chart") {
    const session = await currentSession(req);
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
    if (images.length && !hasVisionProvider()) {
      sendJson(res, 200, {
        direction: "AUCUN SIGNAL",
        entry: "—",
        sl: "—",
        tp1: "—",
        tp2: "—",
        rr: "—",
        score: 0,
        technique: "Vision indisponible",
        explanation: "Aucune clé Groq Vision ou Gemini Vision n'est disponible pour analyser un screenshot. Kronos bloque le signal pour éviter une analyse inventée.",
        noSignal: true,
      });
      return;
    }
    const prices = await getPrices();
    const autoDetectEnabled = body.autoDetect === true || body.autoDetect === "on" || body.autoDetect === "true";
    const includeNewsContext = body.includeNewsContext === true || body.includeNewsContext === "on" || body.includeNewsContext === "true";
    const analysisDepth = normalizeAnalysisDepth(body.analysisDepth);
    const deepAnalysis = analysisDepth === "Profonde";
    const chartContext = autoDetectEnabled ? normalizeChartDetection(body.detectedContext) : normalizeChartDetection(null);
    const selectedPair = chartContext.primaryPair || body.pair || "EUR/USD";
    const selectedTimeframe = chartContext.executionTimeframe || body.timeframe || "H1";
    const livePrice = prices[selectedPair] || await getExternalPrice(selectedPair);
    const history = await getHistoryForSymbol(selectedPair, livePrice, {
      timeframe: selectedTimeframe,
      strategy: body.strategy || "Swing Trading",
    });
    const technicalSnapshot = buildTechnicalSnapshot(selectedPair, history, livePrice, {
      timeframe: selectedTimeframe,
      strategy: body.strategy || "Swing Trading",
    });
    const multiTimeframe = deepAnalysis
      ? await buildMultiTimeframeContext(selectedPair, livePrice, {
        timeframe: selectedTimeframe,
        strategy: body.strategy || "Swing Trading",
      })
      : [];
    const newsContext = includeNewsContext ? await analysisNewsContext(selectedPair) : { enabled: false, summary: "Contexte news/API désactivé par l'utilisateur.", events: [], headlines: [] };
    const learning = await updateLearningOutcomes(prices);
    const calibration = calibrationFor(learning, body);
    const prompt = `${KRONOS_SYSTEM_PROMPT}

CONTEXTE:
- Paire confirmée: ${selectedPair}
- Timeframe formulaire: ${body.timeframe || "H1"}
- Timeframes détectés: ${(chartContext.timeframes || []).join(", ") || "non détectés"}
- Timeframe final d'exécution: ${selectedTimeframe}
- Style demandé: ${body.style || "Mixte"}
- Stratégie demandée: ${body.strategy || "Swing Trading"}
- Gestion du risque: ${body.risk || "Standard 2%"}
- Mode d'analyse: ${analysisDepth}
- Prix live validé: ${livePrice?.price ?? "indisponible"} (${livePrice?.source || "aucune source"})
- Historique API: ${technicalSnapshot.bars} bougies (${technicalSnapshot.source}, ${technicalSnapshot.stale ? "indicatif/différé" : "frais"})
- Synthèse technique interne: ${technicalSnapshot.text}
- Lecture multi-timeframe: ${multiTimeframe.length ? multiTimeframe.map((item) => `${item.timeframe}: ${item.trend}, RSI ${item.rsi ?? "n/a"}, source ${item.source}`).join(" | ") : "mode rapide ou indisponible"}
- Contexte news/API: ${newsContext.summary}
- Qualité image estimée: ${images.length ? `${imageQuality.score}/100 (${imageQuality.reason})` : "aucun graphe uploadé: analyse texte/prix live"}
- Calibration historique Kronos: ${calibration.message}

RÈGLE STRICTE:
Nombre de graphes fournis: ${images.length}.
Si aucun graphe n'est fourni, ne prétends jamais voir des chandeliers, order blocks, FVG, nuage Ichimoku, vagues Elliott ou structures visibles. Dans ce cas, écris clairement "Analyse sans screenshot", utilise seulement prix live/contexte formulaire, et plafonne le score à 70.
Si un ou plusieurs graphes sont fournis, distingue ce qui est réellement visible sur les images de ce qui vient du prix live/API.
Si le style demandé est "Mixte", compare ICT, SMC, Wyckoff, Elliott, Price Action et Ichimoku, puis retiens uniquement le style avec la meilleure efficacité visible.
Si le style demandé n'est pas "Mixte" et que sa structure n'est pas clairement visible, baisse le score d'efficacité mais ne bloque pas si les niveaux sont cohérents.
Tu dois citer les éléments techniques visibles qui justifient le style retenu.
Adapte les niveaux à la stratégie demandée: Scalping = entrée proche du prix live, SL court, TP1 proche/prudent et TP2 moyen; Swing Trading = structure H1/H4/D1; Position Trading = niveaux majeurs; Breakout = attendre clôture/retest; Reversal = confirmer rejet/CHOCH/divergence avant entrée.
En scalping, TP1 doit souvent être autour de 0.8R à 1.2R et TP2 autour de 1.4R à 2.0R. N'étire pas les profits comme un swing trade.
Si la détection automatique est désactivée, utilise la paire et le timeframe du formulaire comme contexte confirmé.
Si le setup n'est pas confirmé, retourne AUCUN SIGNAL au lieu de forcer une opportunité. Si le graphe est absent ou incomplet, fais une analyse prudente basée sur la paire, le timeframe et le prix live, sans prétendre lire des bougies.
Les niveaux doivent rester cohérents avec la structure du graphique et le ratio risque/rendement doit être calculable.
Format des niveaux: Forex non-JPY toujours avec 5 décimales (ex: 1.08472), paires JPY avec 3 décimales, métaux avec 2 décimales, indices/crypto selon leur cotation.
Si plusieurs graphes sont fournis ou si le mode Profonde est actif: utilise les timeframes élevés pour la tendance/contexte et le plus petit timeframe détecté pour l'entrée finale.
Si le contexte news/API est activé, croise le setup avec les titres récents et le calendrier économique. Si une news rouge proche touche la devise, bloque ou baisse le score au lieu de forcer un trade.
Retour obligatoire: direction, entrée, stop loss, TP1, TP2, R/R, SCORE_CONFIANCE, TECHNIQUE_UTILISEE, et une ligne "STYLE_EFFICACITE:[style]=[0-100]".

    Analyse le contexte fourni et donne un setup éducatif exploitable avec prudence.`;
    let answer = images.length ? await analyzeChartImage(prompt, images) : await groq(prompt, 500, 0.3);
    if (!answer) {
      answer = buildDeterministicAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        strategy: body.strategy || "Swing Trading",
        livePrice,
      });
    }
    const result = normalizeAnalysis(answer, { ...body, pair: selectedPair, timeframe: selectedTimeframe, analysisDepth }, { livePrice, imageQuality, calibration, chartContext, technicalSnapshot, newsContext, multiTimeframe });
    if (!result.educationalOnly && !result.noSignal) await recordLearningAnalysis(result, body, { livePrice, imageQuality, calibration, technicalSnapshot, multiTimeframe, analysisDepth, user: session?.user || null });
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
  memoryCache.prices = { value: prices, expiresAt: Date.now() + 2 * 60 * 1000 };
  return prices;
}

async function fetchBestPrice(symbol, cached) {
  if (isRecentCache(cached, cacheTtlMs(symbol))) {
    return pricePayload(symbol, cached, cached.source || "cache", "fresh_cache", {
      stale: false,
      reliability: Math.min(90, Number(cached.reliability) || 80),
    });
  }
  const providers = providersForSymbol(symbol);
  const errors = [];
  const deadline = Date.now() + 3200;
  for (const provider of providers) {
    if (Date.now() > deadline) break;
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

function providersForSymbol(symbol) {
  if (/BTC|ETH/i.test(symbol)) return [fetchBinancePrice, fetchTwelveDataPrice, fetchMassivePrice, fetchCoinbasePrice];
  if (/US500|NAS|SPX/i.test(symbol)) return [fetchMassivePrice, fetchTwelveDataPrice, fetchStooqPrice];
  if (/XAU|XAG|XPT|XPD/i.test(symbol)) return [fetchTwelveDataPrice, fetchMassivePrice, fetchStooqPrice];
  return [fetchTwelveDataPrice, fetchMassivePrice, fetchAlphaVantagePrice, fetchStooqPrice, fetchExchangeRatePrice, fetchFrankfurterPrice];
}

async function getExternalPrice(symbol) {
  if (!symbol) return null;
  try {
    return await fetchBestPrice(symbol, null);
  } catch {
    return null;
  }
}

function collectEnvKeys(...baseNames) {
  const keys = [];
  for (const base of baseNames) {
    if (env[base]) keys.push(env[base]);
    for (let index = 1; index <= 8; index += 1) {
      if (env[`${base}_${index}`]) keys.push(env[`${base}_${index}`]);
    }
  }
  return [...new Set(keys.filter(Boolean))];
}

function isKeyExhausted(key) {
  if (!key || !exhaustedKeys.has(key)) return false;
  const exhaustedAt = exhaustedKeys.get(key);
  if (Date.now() - exhaustedAt > 60 * 60 * 1000) {
    exhaustedKeys.delete(key);
    return false;
  }
  return true;
}

function markKeyExhausted(key) {
  if (key) exhaustedKeys.set(key, Date.now());
}

function isQuotaError(errorOrData) {
  const text = typeof errorOrData === "string"
    ? errorOrData
    : [
        errorOrData?.message,
        errorOrData?.Note,
        errorOrData?.Information,
        errorOrData?.["Error Message"],
        errorOrData?.["error-type"],
        errorOrData?.code,
        errorOrData?.status,
      ].filter(Boolean).join(" ");
  return /429|rate limit|quota|exceeded|limit reached|api call frequency|credits|too many|premium/i.test(text);
}

async function fetchWithRotation(apiName, keys, fetchFn) {
  if (!keys?.length) return null;
  const start = rotationCounters[apiName] || 0;
  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    const index = (start + attempt) % keys.length;
    const key = keys[index];
    if (isKeyExhausted(key)) continue;
    try {
      const result = await fetchFn(key, index);
      rotationCounters[apiName] = (index + 1) % keys.length;
      return result;
    } catch (error) {
      lastError = error;
      if (isQuotaError(error.message)) {
        markKeyExhausted(key);
        rotationCounters[apiName] = (index + 1) % keys.length;
        continue;
      }
      rotationCounters[apiName] = (index + 1) % keys.length;
    }
  }
  if (lastError) throw lastError;
  return null;
}

async function fetchTwelveDataPrice(symbol) {
  if (!TWELVE_DATA_KEYS.length) return null;
  try {
    return await fetchWithRotation("twelveData", TWELVE_DATA_KEYS, async (key) => {
      const api = new URL("https://api.twelvedata.com/quote");
      api.searchParams.set("symbol", symbol);
      api.searchParams.set("apikey", key);
      const data = await fetchJson(api);
      if (data.status === "error" || data.code) throw new Error(data.message || data.code || "api_error");
      const price = Number(data.close || data.price || data.previous_close);
      const change = Number(data.percent_change || data.change || 0);
      if (!Number.isFinite(price)) throw new Error("invalid_price");
      recordProviderHealth("twelve_data", true);
      return pricePayload(symbol, { price, change }, "twelve_data", null, { reliability: 95 });
    });
  } catch (error) {
    recordProviderHealth("twelve_data", false, error.message);
    throw error;
  }
}

async function fetchBinancePrice(symbol) {
  const binanceSymbol = toBinanceSymbol(symbol);
  if (!binanceSymbol) return null;
  try {
    const api = new URL("https://api.binance.com/api/v3/ticker/price");
    api.searchParams.set("symbol", binanceSymbol);
    const data = await fetchJson(api);
    const price = Number(data.price);
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("binance_price", true);
    return pricePayload(symbol, { price, change: 0 }, "binance", null, { reliability: 90 });
  } catch (error) {
    recordProviderHealth("binance_price", false, error.message);
    throw error;
  }
}

async function fetchExchangeRatePrice(symbol) {
  if (!EXCHANGERATE_KEYS.length || !/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) || /XAU|XAG|BTC|ETH/i.test(symbol)) return null;
  const [from, to] = symbol.split("/");
  try {
    return await fetchWithRotation("exchangeRate", EXCHANGERATE_KEYS, async (key) => {
      const api = new URL(`https://v6.exchangerate-api.com/v6/${encodeURIComponent(key)}/pair/${from}/${to}`);
      const data = await fetchJson(api);
      if (data.result && data.result !== "success") throw new Error(data["error-type"] || "api_error");
      const price = Number(data.conversion_rate);
      if (!Number.isFinite(price)) throw new Error("invalid_price");
      recordProviderHealth("exchangerate_price", true);
      return pricePayload(symbol, { price, change: 0 }, "exchangerate_api", null, {
        stale: true,
        reliability: 62,
      });
    });
  } catch (error) {
    recordProviderHealth("exchangerate_price", false, error.message);
    throw error;
  }
}

async function fetchMassivePrice(symbol) {
  if (!MASSIVE_KEYS.length) return null;
  const ticker = toMassiveTicker(symbol);
  if (!ticker) return null;
  try {
    return await fetchWithRotation("massive", MASSIVE_KEYS, async (key) => {
      const api = new URL(`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`);
      api.searchParams.set("adjusted", "true");
      api.searchParams.set("apiKey", key);
      const data = await fetchJson(api);
      const bar = Array.isArray(data.results) ? data.results[0] : null;
      const price = Number(bar?.c);
      const open = Number(bar?.o);
      const change = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;
      if (!Number.isFinite(price)) throw new Error(data.error || "invalid_price");
      recordProviderHealth("massive_price", true);
      return pricePayload(symbol, { price, change }, "massive", null, { reliability: 88 });
    });
  } catch (error) {
    recordProviderHealth("massive_price", false, error.message);
    throw error;
  }
}

async function fetchAlphaVantagePrice(symbol) {
  if (!ALPHA_VANTAGE_KEYS.length) return null;
  if (!/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) && !/BTC|ETH/i.test(symbol)) return null;
  try {
    return await fetchWithRotation("alphaVantage", ALPHA_VANTAGE_KEYS, async (key) => {
      const [from, to] = symbol.split("/");
      const api = new URL("https://www.alphavantage.co/query");
      api.searchParams.set("function", "CURRENCY_EXCHANGE_RATE");
      api.searchParams.set("from_currency", from);
      api.searchParams.set("to_currency", to || "USD");
      api.searchParams.set("apikey", key);
      const data = await fetchJson(api);
      if (data.Note || data.Information || data["Error Message"]) throw new Error(data.Note || data.Information || data["Error Message"]);
      const payload = data["Realtime Currency Exchange Rate"] || {};
      const price = Number(payload["5. Exchange Rate"]);
      if (!Number.isFinite(price)) throw new Error("invalid_price");
      recordProviderHealth("alpha_vantage", true);
      return pricePayload(symbol, { price, change: 0 }, "alpha_vantage", null, { reliability: 80 });
    });
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
  const cache = await loadMarketCache();
  const cached = cachedHistories(cache, prices);
  const cachedCount = Object.values(cached).filter((bars) => Array.isArray(bars) && bars.length >= 30 && !bars._meta?.stale).length;
  if (cachedCount >= 4) {
    memoryCache.histories = { key: usableKey, value: cached, expiresAt: Date.now() + 8 * 60 * 1000 };
    return cached;
  }
  if (!TWELVE_DATA_KEYS.length) {
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
        const bars = await fetchBinanceHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `binance:${interval}`, false);
          recordProviderHealth("binance_history", true);
          return [symbol, bars];
        }
        if (bars.length) errors.push(`binance_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`binance_${interval}:${error.message}`);
      }
    }
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchMassiveHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `massive:${interval}`, false);
          recordProviderHealth("massive_history", true);
          return [symbol, bars];
        }
        errors.push(`massive_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`massive_${interval}:${error.message}`);
      }
    }
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchTwelveDataHistory(symbol, interval);
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

async function getHistoryForSymbol(symbol, price = null, options = {}) {
  const cache = await loadMarketCache();
  const cached = cachedHistory(symbol, cache);
  const preferredIntervals = historyIntervals(symbol, options);
  if (cached.length >= 30 && !cached._meta?.stale && isHistoryCompatible(cached, options)) return cached;
  if (!price?.open || !isUsableLivePrice(price)) return cached;
  const deadline = Date.now() + 12000;
  const errors = [];
  const attempts = [
    ["binance", fetchBinanceHistory],
    ["massive", fetchMassiveHistory],
    ["twelve_data", fetchTwelveDataHistory],
    ["stooq", fetchStooqHistory],
  ];
  for (const [source, loader] of attempts) {
    for (const interval of preferredIntervals) {
      if (Date.now() > deadline) {
        errors.push("history_budget_exceeded");
        return cached;
      }
      try {
        const bars = await loader(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `${source}:${interval}`, false);
          await saveMarketCache({
            ...cache,
            histories: mergeCachedHistories(cache.histories || {}, { [symbol]: bars }),
          });
          recordProviderHealth(`${source}_history_single`, true);
          return bars;
        }
        if (bars.length) errors.push(`${source}_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`${source}_${interval}:${error.message}`);
      }
    }
  }
  if (Date.now() <= deadline) {
    try {
      const bars = await fetchDukascopyHistory(symbol);
      if (bars.length >= 30) {
        tagHistory(bars, "dukascopy:daily", true);
        recordProviderHealth("dukascopy_history_single", true);
        return bars;
      }
      errors.push("dukascopy:insufficient_bars");
    } catch (error) {
      errors.push(`dukascopy:${error.message}`);
    }
  }
  recordProviderHealth("history_single", false, errors.join(" | ") || "no_history");
  return cached;
}

async function buildMultiTimeframeContext(symbol, livePrice, options = {}) {
  const timeframes = analysisTimeframes(options.timeframe, options.strategy);
  const items = [];
  for (const timeframe of timeframes) {
    const history = await getHistoryForSymbol(symbol, livePrice, {
      timeframe,
      strategy: options.strategy,
    });
    const snapshot = buildTechnicalSnapshot(symbol, history, livePrice, {
      timeframe,
      strategy: options.strategy,
    });
    items.push({
      timeframe,
      source: snapshot.source,
      bars: snapshot.bars,
      valid: snapshot.valid,
      trend: snapshot.trend || "n/a",
      rsi: snapshot.rsi,
      support: snapshot.support,
      resistance: snapshot.resistance,
      volatility: snapshot.volatility,
      timeframeCompatible: snapshot.timeframeCompatible,
    });
  }
  return items;
}

function analysisTimeframes(timeframe = "H1", strategy = "") {
  const normalized = normalizeTimeframe(timeframe) || "H1";
  if (isScalpingStrategy(strategy) || ["M1", "M5", "M15"].includes(normalized)) {
    return uniqueList(["H1", "M15", normalized === "M1" ? "M5" : normalized, "M1"]);
  }
  if (/breakout|reversal/i.test(String(strategy))) return uniqueList(["H4", "H1", normalized, "M15"]);
  if (/position/i.test(String(strategy)) || ["D1", "W1", "MN1"].includes(normalized)) return uniqueList(["W1", "D1", "H4", normalized]);
  return uniqueList(["D1", "H4", normalized, "M15"]);
}

function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

async function fetchFreeHistories(cache, prices) {
  const entries = await Promise.all(symbols.map(async (symbol) => {
    const price = prices[symbol];
    if (!price?.open) return [symbol, cachedHistory(symbol, cache)];
    const errors = [];
    for (const interval of historyIntervals(symbol)) {
      try {
        const bars = await fetchBinanceHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `binance:${interval}`, false);
          recordProviderHealth("binance_history", true);
          return [symbol, bars];
        }
        if (bars.length) errors.push(`binance_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`binance_${interval}:${error.message}`);
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

async function fetchTwelveDataHistory(symbol, interval) {
  if (!TWELVE_DATA_KEYS.length) return [];
  return fetchWithRotation("twelveData", TWELVE_DATA_KEYS, async (key) => {
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
  });
}

async function fetchBinanceHistory(symbol, interval) {
  const binanceSymbol = toBinanceSymbol(symbol);
  if (!binanceSymbol) return [];
  const binanceInterval = {
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "1h",
    "4h": "4h",
    "1day": "1d",
    "1week": "1w",
  }[interval] || "1h";
  const api = new URL("https://api.binance.com/api/v3/klines");
  api.searchParams.set("symbol", binanceSymbol);
  api.searchParams.set("interval", binanceInterval);
  api.searchParams.set("limit", "80");
  const data = await fetchJson(api);
  if (!Array.isArray(data)) throw new Error("invalid_history");
  return data.map((bar) => ({
    close: Number(bar[4]),
    high: Number(bar[2]),
    low: Number(bar[3]),
    datetime: bar[0] ? new Date(bar[0]).toISOString() : null,
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

async function fetchMassiveHistory(symbol, interval) {
  const ticker = toMassiveTicker(symbol);
  const span = toMassiveTimespan(interval);
  if (!MASSIVE_KEYS.length || !ticker || !span) return [];
  const to = new Date();
  const from = new Date(to.getTime() - massiveLookbackMs(interval));
  return fetchWithRotation("massive", MASSIVE_KEYS, async (key) => {
    const api = new URL(`https://api.massive.com/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${span.multiplier}/${span.timespan}/${from.toISOString().slice(0, 10)}/${to.toISOString().slice(0, 10)}`);
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
  });
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

function historyIntervals(symbol, options = {}) {
  const timeframe = normalizeTimeframe(options.timeframe);
  const strategy = String(options.strategy || "");
  if (timeframe === "M1") return ["1min", "5min", "15min"];
  if (timeframe === "M5") return ["5min", "1min", "15min"];
  if (timeframe === "M15") {
    if (/BTC|ETH/i.test(symbol)) return ["1min", "5min", "15min", "30min"];
    return ["1min", "5min", "15min", "30min"];
  }
  if (["M30", "H1"].includes(timeframe)) {
    if (/BTC|ETH/i.test(symbol)) return ["15min", "30min", "1h"];
    if (/US500|NAS|SPX/i.test(symbol)) return ["30min", "1h", "1day"];
    return ["15min", "30min", "1h", "1day"];
  }
  if (["H4", "D1", "W1", "MN1"].includes(timeframe) || /swing|position/i.test(strategy)) {
    if (/BTC|ETH/i.test(symbol)) return ["1h", "4h", "1day"];
    if (/US500|NAS|SPX/i.test(symbol)) return ["1h", "1day"];
    return ["1h", "4h", "1day"];
  }
  if (isScalpingStrategy(strategy)) return ["5min", "1min", "15min", "30min"];
  if (/BTC|ETH/i.test(symbol)) return ["15min", "30min", "1h"];
  if (/US500|NAS|SPX/i.test(symbol)) return ["30min", "1h", "1day"];
  return ["15min", "30min", "1h", "1day"];
}

function isHistoryCompatible(history, options = {}) {
  const source = String(history?._meta?.source || "");
  const strategy = String(options.strategy || "");
  const timeframe = normalizeTimeframe(options.timeframe);
  if (timeframe === "M1") return historySourceHasInterval(source, ["1min"]);
  if (timeframe === "M5") return historySourceHasInterval(source, ["1min", "5min"]);
  if (timeframe === "M15") {
    return historySourceHasInterval(source, ["1min", "5min", "15min"]) && !/1day|daily|:d\b/i.test(source);
  }
  if (["M30", "H1"].includes(timeframe)) return historySourceHasInterval(source, ["15min", "30min", "1h"]);
  if (["H4", "D1", "W1", "MN1"].includes(timeframe)) return historySourceHasInterval(source, ["1h", "4h", "1day", "1week"]);
  if (isScalpingStrategy(strategy)) return historySourceHasInterval(source, ["1min", "5min", "15min"]);
  return true;
}

function historySourceHasInterval(source = "", intervals = []) {
  const interval = String(source).toLowerCase().split(":").pop();
  return intervals.map((item) => item.toLowerCase()).includes(interval);
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

function toBinanceSymbol(symbol = "") {
  const normalized = String(symbol).toUpperCase().replace(/[^A-Z0-9/]/g, "");
  const aliases = {
    "BTC/USD": "BTCUSDT",
    "ETH/USD": "ETHUSDT",
    "BNB/USD": "BNBUSDT",
    "SOL/USD": "SOLUSDT",
    "XRP/USD": "XRPUSDT",
  };
  return aliases[normalized] || null;
}

function toStooqInterval(interval = "") {
  return ({
    "1min": "1",
    "5min": "5",
    "15min": "15",
    "30min": "30",
    "1h": "60",
    "1day": "d",
    "1d": "d",
  })[interval] || null;
}

function toMassiveTicker(symbol = "") {
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

function toMassiveTimespan(interval = "") {
  return ({
    "1min": { multiplier: 1, timespan: "minute" },
    "5min": { multiplier: 5, timespan: "minute" },
    "15min": { multiplier: 15, timespan: "minute" },
    "30min": { multiplier: 30, timespan: "minute" },
    "1h": { multiplier: 1, timespan: "hour" },
    "4h": { multiplier: 4, timespan: "hour" },
    "1day": { multiplier: 1, timespan: "day" },
    "1d": { multiplier: 1, timespan: "day" },
  })[interval] || null;
}

function massiveLookbackMs(interval = "") {
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
    if (history.length < 30) return cautiousSignal(symbol, price, base, "Historique insuffisant · aucun signal direct validé.", history);

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
      return cautiousSignal(symbol, price, base, "Indicateurs incomplets · aucun signal direct validé.", history);
    }

    if (strength < 0.18 || confluence < 2 || !trendAligned) {
      return cautiousSignal(symbol, price, base, `Momentum faible · setup non validé, confluence ${confluence}/4.`, history);
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

    return applySignalSafety({
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
    });
  });
}

function cautiousSignal(symbol, price, base, reason, history = []) {
  const last = Number(price.price || base.entree);
  const direction = Number(price.change) < 0 ? "VENTE" : "ACHAT";
  const risk = assistedRiskDistance(last, symbol);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.4 : entry - risk * 1.4;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.1 : entry - risk * 2.1;
  const confidence = Math.max(42, Math.min(62, Math.round((price.reliability || 55) * 0.65)));
  return applySignalSafety({
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
    direct: false,
    source: price.source,
    suspended: true,
    nextOpen: null,
    quality: qualityPayload(price, history, false, reason),
    cautious: true,
  });
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
  return ["twelve_data", "massive", "alpha_vantage", "coinbase", "stooq", "binance"].includes(source);
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
  if (!FINNHUB_KEYS.length) return [];
  try {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const to = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
    const data = await fetchWithRotation("finnhub", FINNHUB_KEYS, async (key) => {
      const api = new URL("https://finnhub.io/api/v1/calendar/economic");
      api.searchParams.set("from", from);
      api.searchParams.set("to", to);
      api.searchParams.set("token", key);
      return fetchJson(api, 5000);
    });
    const events = data.economicCalendar || [];
    memoryCache.calendar = { value: events, expiresAt: Date.now() + 30 * 60 * 1000 };
    recordProviderHealth("finnhub_calendar", true);
    return events;
  } catch (error) {
    recordProviderHealth("finnhub_calendar", false, error.message);
    return [];
  }
}

async function getMarketauxNews(symbol = "EURUSD") {
  if (!MARKETAUX_KEYS.length) return [];
  try {
    const data = await fetchWithRotation("marketaux", MARKETAUX_KEYS, async (key) => {
      const api = new URL("https://api.marketaux.com/v1/news/all");
      api.searchParams.set("symbols", symbol);
      api.searchParams.set("filter_entities", "true");
      api.searchParams.set("language", "en");
      api.searchParams.set("api_token", key);
      return fetchJson(api, 5000);
    });
    recordProviderHealth("marketaux_news", true);
    return Array.isArray(data?.data) ? data.data.slice(0, 12) : [];
  } catch (error) {
    recordProviderHealth("marketaux_news", false, error.message);
    return [];
  }
}

async function analysisNewsContext(pair = "EUR/USD") {
  const [risk, headlines] = await Promise.all([
    economicRiskWindow(),
    getMarketauxNews(toNewsSymbol(pair)),
  ]);
  const keywords = newsKeywordsForPair(pair);
  const compactHeadlines = headlines.map((item) => ({
    title: cleanLine(item.title || item.headline || item.description || "Actualité marché"),
    source: cleanLine(item.source || item.source_name || ""),
    publishedAt: item.published_at || item.publishedAt || item.date || null,
  }))
    .filter((item) => item.title)
    .filter((item) => keywords.some((keyword) => item.title.toUpperCase().includes(keyword)))
    .slice(0, 5);
  const eventText = risk.events?.length
    ? risk.events.map((event) => `${event.currency || "N/A"} ${event.impact}: ${event.name}`).join(" | ")
    : risk.reason;
  const headlineText = compactHeadlines.length
    ? compactHeadlines.map((item) => item.title).join(" | ")
    : "Aucun titre Marketaux récent exploitable.";
  return {
    enabled: true,
    activeRisk: Boolean(risk.active),
    events: risk.events || [],
    headlines: compactHeadlines,
    summary: `Calendrier: ${eventText}. News: ${headlineText}`,
  };
}

function toNewsSymbol(pair = "") {
  const clean = String(pair || "EUR/USD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean === "BTCUSD") return "BTCUSD";
  if (clean === "ETHUSD") return "ETHUSD";
  if (clean === "XAUUSD") return "XAUUSD";
  if (clean === "XAGUSD") return "XAGUSD";
  if (clean === "US500") return "SPY";
  if (clean === "NAS100") return "QQQ";
  return clean || "EURUSD";
}

function newsKeywordsForPair(pair = "") {
  const clean = String(pair || "EUR/USD").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const chunks = clean.match(/[A-Z]{3,4}/g) || [];
  const keywords = new Set([clean, ...chunks]);
  if (clean.includes("EUR")) keywords.add("EURO");
  if (clean.includes("USD")) {
    keywords.add("DOLLAR");
    keywords.add("FED");
    keywords.add("DXY");
  }
  if (clean.includes("GBP")) keywords.add("POUND");
  if (clean.includes("JPY")) keywords.add("YEN");
  if (clean.includes("XAU")) {
    keywords.add("GOLD");
    keywords.add("XAU");
  }
  if (clean.includes("XAG")) {
    keywords.add("SILVER");
    keywords.add("XAG");
  }
  if (clean.includes("BTC")) keywords.add("BITCOIN");
  if (clean.includes("ETH")) keywords.add("ETHEREUM");
  if (clean.includes("US500")) {
    keywords.add("S&P");
    keywords.add("SPX");
    keywords.add("US500");
  }
  return [...keywords].filter(Boolean);
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
  if (!GROQ_KEYS.length) return geminiText(prompt, maxTokens, temperature);
  const models = [...new Set([GROQ_MODEL, GROQ_FALLBACK_MODEL])];
  for (const model of models) {
    try {
      return await fetchWithRotation("groq", GROQ_KEYS, (key) => groqOnce(key, model, prompt, maxTokens, temperature));
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
    signal: AbortSignal.timeout(18000),
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
  if (!GEMINI_KEYS.length) return "";
  for (const model of GEMINI_FALLBACK_MODELS) {
    try {
      const result = await fetchWithRotation("gemini", GEMINI_KEYS, async (key) => {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(18000),
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { temperature, maxOutputTokens: maxTokens },
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`gemini_text_${response.status}_${model}: ${errText.slice(0, 240)}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
      });
      if (result) {
        recordProviderHealth("gemini_text", true);
        return result;
      }
    } catch (error) {
      recordProviderHealth("gemini_text", false, error.message);
      console.warn(`Gemini text failed with ${model}: ${error.message}`);
    }
  }
  return "";
}

async function groqVision(prompt, images) {
  if (!GROQ_KEYS.length) return "";
  const groqVisionModels = [
    "meta-llama/llama-4-scout-17b-16e-instruct",
    "meta-llama/llama-4-maverick-17b-128e-instruct",
  ];
  for (const model of groqVisionModels) {
    try {
      const result = await fetchWithRotation("groq", GROQ_KEYS, async (key) => {
        const imageContent = images.map((image) => ({
          type: "image_url",
          image_url: { url: `data:${image.mimeType};base64,${image.data}` },
        }));
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          signal: AbortSignal.timeout(22000),
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [{ type: "text", text: prompt }, ...imageContent],
            }],
            temperature: 0.25,
            max_tokens: 1000,
          }),
        });
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`groq_vision_${response.status}_${model}: ${errText.slice(0, 240)}`);
        }
        const data = await response.json();
        return data.choices?.[0]?.message?.content?.trim() || "";
      });
      if (result) {
        recordProviderHealth("groq_vision", true);
        return result;
      }
    } catch (error) {
      recordProviderHealth("groq_vision", false, error.message);
      console.warn(`Groq Vision failed with ${model}: ${error.message}`);
    }
  }
  return "";
}

async function analyzeChartImage(prompt, images) {
  if (!images?.length) return "";
  if (GROQ_KEYS.length) {
    const result = await groqVision(prompt, images);
    if (result && result.length > 50) return result;
    console.warn("Groq Vision insufficient, falling back to Gemini Vision.");
  }
  if (GEMINI_KEYS.length) {
    const result = await geminiVision(prompt, images);
    if (result && result.length > 50) return result;
    console.warn("Gemini Vision insufficient.");
  }
  return "";
}

async function geminiVision(prompt, images) {
  if (!GEMINI_KEYS.length) return "";
  for (const model of GEMINI_FALLBACK_MODELS) {
    try {
      const result = await fetchWithRotation("gemini", GEMINI_KEYS, async (key) => {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(22000),
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
        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`gemini_${response.status}_${model}: ${errText.slice(0, 240)}`);
        }
        const data = await response.json();
        return data.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() || "";
      });
      if (result) {
        recordProviderHealth("gemini_vision", true);
        return result;
      }
    } catch (error) {
      recordProviderHealth("gemini_vision", false, error.message);
      console.warn(`Gemini failed with ${model}: ${error.message}`);
    }
  }
  return "";
}

async function fetchJson(url, timeoutMs = 2200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

async function fetchText(url, timeoutMs = 2200) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
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

function hasVisionProvider() {
  return GROQ_KEYS.length > 0 || GEMINI_KEYS.length > 0;
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

function normalizeAnalysisDepth(value) {
  return /rapide|fast|quick/i.test(String(value || "")) ? "Rapide" : "Profonde";
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
    const normalizedSignal = {
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
    return applySignalSafety(normalizedSignal);
  });
  return [...normalized, ...fallbackSignals.slice(normalized.length)].slice(0, 6);
}

function normalizeAiAnswer(answer, seed = "") {
  const text = cleanLine(answer) || `📐 TECHNIQUE UTILISÉE : Price Action
📊 ANALYSE :
- Tendance : Neutre
- Signal détecté : AUCUN SIGNAL
- Zone d'entrée : —
- Stop Loss : —
- Take Profit 1 : —
- Take Profit 2 : —
- R/R ratio : —
⚠️ RISQUE : Ce n'est pas un conseil financier.
⚠️ NIVEAUX INDICATIFS UNIQUEMENT — Kronos n'a pas pu lire le graphique. Ne pas trader ces niveaux directement.
SCORE_CONFIANCE:45
TECHNIQUE_UTILISEE:Price Action
STYLE_EFFICACITE:Price Action=45`;
  return { answer: text, score: extractScore(text, seed), technique: extractTechnique(text) };
}

function buildDeterministicAnalysisText({ pair = "EUR/USD", timeframe = "H1", style = "Mixte", strategy = "Swing Trading", livePrice }) {
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
    strategy,
  });
  const technique = style === "Mixte" ? "Price Action" : style;
  const strategyLine = strategyGuide(strategy, timeframe);
  return `📐 TECHNIQUE UTILISÉE : ${technique} + prix live, car la vision IA n'a pas fourni un setup complet.
📊 ANALYSE :
- Tendance : ${direction === "ACHAT" ? "Haussière indicative" : "Baissière indicative"}
- Signal détecté : AUCUN SIGNAL — ${strategyLine}
- Zone d'entrée : ${formatLevel(levels.entry, pair)}
- Stop Loss : ${formatLevel(levels.sl, pair)}
- Take Profit 1 : ${formatLevel(levels.tp, pair)}
- Take Profit 2 : ${formatLevel(levels.tp2, pair)}
✅ CONFLUENCE : Prix live ${pair} à confirmer sur le graphe
⚠️ RISQUE : Ce n'est pas un conseil financier.
⚠️ NIVEAUX INDICATIFS UNIQUEMENT — Kronos n'a pas pu lire le graphique. Ne pas trader ces niveaux directement.
SCORE_CONFIANCE:45
TECHNIQUE_UTILISEE:${technique}
STYLE_EFFICACITE:${technique}=45`;
}

function strategyGuide(strategy = "Swing Trading", timeframe = "H1") {
  const clean = String(strategy || "Swing Trading").toLowerCase();
  if (clean.includes("scalping")) return `Scalping ${timeframe}: réaction courte sur support/résistance, attendre impulsion et retest`;
  if (clean.includes("position")) return `Position Trading ${timeframe}: tendance de fond, privilégier niveaux majeurs et patience`;
  if (clean.includes("breakout")) return `Breakout ${timeframe}: cassure à confirmer par clôture/retest avant entrée`;
  if (clean.includes("reversal")) return `Reversal ${timeframe}: retournement seulement après rejet clair ou CHOCH`;
  return `Swing Trading ${timeframe}: setup prudent basé sur structure, support/résistance et prix live`;
}

function buildTechnicalSnapshot(pair, history = [], livePrice = null, options = {}) {
  const bars = Array.isArray(history) ? history.filter((bar) => Number.isFinite(Number(bar.close))) : [];
  const closes = bars.map((bar) => Number(bar.close));
  const live = Number(livePrice?.price);
  const last = Number.isFinite(live) ? live : closes.at(-1);
  const meta = history?._meta || {};
  const compatible = isHistoryCompatible(history, options);
  if (!Number.isFinite(last) || closes.length < 10) {
    return {
      pair,
      bars: closes.length,
      source: meta.source || livePrice?.source || "aucun historique",
      stale: Boolean(meta.stale || livePrice?.stale),
      valid: false,
      text: "Historique insuffisant: lecture visuelle prioritaire, aucun setup direct à forcer.",
    };
  }
  const sma10 = average(closes.slice(-10));
  const sma30 = closes.length >= 30 ? average(closes.slice(-30)) : NaN;
  const rsi = closes.length >= 15 ? calculateRsi(closes.slice(-15)) : NaN;
  const atr = average(bars.slice(-14).map((bar) => Math.max(0, Number(bar.high) - Number(bar.low)))) || last * 0.004;
  const recent = bars.slice(-30);
  const support = Math.min(...recent.map((bar) => Number(bar.low)).filter(Number.isFinite));
  const resistance = Math.max(...recent.map((bar) => Number(bar.high)).filter(Number.isFinite));
  const momentum = Number.isFinite(sma30) && sma30 > 0 ? ((sma10 - sma30) / sma30) * 100 : 0;
  const trend = !Number.isFinite(sma30)
    ? "neutre"
    : momentum > 0.04 && Number(rsi) >= 52
      ? "haussière"
      : momentum < -0.04 && Number(rsi) <= 48
        ? "baissière"
        : "neutre/range";
  const volatility = Number.isFinite(atr) && last ? (atr / last) * 100 : 0;
  const confirmations = [
    closes.length >= 30,
    !meta.stale,
    compatible,
    trend !== "neutre/range",
    Number.isFinite(support) && Number.isFinite(resistance) && resistance > support,
    volatility > 0.04,
  ].filter(Boolean).length;
  const valid = closes.length >= 30 && confirmations >= 4 && !meta.stale && compatible;
  return {
    pair,
    bars: closes.length,
    source: meta.source || livePrice?.source || "historique",
    stale: Boolean(meta.stale || livePrice?.stale || !compatible),
    timeframeCompatible: compatible,
    valid,
    last: Number(formatLevel(last, pair)),
    sma10: Number(formatLevel(sma10, pair)),
    sma30: Number.isFinite(sma30) ? Number(formatLevel(sma30, pair)) : null,
    rsi: Number.isFinite(rsi) ? Math.round(rsi) : null,
    atr: Number(formatLevel(atr, pair)),
    support: Number.isFinite(support) ? Number(formatLevel(support, pair)) : null,
    resistance: Number.isFinite(resistance) ? Number(formatLevel(resistance, pair)) : null,
    trend,
    momentum: Number(momentum.toFixed(3)),
    volatility: Number(volatility.toFixed(3)),
    confirmations,
    text: [
      `${closes.length} bougies ${meta.source || livePrice?.source || "API"}`,
      `tendance ${trend}`,
      `SMA10 ${formatLevel(sma10, pair)}${Number.isFinite(sma30) ? ` / SMA30 ${formatLevel(sma30, pair)}` : ""}`,
      Number.isFinite(rsi) ? `RSI ${Math.round(rsi)}` : "RSI indisponible",
      `ATR ${formatLevel(atr, pair)}`,
      Number.isFinite(support) && Number.isFinite(resistance) ? `support ${formatLevel(support, pair)}, résistance ${formatLevel(resistance, pair)}` : "zones S/R insuffisantes",
      `confirmations ${confirmations}/6`,
      compatible ? "timeframe cohérent avec la stratégie" : "historique non aligné avec le timeframe demandé",
      meta.stale ? "historique indicatif/différé" : "historique frais ou cache récent",
    ].join("; "),
  };
}

function detectPairFromText(text = "") {
  const normalized = String(text).toUpperCase();
  const candidates = [
    ...symbols,
    "NAS100", "XAG/USD", "XPT/USD", "XPD/USD",
    "GBP/USD", "USD/JPY", "USD/CHF", "USD/CAD", "AUD/USD", "NZD/USD", "EUR/JPY",
  ];
  return candidates.find((pair) => normalized.includes(pair) || normalized.includes(pair.replace("/", ""))) || null;
}

function quickChatAnswer(question = "", images = []) {
  const text = normalizeForSearch(question);
  if (images.length) return null;
  if (!text || /^(salut|bonjour|bonsoir|hello|hi|slt|cc|coucou)\b/.test(text)) {
    return {
      answer: "Salut, je suis ChatBot Kronos. Tu peux me demander une explication trading, un plan de gestion du risque, une lecture de paire ou envoyer jusqu'à 2 graphes pour une analyse éducative.",
      score: 90,
      technique: "Conversation",
    };
  }
  return null;
}

function classifyChatIntent(question = "", images = []) {
  if (images.length) return { type: "analyse_graphique", needsMarketContext: true };
  const text = normalizeForSearch(question);
  const asksSignal = /signal|setup|analyse|entrée|entree|tp|take profit|sl|stop loss|achat|vente|scalp|swing|position|point d.entree|point d'entrée/i.test(question);
  const hasInstrument = /xau|gold|or|eur|usd|gbp|jpy|btc|eth|nas|us500|sp500|forex|crypto|indice|paire/i.test(text);
  const asksCapital = /capital|budget|compte|10\s*(\$|usd|dollar|€|eur)|petit compte|combien risquer|lot|micro lot|cent account/i.test(question);
  const asksEducation = /c.est quoi|explique|comment|pourquoi|apprendre|strategie|stratégie|psychologie|spread|pip|lot|leverage|levier|marge|broker/i.test(question);
  if (asksSignal || (hasInstrument && /trade|trader|acheter|vendre|maintenant|aujourd'hui/i.test(question))) {
    return { type: "signal_ou_setup", needsMarketContext: true };
  }
  if (asksCapital) return { type: "gestion_capital", needsMarketContext: false };
  if (asksEducation) return { type: "formation_trading", needsMarketContext: false };
  if (hasInstrument) return { type: "discussion_marche", needsMarketContext: true };
  return { type: "conversation_trading", needsMarketContext: false };
}

function normalizeChatAnswer(answer, intent, seed = "") {
  if (intent?.type === "signal_ou_setup" || intent?.type === "analyse_graphique") {
    return normalizeAiAnswer(answer, seed);
  }
  const techniqueByIntent = {
    gestion_capital: "Gestion du risque",
    formation_trading: "Formation",
    discussion_marche: "Contexte marché",
    conversation_trading: "Conversation",
  };
  return {
    answer: cleanLine(answer),
    score: intent?.type === "gestion_capital" ? 82 : 78,
    technique: techniqueByIntent[intent?.type] || "Conversation",
  };
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
    strategy: body.strategy || "Swing Trading",
    risk: body.risk || "Standard 2%",
    analysisDepth: body.analysisDepth || "Profonde",
    livePrice: Number.isFinite(live) ? live : null,
    imageQuality,
    calibration,
    chartContext,
    technicalSnapshot: context.technicalSnapshot || null,
    newsContext: context.newsContext || null,
    multiTimeframe: context.multiTimeframe || [],
    styleComparison: validation.styleComparison,
  };
  const explicitNoSignal = /\baucun signal\b|pas de signal|signal non valid|setup non valid/i.test(text);
  if (explicitNoSignal) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, validation.score, 45),
      technique: normalized.technique === "Mixte" ? "Aucun style validé" : normalized.technique || validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: signal bloqué volontairement, car l'analyse IA n'a pas confirmé un setup exploitable.`,
      validation: { ...validation, valid: false, reason: "Aucun signal confirmé par Kronos." },
      meta,
    });
  }
  if (hasChartImages && imageQuality.score < 20) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, imageQuality.score),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: qualité image insuffisante (${imageQuality.reason}).`,
      validation: { ...validation, valid: false, reason: `Qualité image insuffisante: ${imageQuality.reason}` },
      meta,
    });
  }
  if (!hasChartImages && meta.technicalSnapshot && meta.technicalSnapshot.valid === false) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, validation.score, 42),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: signal bloqué car aucun screenshot n'a été fourni et l'historique API n'est pas assez aligné avec la stratégie/timeframe demandé.`,
      validation: { ...validation, valid: false, reason: "Historique API insuffisant ou non aligné sans screenshot." },
      meta,
    });
  }
  const direction = /vente|baissi/i.test(text) ? "VENTE" : /achat|haussi/i.test(text) ? "ACHAT" : "ACHAT";
  let entry = extractLevel(text, /(?:zone d'entrée|entrée|entry)\s*:?\s*([0-9.,]+)/i, NaN);
  let sl = extractLevel(text, /(?:stop loss|sl)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp = extractLevel(text, /(?:take profit\s*1|tp1|take profit|tp)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp2 = extractLevel(text, /(?:take profit\s*2|tp2)\s*:?\s*([0-9.,]+)/i, NaN);
  let assistedLevels = buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair: body.pair, strategy: body.strategy });
  if (assistedLevels.used) {
    entry = assistedLevels.entry;
    sl = assistedLevels.sl;
    tp = assistedLevels.tp;
    tp2 = assistedLevels.tp2;
  }
  let targetConstraint = constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy: body.strategy });
  if (targetConstraint.used) {
    tp = targetConstraint.tp;
    tp2 = targetConstraint.tp2;
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
  let levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair, strategy: body.strategy });
  if (!levelCheck.valid) {
    const repairedLevels = buildAssistedLevels({ direction, entry: NaN, sl: NaN, tp: NaN, tp2: NaN, live, pair: body.pair, strategy: body.strategy });
    if (repairedLevels.used) {
      entry = repairedLevels.entry;
      sl = repairedLevels.sl;
      tp = repairedLevels.tp;
      tp2 = repairedLevels.tp2;
      const repairedConstraint = constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy: body.strategy });
      if (repairedConstraint.used) {
        tp = repairedConstraint.tp;
        tp2 = repairedConstraint.tp2;
        targetConstraint = repairedConstraint;
      }
      assistedLevels = repairedLevels;
      levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair, strategy: body.strategy });
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
  const suspicious = inspectSuspiciousLevels({ direction, entry, sl, tp1: tp, rr, pair: body.pair });
  if (suspicious.risky) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, normalized.score, 45),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: Trade risqué — ${suspicious.reason}. Les niveaux sont indicatifs uniquement et ne doivent pas être copiés directement.`,
      validation: { ...validation, valid: false, reason: `Trade risqué: ${suspicious.reason}` },
      meta: { ...meta, levelCheck, rr, suspiciousLevels: suspicious },
    });
  }
  const danger = computeDangerScore({ meta, validation, levelCheck, rr, live, entry, strategy: body.strategy });
  const qualityGate = buildQualityGate({ meta, validation, levelCheck, danger, hasChartImages });
  if (!qualityGate.valid) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, normalized.score, 58),
      technique: validation.technique,
      explanation: `${text}\n\nVALIDATION KRONOS: contrôle qualité non validé — ${qualityGate.reason}`,
      validation: { ...validation, valid: false, reason: qualityGate.reason },
      meta: { ...meta, levelCheck, rr, dangerScore: danger.score, danger, qualityGate },
    });
  }
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
  const beginnerPlan = buildBeginnerPlan({ direction, entry, sl, tp1: tp, tp2, pair: body.pair, strategy: body.strategy });
  return {
    ...normalized,
    direction,
    entry: formatLevel(entry, body.pair),
    sl: formatLevel(sl, body.pair),
    tp1: formatLevel(tp, body.pair),
    tp2: formatLevel(Number.isFinite(tp2) ? tp2 : projectTp2(direction, entry, sl, tp), body.pair),
    rr: `1:${rr.toFixed(1)}`,
    score: calibratedScore,
    dangerScore: danger.score,
    beginnerPlan,
    explanation: `${text}\n\nVALIDATION KRONOS: ${validation.reason} Niveaux cohérents. R/R calculé 1:${rr.toFixed(1)}. ${calibration.message}`,
    validation,
    meta: {
      ...meta,
      levelCheck,
      rr,
      dangerScore: danger.score,
      danger,
      qualityGate,
      styleComparison: validation.styleComparison,
      assistedLevels: assistedLevels.used ? assistedLevels.reason : null,
      targetConstraint: targetConstraint.used ? targetConstraint.reason : null,
    },
  };
}

function blockAnalysis(normalized, details) {
  const diagnostic = buildNoSignalDiagnostic(details);
  const danger = details.meta?.danger || computeDangerScore({ meta: details.meta || {}, validation: details.validation || {}, levelCheck: details.meta?.levelCheck || null });
  const qualityGate = details.meta?.qualityGate || {
    ...buildQualityGate({
      meta: details.meta || {},
      validation: details.validation || {},
      levelCheck: details.meta?.levelCheck || { valid: false, reason: details.validation?.reason || diagnostic.statusLabel || "Signal non validé" },
      danger,
      hasChartImages: Number(details.meta?.imageQuality?.images || 0) > 0,
    }),
    valid: false,
    reason: details.validation?.reason || diagnostic.statusLabel || "Signal non validé",
  };
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
    dangerScore: danger.score,
    status: diagnostic.status,
    statusLabel: diagnostic.statusLabel,
    userMessage: diagnostic.userMessage,
    nextActions: diagnostic.nextActions,
    qualityGate,
    diagnostic,
  };
}

function buildNoSignalDiagnostic(details = {}) {
  const meta = details.meta || {};
  const validation = details.validation || {};
  const quality = meta.imageQuality || {};
  const technical = meta.technicalSnapshot || {};
  const levelCheck = meta.levelCheck || {};
  const explanation = `${details.explanation || ""} ${validation.reason || ""} ${levelCheck.reason || ""}`.toLowerCase();

  if (/trade risqué|niveaux suspects|sl trop proche|r\/r trop élevé|tp1 suspect/.test(explanation)) {
    return {
      status: "TRADE_RISQUE",
      statusLabel: "Trade risqué",
      userMessage: "Kronos a détecté des niveaux suspects. Le plan est bloqué pour éviter une exécution dangereuse.",
      nextActions: [
        "Ne copie pas ces niveaux dans MT4/MT5.",
        "Relance avec un graphe plus clair ou un timeframe supérieur.",
        "Attends des niveaux confirmés par la structure du graphique.",
      ],
    };
  }

  if (quality.images > 0 && Number(quality.score) < 35) {
    return {
      status: "IMAGE_INSUFFISANTE",
      statusLabel: "Image insuffisante",
      userMessage: "Kronos a reçu le graphe, mais la capture n'est pas assez lisible pour sortir des niveaux fiables.",
      nextActions: [
        "Envoyer une capture plus nette avec la paire, le timeframe et le prix visibles.",
        "Montrer au moins 60 à 100 bougies, sans zoom excessif.",
        "Garder 1 ou 2 graphes maximum: contexte puis entrée.",
      ],
    };
  }

  if (/vision indisponible|aucune clé groq vision|gemini vision/.test(explanation)) {
    return {
      status: "VISION_HORS_SERVICE",
      statusLabel: "Vision IA indisponible",
      userMessage: "Le serveur ne peut pas lire les screenshots pour l'instant. L'analyse image est donc bloquée.",
      nextActions: [
        "Vérifier les clés Groq/Gemini dans secret.dev ou sur Render.",
        "Relancer le serveur après modification des variables.",
        "Utiliser temporairement une analyse texte/prix live.",
      ],
    };
  }

  if (technical.valid === false || /historique insuffisant|donnée non fiable|fallback|indisponible/.test(explanation)) {
    return {
      status: "DONNEES_FAIBLES",
      statusLabel: "Données marché faibles",
      userMessage: "Les données live ou l'historique ne suffisent pas pour valider un setup propre.",
      nextActions: [
        "Réessayer sur une paire majeure comme EUR/USD, GBP/USD ou XAU/USD.",
        "Attendre une source fraîche ou changer de timeframe.",
        "Ajouter un screenshot clair pour compenser les limites API.",
      ],
    };
  }

  if (/range|neutre|momentum faible|setup non valid|aucun signal|score d'efficacité insuffisant/.test(explanation) || technical.trend === "neutre/range") {
    return {
      status: "SETUP_NON_CONFIRME",
      statusLabel: "Setup non confirmé",
      userMessage: "Kronos comprend le contexte, mais le marché ne donne pas assez de confluence pour entrer maintenant.",
      nextActions: [
        "Attendre une cassure, un retest ou un rejet clair.",
        "Surveiller les zones support/résistance indiquées dans l'analyse.",
        "Relancer après une nouvelle bougie ou sur un timeframe supérieur.",
      ],
    };
  }

  if (/niveau|entrée|sl|tp|ratio|cohérent/.test(explanation)) {
    return {
      status: "NIVEAUX_INCOHERENTS",
      statusLabel: "Niveaux non exploitables",
      userMessage: "L'IA a produit une idée, mais les niveaux entrée, SL ou TP ne sont pas assez cohérents pour être copiés.",
      nextActions: [
        "Changer de style d'analyse en Mixte.",
        "Confirmer la paire et le timeframe manuellement.",
        "Relancer avec un graphe montrant clairement supports, résistances et prix actuel.",
      ],
    };
  }

  return {
    status: "ANALYSE_PRUDENTE",
    statusLabel: "Analyse prudente",
    userMessage: "Kronos bloque le trade pour éviter un signal forcé. L'analyse reste utile comme lecture de marché.",
    nextActions: [
      "Confirmer le contexte avec un screenshot net.",
      "Choisir le mode Mixte pour comparer les styles.",
      "Ne prendre aucun trade sans confirmation visuelle.",
    ],
  };
}

function computeDangerScore({ meta = {}, validation = {}, levelCheck = {}, rr = null, live = null, entry = null, strategy = "" }) {
  const reasons = [];
  let score = 12;
  const technical = meta.technicalSnapshot || {};
  const news = meta.newsContext || {};
  const image = meta.imageQuality || {};
  if (technical.valid === false) {
    score += 22;
    reasons.push("historique/timeframe faible");
  }
  if (technical.trend === "neutre/range") {
    score += isScalpingStrategy(strategy || meta.strategy) ? 16 : 12;
    reasons.push("marché en range");
  }
  if (technical.stale || technical.timeframeCompatible === false) {
    score += 18;
    reasons.push("données non alignées");
  }
  if (news.activeRisk) {
    score += 28;
    reasons.push("news rouge proche");
  }
  if (Number(image.images || 0) > 0 && Number(image.score || 0) < 45) {
    score += 18;
    reasons.push("image peu lisible");
  }
  if (validation.valid === false || Number(validation.score || 0) < 55) {
    score += 12;
    reasons.push("style peu confirmé");
  }
  if (levelCheck?.valid === false) {
    score += 22;
    reasons.push("niveaux invalides");
  }
  if (Number.isFinite(Number(rr)) && Number(rr) > (isScalpingStrategy(strategy || meta.strategy) ? 2.2 : 4.5)) {
    score += 10;
    reasons.push("objectif trop ambitieux");
  }
  const liveNumber = Number(live ?? meta.livePrice);
  const entryNumber = Number(entry);
  if (Number.isFinite(liveNumber) && Number.isFinite(entryNumber) && liveNumber > 0) {
    const distance = Math.abs(entryNumber - liveNumber) / liveNumber;
    if (distance > levelTolerance(meta.pair, strategy || meta.strategy)) {
      score += 14;
      reasons.push("entrée éloignée");
    }
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    label: score >= 70 ? "Élevé" : score >= 40 ? "Moyen" : "Faible",
    reasons: reasons.length ? reasons : ["risque standard"],
  };
}

function buildQualityGate({ meta = {}, validation = {}, levelCheck = {}, danger = {}, hasChartImages = false }) {
  const checks = [
    {
      name: "Prix live",
      ok: Number.isFinite(Number(meta.livePrice)),
      detail: Number.isFinite(Number(meta.livePrice)) ? "prix disponible" : "prix indisponible",
    },
    {
      name: "Historique",
      ok: meta.technicalSnapshot?.valid !== false,
      detail: meta.technicalSnapshot?.source || "source inconnue",
    },
    {
      name: "News",
      ok: !meta.newsContext?.activeRisk,
      detail: meta.newsContext?.activeRisk ? "news rouge proche" : "pas de blocage macro",
    },
    {
      name: "Style",
      ok: validation.valid !== false && Number(validation.score || 0) >= 45,
      detail: `${Number(validation.score || 0)}%`,
    },
    {
      name: "Niveaux",
      ok: levelCheck?.valid !== false,
      detail: levelCheck?.reason || "cohérents",
    },
    {
      name: "Danger",
      ok: Number(danger.score || 0) < 65,
      detail: `${Number(danger.score || 0)}%`,
    },
  ];
  if (hasChartImages) {
    checks.push({
      name: "Image",
      ok: Number(meta.imageQuality?.score || 0) >= 35,
      detail: `${Number(meta.imageQuality?.score || 0)}%`,
    });
  }
  const failed = checks.filter((check) => !check.ok);
  return {
    valid: failed.length === 0,
    reason: failed.length ? failed.map((check) => `${check.name}: ${check.detail}`).join(" · ") : "Tous les contrôles qualité sont validés.",
    checks,
  };
}

function buildBeginnerPlan({ direction, entry, sl, tp1, tp2, pair, strategy }) {
  return {
    title: isScalpingStrategy(strategy) ? "Plan scalping débutant" : "Plan débutant",
    steps: [
      `Entrée seulement si le prix confirme ${formatLevel(entry, pair)}.`,
      `Stop Loss à ${formatLevel(sl, pair)} sans l'élargir après entrée.`,
      `TP1 prudent à ${formatLevel(tp1, pair)}: fermer 50% ou sécuriser une partie.`,
      `Après TP1, déplacer le SL vers breakeven si la plateforme le permet.`,
      `TP2 moyen à ${formatLevel(tp2, pair)}: laisser courir uniquement si le momentum reste propre.`,
    ],
    copy: [
      `ENTREE: ${formatLevel(entry, pair)}`,
      `SL: ${formatLevel(sl, pair)}`,
      `TP1 PRUDENT: ${formatLevel(tp1, pair)}`,
      `TP2 MOYEN: ${formatLevel(tp2, pair)}`,
      "GESTION: Fermer 50% à TP1 puis protéger le reste.",
    ].join("\n"),
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
    groups: [["vague", "wave", "elliott"], ["abc", "vague 1", "vague 2", "vague 3", "vague 4", "vague 5", "wave 1"], ["invalidation", "correction", "impulsion"]],
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

function validateTradeLevels({ direction, entry, sl, tp, live, pair, strategy }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { valid: false, score: 0, reason: "Niveaux numériques invalides." };
  const buy = direction === "ACHAT";
  if (buy && !(sl < entry && tp > entry)) return { valid: false, score: 20, reason: "Pour un achat, SL doit être sous l'entrée et TP au-dessus." };
  if (!buy && !(sl > entry && tp < entry)) return { valid: false, score: 20, reason: "Pour une vente, SL doit être au-dessus de l'entrée et TP sous l'entrée." };
  const rr = rewardRisk(direction, entry, sl, tp);
  const minRr = isScalpingStrategy(strategy) ? 0.75 : 1.2;
  if (!Number.isFinite(rr) || rr < minRr) return { valid: false, score: 35, reason: `R/R trop faible (${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}).` };
  const suspicious = inspectSuspiciousLevels({ direction, entry, sl, tp1: tp, rr, pair });
  if (suspicious.risky) return { valid: false, score: 28, reason: `Trade risqué: ${suspicious.reason}` };
  if (Number.isFinite(live)) {
    const distance = Math.abs(entry - live) / Math.max(Math.abs(live), 1);
    const tolerance = levelTolerance(pair, strategy);
    if (distance > tolerance) {
      const strict = isScalpingStrategy(strategy) || distance > tolerance * 2;
      return {
        valid: !strict,
        score: strict ? 32 : 50,
        reason: `Entrée trop éloignée du prix live (${(distance * 100).toFixed(2)}%, tolérance ${(tolerance * 100).toFixed(2)}%). ${strict ? "Setup bloqué: attendre un prix plus proche." : "À confirmer avant exécution."}`,
      };
    }
  }
  return { valid: true, score: Math.max(55, Math.min(100, Math.round(55 + rr * 12))), reason: "Niveaux cohérents avec direction, R/R et prix live." };
}

function buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair, strategy }) {
  if ([entry, sl, tp].every(Number.isFinite)) {
    return { used: false, entry, sl, tp, tp2 };
  }
  if (!Number.isFinite(live) || live <= 0) {
    return { used: false, entry, sl, tp, tp2 };
  }
  const buy = direction !== "VENTE";
  const risk = assistedRiskDistance(live, pair, strategy);
  const targets = targetMultipliers(strategy);
  const finalEntry = Number.isFinite(entry) ? entry : live;
  const finalSl = Number.isFinite(sl) ? sl : buy ? finalEntry - risk : finalEntry + risk;
  const finalTp = Number.isFinite(tp) ? tp : buy ? finalEntry + risk * targets.tp1 : finalEntry - risk * targets.tp1;
  const finalTp2 = Number.isFinite(tp2) ? tp2 : buy ? finalEntry + risk * targets.tp2 : finalEntry - risk * targets.tp2;
  return {
    used: true,
    entry: finalEntry,
    sl: finalSl,
    tp: finalTp,
    tp2: finalTp2,
    reason: "Niveaux assistés générés depuis le prix live car l'IA n'a pas fourni tous les chiffres.",
  };
}

function constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { used: false, tp, tp2 };
  const targets = targetMultipliers(strategy);
  const risk = Math.abs(entry - sl);
  if (!risk) return { used: false, tp, tp2 };
  const buy = direction !== "VENTE";
  const rr1 = Math.abs(tp - entry) / risk;
  const rr2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / risk : NaN;
  const clampRr = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
  const safeRr1 = clampRr(rr1, targets.minTp1, targets.maxTp1, targets.tp1);
  const safeRr2 = clampRr(rr2, targets.minTp2, targets.maxTp2, targets.tp2);
  const finalTp = buy ? entry + risk * safeRr1 : entry - risk * safeRr1;
  const finalTp2 = buy ? entry + risk * Math.max(safeRr2, safeRr1 + 0.25) : entry - risk * Math.max(safeRr2, safeRr1 + 0.25);
  const changed = Math.abs(finalTp - tp) > risk * 0.05 || !Number.isFinite(tp2) || Math.abs(finalTp2 - tp2) > risk * 0.05;
  return {
    used: changed,
    tp: changed ? finalTp : tp,
    tp2: changed ? finalTp2 : tp2,
    reason: isScalpingStrategy(strategy)
      ? `Objectifs scalping resserrés: TP1 ${safeRr1.toFixed(1)}R prudent, TP2 ${Math.max(safeRr2, safeRr1 + 0.25).toFixed(1)}R moyen.`
      : `Objectifs ajustés selon la stratégie: TP1 ${safeRr1.toFixed(1)}R, TP2 ${Math.max(safeRr2, safeRr1 + 0.25).toFixed(1)}R.`,
  };
}

function targetMultipliers(strategy = "") {
  if (isScalpingStrategy(strategy)) {
    return { tp1: 0.95, tp2: 1.65, minTp1: 0.75, maxTp1: 1.2, minTp2: 1.35, maxTp2: 2.0 };
  }
  if (/breakout/i.test(String(strategy))) return { tp1: 1.2, tp2: 2.2, minTp1: 1.0, maxTp1: 1.8, minTp2: 1.7, maxTp2: 3.2 };
  if (/position/i.test(String(strategy))) return { tp1: 1.8, tp2: 3.2, minTp1: 1.2, maxTp1: 2.4, minTp2: 2.2, maxTp2: 4.5 };
  return { tp1: 1.35, tp2: 2.2, minTp1: 1.0, maxTp1: 1.8, minTp2: 1.7, maxTp2: 3.2 };
}

function assistedRiskDistance(price, pair = "", strategy = "") {
  const scalp = isScalpingStrategy(strategy);
  if (/BTC/i.test(pair)) return scalp ? Math.max(price * 0.0022, 80) : Math.max(price * 0.006, 250);
  if (/ETH/i.test(pair)) return scalp ? Math.max(price * 0.003, 4) : Math.max(price * 0.008, 12);
  if (/XAU/i.test(pair)) return scalp ? Math.max(price * 0.00045, 1.2) : Math.max(price * 0.0025, 8);
  if (/XAG/i.test(pair)) return scalp ? Math.max(price * 0.0025, 0.06) : Math.max(price * 0.006, 0.18);
  if (/US500|NAS|SPX/i.test(pair)) return scalp ? Math.max(price * 0.0012, 6) : Math.max(price * 0.0035, 18);
  if (/JPY/i.test(pair)) return scalp ? Math.max(price * 0.00028, 0.03) : Math.max(price * 0.0025, 0.25);
  return scalp ? Math.max(price * 0.00025, 0.00025) : Math.max(price * 0.0018, 0.0018);
}

function levelTolerance(pair = "", strategy = "") {
  const scalp = isScalpingStrategy(strategy);
  if (/BTC|ETH/i.test(pair)) return scalp ? 0.012 : 0.035;
  if (/XAU|XAG|US500|NAS|SPX/i.test(pair)) return scalp ? 0.006 : 0.018;
  if (/JPY/i.test(pair)) return scalp ? 0.0035 : 0.008;
  return scalp ? 0.0015 : 0.0035;
}

function isScalpingStrategy(strategy = "") {
  return /scalp|m1|m5|m15/i.test(String(strategy));
}

function rewardRisk(direction, entry, sl, tp) {
  const risk = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return risk > 0 ? reward / risk : NaN;
}

function applySignalSafety(signal) {
  const suspicious = inspectSuspiciousLevels({
    direction: signal.direction,
    entry: Number(signal.entree),
    sl: Number(signal.sl),
    tp1: Number(signal.tp1),
    rr: parseRr(signal.rr),
    pair: signal.paire,
  });
  if (!suspicious.risky) return signal;
  return {
    ...signal,
    suspended: true,
    direct: false,
    confiance: Math.min(Number(signal.confiance) || 45, 45),
    raison: `⚠️ Trade risqué — ${suspicious.reason}.`,
    quality: {
      ...(signal.quality || {}),
      valid: false,
      reason: "niveaux_suspects",
      details: suspicious,
    },
  };
}

function inspectSuspiciousLevels({ direction, entry, sl, tp1, rr, pair }) {
  const reasons = [];
  const rrValue = Number.isFinite(Number(rr)) ? Number(rr) : parseRr(rr);
  if (Number.isFinite(rrValue) && rrValue > 10) reasons.push(`R/R trop élevé (${rrValue.toFixed(1)})`);
  if (isFallbackRoundLevel(tp1)) reasons.push(`TP1 suspect (${formatLevel(tp1)})`);
  const minDistance = minStopDistance(pair);
  if (minDistance > 0 && Number.isFinite(entry) && Number.isFinite(sl)) {
    const risk = Math.abs(entry - sl);
    if (risk > 0 && risk < minDistance) reasons.push(`SL trop proche (${formatLevel(risk)} < ${formatLevel(minDistance)})`);
  }
  if (Number.isFinite(entry) && Number.isFinite(sl) && direction === "ACHAT" && sl >= entry) reasons.push("SL achat au-dessus ou égal à l'entrée");
  if (Number.isFinite(entry) && Number.isFinite(sl) && direction === "VENTE" && sl <= entry) reasons.push("SL vente sous ou égal à l'entrée");
  return {
    risky: reasons.length > 0,
    reason: reasons.join(" · "),
    reasons,
  };
}

function parseRr(value) {
  const match = String(value ?? "").replace(",", ".").match(/([0-9]+(?:\.[0-9]+)?)/g);
  if (!match?.length) return NaN;
  return Number(match.at(-1));
}

function isFallbackRoundLevel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  if ([1, 2, 100].some((candidate) => Math.abs(number - candidate) < 1e-9)) return true;
  const text = String(value);
  return /^(1|2|100)(?:[.,]0+)?$/.test(text);
}

function minStopDistance(pair = "") {
  if (/BTC|ETH|US500|NAS|SPX/i.test(pair)) return 0;
  if (/XAU/i.test(pair)) return 0.2;
  if (/XAG/i.test(pair)) return 0.02;
  if (/JPY/i.test(pair)) return 0.02;
  if (/USD|EUR|GBP|AUD|NZD|CAD|CHF/i.test(pair)) return 0.0002;
  return 0;
}

function projectTp2(direction, entry, sl, tp1) {
  const risk = Math.abs(entry - sl);
  const rr2 = Math.max(rewardRisk(direction, entry, sl, tp1), 1.6);
  return direction === "ACHAT" ? entry + risk * Math.min(rr2 + 0.8, 4) : entry - risk * Math.min(rr2 + 0.8, 4);
}

async function loadMarketCache() {
  const fromMongo = await loadStateDocument("market-cache");
  if (fromMongo) {
    return {
      version: 1,
      prices: fromMongo.prices && typeof fromMongo.prices === "object" ? fromMongo.prices : {},
      histories: fromMongo.histories && typeof fromMongo.histories === "object" ? fromMongo.histories : {},
      updatedAt: fromMongo.updatedAt || null,
    };
  }
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
  if (await saveStateDocument("market-cache", trimmed)) return trimmed;
  await mkdir(dataDir, { recursive: true });
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
  return isSymbolOpen(symbol) ? 20 * 60 * 1000 : 12 * 60 * 60 * 1000;
}

function fastPriceCacheTtlMs(symbol) {
  if (/BTC|ETH/i.test(symbol)) return 90 * 1000;
  return isSymbolOpen(symbol) ? 3 * 60 * 1000 : 12 * 60 * 60 * 1000;
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

function getApiStatus() {
  const statusFor = (name, keys) => ({
    totalKeys: keys.length,
    activeKeys: keys.filter((key) => !isKeyExhausted(key)).length,
    currentIndex: rotationCounters[name] || 0,
  });
  return {
    twelveData: statusFor("twelveData", TWELVE_DATA_KEYS),
    alphaVantage: statusFor("alphaVantage", ALPHA_VANTAGE_KEYS),
    massive: statusFor("massive", MASSIVE_KEYS),
    exchangeRate: statusFor("exchangeRate", EXCHANGERATE_KEYS),
    groq: statusFor("groq", GROQ_KEYS),
    gemini: statusFor("gemini", GEMINI_KEYS),
    finnhub: statusFor("finnhub", FINNHUB_KEYS),
    marketaux: statusFor("marketaux", MARKETAUX_KEYS),
    binance: { status: "unlimited", noKey: true },
    coinbase: { status: "unlimited", noKey: true },
    frankfurter: { status: "unlimited", noKey: true },
    stooq: { status: "unlimited", noKey: true },
    exhaustedKeys: exhaustedKeys.size,
    blacklistTtlMinutes: 60,
  };
}

async function mongoDb() {
  if (!mongoUri || mongoUnavailable) return null;
  try {
    if (!mongoClientPromise) {
      const client = new MongoClient(mongoUri, {
        serverSelectionTimeoutMS: 900,
        connectTimeoutMS: 900,
      });
      mongoClientPromise = client.connect();
    }
    const client = await mongoClientPromise;
    mongoLastError = null;
    recordProviderHealth("mongodb", true);
    return client.db(mongoDbName);
  } catch (error) {
    mongoUnavailable = true;
    mongoClientPromise = null;
    mongoLastError = sanitizeError(error.message);
    recordProviderHealth("mongodb", false, mongoLastError);
    console.warn(`MongoDB indisponible, fallback fichier local: ${mongoLastError}`);
    return null;
  }
}

async function stateCollection() {
  const db = await mongoDb();
  return db ? db.collection("app_state") : null;
}

async function loadStateDocument(id) {
  const collection = await stateCollection();
  if (!collection) return null;
  try {
    const doc = await collection.findOne({ _id: id });
    return doc?.payload || null;
  } catch (error) {
    mongoUnavailable = true;
    mongoLastError = sanitizeError(error.message);
    recordProviderHealth("mongodb", false, mongoLastError);
    return null;
  }
}

async function saveStateDocument(id, payload) {
  const collection = await stateCollection();
  if (!collection) return false;
  try {
    await collection.updateOne(
      { _id: id },
      { $set: { payload, updatedAt: new Date() } },
      { upsert: true },
    );
    return true;
  } catch (error) {
    mongoUnavailable = true;
    mongoLastError = sanitizeError(error.message);
    recordProviderHealth("mongodb", false, mongoLastError);
    return false;
  }
}

function healthRecommendations() {
  const tips = [];
  if (!mongoUri) tips.push("Ajouter MONGODB_URI dans secret.dev pour persister caches, analyses et résultats sur MongoDB.");
  if (mongoLastError) tips.push(`MongoDB indisponible: ${mongoLastError}. Le serveur utilise le fallback fichier local.`);
  if (!ALPHA_VANTAGE_KEYS.length) tips.push("Ajouter ALPHA_VANTAGE_API_KEY ou ALPHA_VANTAGE_API_KEY_1..8 dans secret.dev pour un fallback prix Forex/Crypto.");
  if (!MASSIVE_KEYS.length) tips.push("Ajouter MASSIVE_API_KEY dans secret.dev pour remplacer Polygon avec un fallback prix/historique plus propre.");
  tips.push("Fallbacks sans clé actifs: Binance pour crypto, Coinbase pour BTC/ETH spot, Stooq/Frankfurter pour Forex indicatif.");
  if (!TWELVE_DATA_KEYS.length) tips.push("Ajouter TWELVE_DATA_API_KEY ou TWELVE_DATA_API_KEY_1..8: source principale prix + historiques.");
  if (!GROQ_KEYS.length) tips.push("Ajouter GROQ_KEY ou GROQ_KEY_1..3: moteur texte et Groq Vision.");
  if (!hasVisionProvider()) tips.push("Ajouter GROQ_KEY ou GEMINI_API_KEY: nécessaire pour analyser les screenshots.");
  else if (!GEMINI_KEYS.length) tips.push("Ajouter GEMINI_API_KEY ou GEMINI_API_KEY_1..8 si tu veux un fallback vision quand Groq Vision est indisponible.");
  if (!tips.length) tips.push("Toutes les clés principales sont présentes; surveiller /api/health pour les dégradations.");
  return tips;
}

async function databaseSummary() {
  if (!mongoUri) {
    return { configured: false, connected: false, storage: "file", dbName: null, lastError: null };
  }
  const db = await mongoDb();
  return {
    configured: true,
    connected: Boolean(db),
    storage: db ? "mongodb" : "file_fallback",
    dbName: mongoDbName,
    lastError: mongoLastError,
  };
}

async function loadAuthStore() {
  const fromMongo = await loadStateDocument("auth-store");
  if (fromMongo) {
    return {
      version: 1,
      users: Array.isArray(fromMongo.users) ? fromMongo.users : [],
      sessions: Array.isArray(fromMongo.sessions) ? fromMongo.sessions : [],
      updatedAt: fromMongo.updatedAt || null,
    };
  }
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      updatedAt: parsed.updatedAt || null,
    };
  } catch {
    return { version: 1, users: [], sessions: [], updatedAt: null };
  }
}

async function saveAuthStore(store) {
  const now = new Date().toISOString();
  const trimmed = {
    version: 1,
    users: store.users.slice(-5000),
    sessions: store.sessions
      .filter((session) => new Date(session.expiresAt).getTime() > Date.now())
      .slice(-10000)
      .map(({ token, ...session }) => session),
    updatedAt: now,
  };
  if (await saveStateDocument("auth-store", trimmed)) return trimmed;
  await mkdir(dataDir, { recursive: true });
  await writeFile(authPath, `${JSON.stringify(trimmed, null, 2)}\n`, "utf8");
  return trimmed;
}

async function signupUser(body = {}) {
  const name = cleanLine(body.name || body.fullName || "");
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (name.length < 2) return { ok: false, error: "Nom trop court." };
  if (!isValidEmail(email)) return { ok: false, error: "Email invalide." };
  if (password.length < 8) return { ok: false, error: "Mot de passe trop court: 8 caractères minimum." };
  const store = await loadAuthStore();
  if (store.users.some((user) => user.email === email)) return { ok: false, error: "Un compte existe déjà avec cet email." };
  const now = new Date().toISOString();
  const user = {
    id: `usr_${Date.now()}_${randomBytes(4).toString("hex")}`,
    name,
    email,
    passwordHash: hashPassword(password),
    plan: "free",
    role: "user",
    createdAt: now,
    updatedAt: now,
    preferences: {
      level: "débutant",
      favoritePairs: ["EUR/USD", "XAU/USD"],
    },
  };
  const session = createSession(user.id);
  store.users.push(user);
  store.sessions.push(session);
  await saveAuthStore(store);
  return { ok: true, user, session };
}

async function loginUser(body = {}) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const store = await loadAuthStore();
  const user = store.users.find((item) => item.email === email);
  if (!user || !verifyPassword(password, user.passwordHash)) return { ok: false, error: "Email ou mot de passe incorrect." };
  const session = createSession(user.id);
  store.sessions = store.sessions.filter((item) => item.userId !== user.id || new Date(item.expiresAt).getTime() > Date.now());
  store.sessions.push(session);
  user.lastLoginAt = new Date().toISOString();
  await saveAuthStore(store);
  return { ok: true, user, session };
}

async function currentSession(req) {
  const token = cookieValue(req, "oracle_session");
  if (!token) return null;
  const tokenHash = sessionHash(token);
  const store = await loadAuthStore();
  const session = store.sessions.find((item) => item.tokenHash === tokenHash && new Date(item.expiresAt).getTime() > Date.now());
  if (!session) return null;
  const user = store.users.find((item) => item.id === session.userId);
  if (!user) return null;
  return { session, user };
}

async function destroySession(token) {
  const tokenHash = sessionHash(token);
  const store = await loadAuthStore();
  store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash);
  await saveAuthStore(store);
}

function createSession(userId) {
  const token = randomBytes(32).toString("base64url");
  return {
    id: `ses_${Date.now()}_${randomBytes(4).toString("hex")}`,
    userId,
    token,
    tokenHash: sessionHash(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan || "free",
    role: user.role || "user",
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    preferences: user.preferences || {},
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = pbkdf2Sync(password, salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

function verifyPassword(password, stored = "") {
  const [algo, iterations, salt, hash] = String(stored).split("$");
  if (algo !== "pbkdf2_sha256" || !iterations || !salt || !hash) return false;
  const computed = pbkdf2Sync(password, salt, Number(iterations), 32, "sha256");
  const expected = Buffer.from(hash, "hex");
  return expected.length === computed.length && timingSafeEqual(expected, computed);
}

function sessionHash(token) {
  return pbkdf2Sync(String(token), "oracle_forex_session", 40000, 32, "sha256").toString("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "").split(";").map((part) => part.trim());
  const prefix = `${name}=`;
  const found = cookies.find((part) => part.startsWith(prefix));
  return found ? decodeURIComponent(found.slice(prefix.length)) : "";
}

function setSessionCookie(res, token) {
  const secure = env.COOKIE_SECURE === "true" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `oracle_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "oracle_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

async function loadLearningLog() {
  const fromMongo = await loadStateDocument("learning-log");
  if (fromMongo) {
    return {
      version: 1,
      analyses: Array.isArray(fromMongo.analyses) ? fromMongo.analyses : [],
      outcomes: Array.isArray(fromMongo.outcomes) ? fromMongo.outcomes : [],
      updatedAt: fromMongo.updatedAt || null,
    };
  }
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
  const trimmed = {
    version: 1,
    analyses: log.analyses.slice(-600),
    outcomes: log.outcomes.slice(-1000),
    updatedAt: new Date().toISOString(),
  };
  if (await saveStateDocument("learning-log", trimmed)) return trimmed;
  await mkdir(dataDir, { recursive: true });
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
  const tp2 = parseFormattedNumber(result.tp2);
  log.analyses.push({
    id,
    createdAt: new Date().toISOString(),
    userId: context.user?.id || null,
    pair: body.pair || "EUR/USD",
    timeframe: body.timeframe || "H1",
    style: body.style || "Hybride SMC+Chartiste",
    strategy: body.strategy || "Swing Trading",
    risk: body.risk || "Standard 2%",
    analysisDepth: context.analysisDepth || normalizeAnalysisDepth(body.analysisDepth),
    direction: result.direction,
    entry,
    sl,
    tp1,
    tp2,
    rr: result.rr,
    score: Number(result.score) || 0,
    active,
    status: active ? "OPEN" : "BLOCKED",
    blockReason: active ? null : result.validation?.reason || "Signal bloqué",
    livePriceAtSignal: context.livePrice?.price ?? null,
    imageQuality: context.imageQuality,
    calibration: context.calibration,
    validation: result.validation,
    technicalSnapshot: context.technicalSnapshot || null,
    multiTimeframe: context.multiTimeframe || [],
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
        userId: analysis.userId || null,
        pair: analysis.pair,
        timeframe: analysis.timeframe,
        style: analysis.style,
        strategy: analysis.strategy || "Swing Trading",
        analysisDepth: analysis.analysisDepth || "Profonde",
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
  if (Number.isFinite(analysis.tp2)) {
    if (buy && price >= analysis.tp2) return { status: "TP2_HIT", result: "win", price, reason: "TP2 touché." };
    if (!buy && price <= analysis.tp2) return { status: "TP2_HIT", result: "win", price, reason: "TP2 touché." };
  }
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
  const strategy = body.strategy || "Swing Trading";
  const buckets = [
    (item) => item.style === style && (item.strategy || "Swing Trading") === strategy && item.pair === pair && item.timeframe === timeframe,
    (item) => item.style === style && item.pair === pair,
    (item) => item.style === style && (item.strategy || "Swing Trading") === strategy,
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
  const strategies = ["Scalping", "Swing Trading", "Position Trading", "Breakout", "Reversal"];
  const byStrategy = Object.fromEntries(strategies.map((strategy) => {
    const items = closed.filter((item) => (item.strategy || "Swing Trading") === strategy);
    const strategyWins = items.filter((item) => item.result === "win").length;
    return [strategy, {
      samples: items.length,
      winRate: items.length ? Math.round((strategyWins / items.length) * 100) : null,
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
    byStrategy,
    note: "Apprentissage contrôlé: Kronos calibre ses scores avec les résultats, sans modifier le code automatiquement.",
  };
}

function performancePayload(log) {
  const summary = learningSummary(log);
  const closed = log.outcomes.filter((item) => ["win", "loss"].includes(item.result));
  const recent = closed.slice(-12).reverse();
  const totalSignals = log.analyses.filter((item) => item.active).length;
  const precisionLabel = summary.closedAnalyses >= 20 && summary.globalWinRate !== null
    ? `${summary.globalWinRate}%`
    : "À auditer";
  return {
    updatedAt: summary.updatedAt,
    precision: summary.globalWinRate,
    precisionLabel,
    precisionAudited: summary.closedAnalyses >= 20,
    closedAnalyses: summary.closedAnalyses,
    totalAnalyses: summary.totalAnalyses,
    activeSignals: totalSignals,
    blockedAnalyses: summary.blockedAnalyses,
    openAnalyses: summary.openAnalyses,
    instrumentsTracked: symbols.length,
    membersLabel: "500+",
    byStyle: summary.byStyle,
    byStrategy: summary.byStrategy,
    recent: recent.map((item) => ({
      pair: item.pair,
      style: item.style,
      strategy: item.strategy,
      result: item.result,
      status: item.status,
      score: item.score,
      closedAt: item.closedAt,
    })),
    disclaimer: summary.closedAnalyses >= 20
      ? "Performance calculée sur les signaux clôturés enregistrés par Kronos."
      : "Échantillon encore trop petit: la précision publique doit rester non auditée.",
  };
}

function personalAnalysesPayload(log, userId) {
  const analyses = log.analyses.filter((item) => item.userId === userId);
  const analysisIds = new Set(analyses.map((item) => item.id));
  const closed = log.outcomes.filter((item) => (item.userId === userId || analysisIds.has(item.id)) && ["win", "loss"].includes(item.result));
  const wins = closed.filter((item) => item.result === "win").length;
  return {
    ok: true,
    summary: {
      total: analyses.length,
      open: analyses.filter((item) => item.status === "OPEN").length,
      blocked: analyses.filter((item) => item.status === "BLOCKED").length,
      closed: closed.length,
      winRate: closed.length ? Math.round((wins / closed.length) * 100) : null,
    },
    analyses: analyses.slice(-20).reverse().map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      pair: item.pair,
      timeframe: item.timeframe,
      style: item.style,
      strategy: item.strategy,
      direction: item.direction,
      entry: item.entry,
      sl: item.sl,
      tp1: item.tp1,
      tp2: item.tp2,
      rr: item.rr,
      score: item.score,
      status: item.status,
      blockReason: item.blockReason,
    })),
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
  const known = ["Hybride SMC+Chartiste", "ICT", "Wyckoff", "Elliott", "Price Action", "Ichimoku", "SMC"];
  const match = String(text).match(/TECHNIQUE_UTILISEE\s*:?\s*([^\n\r]+)/i);
  if (match) {
    const captured = cleanLine(match[1])
      .replace(/\b(?:SCORE_CONFIANCE|STYLE_EFFICACITE)\b.*$/i, "")
      .trim();
    if (/^PA\b/i.test(captured)) return "Price Action";
    const haystack = normalizeForSearch(captured);
    return known.find((item) => haystack.includes(normalizeForSearch(item))) || captured.slice(0, 28);
  }
  const haystack = normalizeForSearch(text);
  return known.find((item) => haystack.includes(normalizeForSearch(item))) || "Price Action";
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

function formatLevel(value, pair = "") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const digits = decimalsForPair(pair, number);
  return number.toFixed(digits);
}

function decimalsForPair(pair = "", value = 0) {
  const symbol = String(pair).toUpperCase();
  if (/BTC|ETH|US500|NAS|SPX/i.test(symbol)) return Math.abs(value) >= 1000 ? 1 : 2;
  if (/XAU|XAG|XPT|XPD/i.test(symbol)) return 2;
  if (/JPY/i.test(symbol)) return 3;
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) || Math.abs(value) < 10) return 5;
  return Math.abs(value) >= 100 ? 2 : 5;
}

function cleanLine(text) {
  return String(text || "").replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ").trim();
}

function sanitizeError(message) {
  return String(message || "")
    .replace(/mongodb(?:\+srv)?:\/\/[^"'\s]+/gi, "mongodb://<redacted>")
    .replace(/(Bearer|key|token|password|pwd)\s+[^"'\s]+/gi, "$1 <redacted>");
}

async function loadEnv(path) {
  if (!existsSync(path)) return {};
  const raw = await readFile(path, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^mongodb(?:\+srv)?:\/\//i.test(trimmed) && !out.MONGODB_URI) {
      out.MONGODB_URI = trimmed;
      continue;
    }
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function inferMongoDbName(uri) {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    const db = url.pathname.replace(/^\//, "").trim();
    return db || null;
  } catch {
    return null;
  }
}

async function serveStatic(res, pathname) {
  if ((pathname === "/admin" || pathname === "/admin-health" || pathname === "/admin-health.html") && env.ADMIN_HEALTH_PUBLIC !== "true") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const aliases = {
    "/analyse": "/analyse.html",
    "/analyse-ia": "/analyse.html",
    "/tester-gratuitement": "/analyse.html",
    "/paiement": "/paiement.html",
    "/abonnement": "/paiement.html",
    "/login": "/login.html",
    "/connexion": "/login.html",
    "/signup": "/signup.html",
    "/inscription": "/signup.html",
    "/dashboard": "/dashboard.html",
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
