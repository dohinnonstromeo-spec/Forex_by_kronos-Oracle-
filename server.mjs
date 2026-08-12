import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { createGzip, createBrotliCompress } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { imageSize } from "image-size";

const root = fileURLToPath(new URL(".", import.meta.url));
const env = await loadEnv(join(root, "secret.dev"));
const port = Number(env.PORT || 4174);
const dataDir = join(root, "data");
const learningPath = join(dataDir, "learning-log.json");
const marketCachePath = join(dataDir, "market-cache.json");
const authPath = join(dataDir, "auth-store.json");
const sqliteDbPath = join(dataDir, "oracle.db");
const supabaseUrl = normalizeSupabaseUrl(env.SUPABASE_URL || env.SUPABASE_PROJECT_URL || "");
const supabaseProjectRef = env.SUPABASE_PROJECT_REF || inferSupabaseProjectRef(supabaseUrl);
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY || "";
const { Pool } = pg;
const databaseUrl = env.DATABASE_URL || "";
const pgPool = databaseUrl ? new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } }) : null;
let pgTableReady = false;

// Users/sessions/analyses live in real per-row tables (not a single JSON blob) so
// there's no whole-document overwrite race and no silent truncation-at-scale cap.
// Postgres in production (DATABASE_URL set), node:sqlite locally otherwise -- same
// schema, same queries (?-placeholders, translated to $1.. for pg), so both paths
// get identical behavior instead of maintaining a JSON-file code path that diverges
// from production.
let sqliteDb = null;
function getSqliteDb() {
  if (!pgPool && !sqliteDb) {
    sqliteDb = new DatabaseSync(sqliteDbPath);
  }
  return sqliteDb;
}

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function sqlRun(sql, params = []) {
  if (pgPool) {
    await pgPool.query(toPgPlaceholders(sql), params);
    return;
  }
  getSqliteDb().prepare(sql).run(...params);
}

async function sqlGet(sql, params = []) {
  if (pgPool) {
    const { rows } = await pgPool.query(toPgPlaceholders(sql), params);
    return rows[0] || null;
  }
  return getSqliteDb().prepare(sql).get(...params) || null;
}

async function sqlAll(sql, params = []) {
  if (pgPool) {
    const { rows } = await pgPool.query(toPgPlaceholders(sql), params);
    return rows;
  }
  return getSqliteDb().prepare(sql).all(...params);
}

let relationalTablesReady = false;
async function ensureRelationalTables() {
  if (relationalTablesReady) return;
  const statements = [
    `CREATE TABLE IF NOT EXISTS users (
      id text PRIMARY KEY,
      name text NOT NULL,
      email text NOT NULL UNIQUE,
      password_hash text NOT NULL,
      plan text NOT NULL DEFAULT 'free',
      role text NOT NULL DEFAULT 'user',
      premium_until text,
      manual_premium integer NOT NULL DEFAULT 0,
      premium_source text,
      preferences text NOT NULL DEFAULT '{}',
      usage text NOT NULL DEFAULT '{}',
      created_at text NOT NULL,
      updated_at text NOT NULL,
      last_login_at text
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id text PRIMARY KEY,
      user_id text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      created_at text NOT NULL,
      expires_at text NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
    `CREATE TABLE IF NOT EXISTS analyses (
      id text PRIMARY KEY,
      user_id text,
      created_at text NOT NULL,
      pair text, timeframe text, style text, strategy text, risk text, capital text,
      analysis_depth text,
      direction text, entry real, sl real, tp1 real, tp2 real, rr text,
      score real, active integer, status text, block_reason text,
      live_price_at_signal real, image_quality text, calibration text, validation text,
      technical_snapshot text, multi_timeframe text,
      closed_at text, close_price real, outcome text, outcome_reason text, r_multiple real,
      is_test integer NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_analyses_status ON analyses(status)`,
    `CREATE INDEX IF NOT EXISTS idx_analyses_user ON analyses(user_id)`,
    `CREATE INDEX IF NOT EXISTS idx_analyses_outcome ON analyses(outcome)`,
  ];
  if (pgPool) {
    for (const statement of statements) await pgPool.query(statement);
  } else {
    for (const statement of statements) getSqliteDb().exec(statement);
  }
  // Tables created before this column existed need it added on top -- ALTER TABLE
  // ADD COLUMN, not CREATE TABLE IF NOT EXISTS, actually reaches an existing table.
  // Swallowing "already exists" makes this safe to call on every startup regardless
  // of whether the column is already there.
  await ensureColumn("analyses", "is_test integer NOT NULL DEFAULT 0");
  relationalTablesReady = true;
  await migrateLegacyJsonIntoRelationalTables();
}

async function ensureColumn(table, columnDef) {
  const alterSql = `ALTER TABLE ${table} ADD COLUMN ${columnDef}`;
  try {
    if (pgPool) await pgPool.query(alterSql);
    else getSqliteDb().exec(alterSql);
  } catch (error) {
    if (!/already exists|duplicate column/i.test(error.message)) throw error;
  }
}

async function ensureStateTable() {
  if (!pgPool || pgTableReady) return;
  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS ${supabaseStateTable} (
      id text PRIMARY KEY,
      payload jsonb,
      updated_at timestamptz DEFAULT now()
    )
  `);
  pgTableReady = true;
}

const supabaseStateTable = env.SUPABASE_STATE_TABLE || "oracle_app_state";
let supabaseUnavailable = false;
let supabaseLastError = null;
const providerHealth = new Map();
const anonymousUsage = new Map();
const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = Number(env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_WINDOW_MS = Number(env.LOGIN_WINDOW_MINUTES || 15) * 60 * 1000;
// /api/signup had no rate limit at all -- confirmed live, 10 accounts created back
// to back with no throttling, each starting with a fresh free-tier quota. This
// doesn't add email verification (no email-sending infra exists here), but it does
// close the "just sign up again when the quota runs out" bypass by making repeated
// signups from the same source expensive in time, same mechanism as the login limiter.
const signupAttempts = new Map();
const SIGNUP_MAX_ATTEMPTS = Number(env.SIGNUP_MAX_ATTEMPTS || 5);
const SIGNUP_WINDOW_MS = Number(env.SIGNUP_WINDOW_MINUTES || 60) * 60 * 1000;
const memoryCache = {
  prices: { value: null, expiresAt: 0 },
  histories: { key: "", value: null, expiresAt: 0 },
  calendar: { value: null, expiresAt: 0 },
  signals: { value: null, expiresAt: 0 },
  performance: { value: null, expiresAt: 0 },
};

const GROQ_MODEL = env.GROQ_MODEL || "llama-3.3-70b-versatile";
const GROQ_FALLBACK_MODEL = "llama-3.3-70b-versatile";
// Confirmed live (2026-08-11, both configured GROQ_KEY_* values): this Groq
// account has zero vision-capable models available -- GET /v1/models lists 15 text
// models and nothing matching scout/maverick/vision. meta-llama/llama-4-scout and
// llama-4-maverick (the hardcoded IDs groqVision() tries) both 404 model_not_found
// regardless of key. Not fixable by rotating keys -- it's an account/plan
// restriction. Gated off here so every chart analysis doesn't pay for two guaranteed-
// dead HTTP round trips before falling through to Gemini. Set GROQ_VISION_ENABLED=true
// once vision access is actually available on the account again.
const GROQ_VISION_ENABLED = env.GROQ_VISION_ENABLED === "true";
// gemini-2.0-flash/gemini-2.5-flash/gemini-1.5-flash-latest were the previous
// defaults here and are now dead: confirmed live (real generateContent calls, all 4
// configured GEMINI_API_KEY_* values) that Google returns 404 "no longer available"
// for all three on 3 of our 4 keys (2.5-flash still works on one -- an older
// grandfathered project -- so it's kept as a second attempt, not dropped outright).
// gemini-flash-latest is the only one that succeeded on every key tested.
const GEMINI_MODEL = env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_FALLBACK_MODELS = [
  GEMINI_MODEL,
  "gemini-flash-latest",
  "gemini-2.5-flash",
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

// Pairs where scripts/backtest.mjs found no positive-expectancy variant for the
// deterministic SMA+RSI momentum strategy (confluence, RSI, momentum-floor, SL-width
// and volatility-ceiling variants all tested negative on held-out data). Routed to a
// cautious/non-direct signal instead of silently shipping a known-losing setup. Not a
// verdict on the pair itself -- a different strategy family (mean-reversion, range,
// volatility-breakout) might still work there; that's unresearched, not ruled out.
const PAIRS_WITHOUT_VALIDATED_EDGE = new Set(["GBP/JPY"]);

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
- Yahoo Finance: fallback Forex/métaux/indices sans clé, fiabilité cible 74.
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
Risk par trade: Protection maximale 0.5% par défaut pour débutants/petits comptes. Conservateur 1%, Standard 2%, Agressif 3% uniquement si l'utilisateur le choisit, score très fort, pas de news rouge et confluences solides.
La taille de lot doit être calculée pour que la perte au SL ne dépasse jamais le pourcentage choisi. Ne promets jamais de "récupérer vite" un petit compte.
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

const SECURITY_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "script-src 'self'",
  // 'unsafe-inline' is required here: the React bundle (assets/index-*.js) sets inline
  // styles at runtime (charts, dynamic positioning) -- confirmed by a real browser
  // walkthrough that showed hundreds of blocked style-src violations without this.
  // script-src stays 'self'-only, which is what actually matters for XSS protection;
  // inline *style* injection is a much lower-severity risk than inline *script*.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data:",
  "font-src 'self' https://fonts.gstatic.com data:",
  "connect-src 'self'",
  "frame-src https://s.tradingview.com",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "form-action 'self'",
].join("; ");

function applySecurityHeaders(res, req) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=(), payment=()");
  res.setHeader("Content-Security-Policy", SECURITY_CSP);
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  if (env.NODE_ENV === "production" || forwardedProto === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  }
}

createServer(async (req, res) => {
  try {
    applySecurityHeaders(res, req);
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname, req);
  } catch (error) {
    // The socket may still have unread oversized-body bytes buffered on it for a
    // 413; "Connection: close" tells Node to close it after this response instead
    // of reusing it for a next keep-alive request (which would misread those
    // leftover bytes as a new request line).
    if (error.statusCode === 413) res.setHeader("Connection", "close");
    sendJson(res, error.statusCode || 500, { error: error.statusCode === 413 ? "payload_too_large" : "server_error", message: error.message });
  }
}).listen(port, () => {
  console.log(`Oracle Forex local: http://127.0.0.1:${port}/#signaux`);
  startLearningOutcomesScheduler();
  startSignalsBroadcastScheduler();
  startRateLimitMapSweeper();
});

// anonymousUsage, loginAttempts and signupAttempts are only ever added to, never
// swept -- confirmed by reading every call site, no delete() exists for
// anonymousUsage at all. On real traffic that's one permanent Map entry per unique
// visitor per day, forever, for the life of the process. Not an immediate crash,
// but a slow, unbounded leak that gets worse specifically as more users visit over
// time -- exactly the kind of thing that's invisible in short-lived local testing.
const RATE_LIMIT_SWEEP_INTERVAL_MS = Number(env.RATE_LIMIT_SWEEP_INTERVAL_MINUTES || 30) * 60 * 1000;

function startRateLimitMapSweeper() {
  const sweep = () => {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    for (const [key, entry] of loginAttempts) {
      if (now - entry.firstAttemptAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
    }
    for (const [key, entry] of signupAttempts) {
      if (now - entry.firstAttemptAt > SIGNUP_WINDOW_MS) signupAttempts.delete(key);
    }
    for (const [key, usage] of anonymousUsage) {
      if (usage?.date !== today) anonymousUsage.delete(key);
    }
  };
  setInterval(sweep, RATE_LIMIT_SWEEP_INTERVAL_MS);
}

const LEARNING_OUTCOMES_INTERVAL_MS = Number(env.LEARNING_OUTCOMES_INTERVAL_SECONDS || 90) * 1000;

function startLearningOutcomesScheduler() {
  const tick = async () => {
    try {
      const prices = await getPrices();
      await updateLearningOutcomes(prices);
    } catch (error) {
      logOnce("scheduler", `sync outcomes échoué (${error.message})`);
    }
  };
  tick();
  setInterval(tick, LEARNING_OUTCOMES_INTERVAL_MS);
}

// Without dedup, every concurrent request that saw an expired cache fired its own
// full recompute (price + history fetches against external providers) at once --
// wasted work that gets worse specifically under concurrent multi-user load, and
// burns through the same API key quota the rotation fix earlier was trying to
// stretch further. Concurrent callers now share the one in-flight computation.
let signalsComputeInFlight = null;

async function computeSignalsPayload() {
  if (signalsComputeInFlight) return signalsComputeInFlight;
  signalsComputeInFlight = (async () => {
    try {
      const prices = await getPrices();
      const market = marketStatus();
      const histories = await getHistories(prices);
      await updateLearningOutcomes(prices);
      const newsRisk = await economicRiskWindow();
      const signals = applyNewsRisk(buildDeterministicSignals(prices, histories), newsRisk);
      const payload = { generatedAt: new Date().toISOString(), market, newsRisk, signals, cached: false };
      memoryCache.signals = { value: payload, expiresAt: Date.now() + signalCacheTtlMs(signals, newsRisk) };
      return payload;
    } finally {
      signalsComputeInFlight = null;
    }
  })();
  return signalsComputeInFlight;
}

const signalStreamClients = new Set();
const MAX_SIGNAL_STREAM_CLIENTS = Number(env.MAX_SIGNAL_STREAM_CLIENTS || 500);
// The global cap alone meant a single unauthenticated script could open all 500
// slots itself and lock every real visitor out of the live feed with a 503. This
// caps how many of those slots any one source can hold at once.
const signalStreamByClient = new Map();
const MAX_SIGNAL_STREAM_PER_CLIENT = Number(env.MAX_SIGNAL_STREAM_PER_CLIENT || 3);
const SIGNALS_BROADCAST_INTERVAL_MS = Number(env.SIGNALS_BROADCAST_INTERVAL_SECONDS || 60) * 1000;

function startSignalsBroadcastScheduler() {
  const tick = async () => {
    if (!signalStreamClients.size) return; // no one listening: don't burn provider quota
    try {
      const cached = memoryCache.signals.value;
      const stale = !cached || Date.now() >= memoryCache.signals.expiresAt;
      const payload = stale ? await computeSignalsPayload() : cached;
      const message = `data: ${JSON.stringify(payload)}\n\n`;
      for (const client of signalStreamClients) client.write(message);
    } catch (error) {
      logOnce("signals_stream", `diffusion échouée (${error.message})`);
    }
  };
  setInterval(tick, SIGNALS_BROADCAST_INTERVAL_MS);
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/signup") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const rateLimit = checkSignupRateLimit(req);
    if (!rateLimit.ok) {
      sendJson(res, 429, {
        ok: false,
        error: "too_many_signups",
        message: `Trop de comptes créés récemment depuis cette connexion. Réessaie dans ${Math.ceil(rateLimit.retryAfterSeconds / 60)} min.`,
        retryAfterSeconds: rateLimit.retryAfterSeconds,
      });
      return;
    }
    const body = await readBody(req);
    registerSignupAttempt(req);
    const result = await signupUser(body);
    if (!result.ok) return sendJson(res, 400, result);
    setSessionCookie(res, result.session.token, req);
    sendJson(res, 200, { ok: true, user: publicUser(result.user) });
    return;
  }

  if (url.pathname === "/api/login") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const body = await readBody(req);
    const result = await loginUser(body, req);
    if (!result.ok) return sendJson(res, result.error === "too_many_attempts" ? 429 : 401, result);
    setSessionCookie(res, result.session.token, req);
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

  if (url.pathname === "/api/admin/members") {
    const admin = await requireAdmin(req);
    if (!admin.ok) return sendJson(res, admin.status, admin);
    const store = await loadAuthStore();
    sendJson(res, 200, {
      ok: true,
      users: store.users
        .slice()
        .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
        .slice(0, 200)
        .map(adminUserPayload),
    });
    return;
  }

  if (url.pathname === "/api/admin/grant-premium") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const admin = await requireAdmin(req);
    if (!admin.ok) return sendJson(res, admin.status, admin);
    const body = await readBody(req);
    sendJson(res, 200, await grantPremiumAccess(body));
    return;
  }

  if (url.pathname === "/api/admin/revoke-premium") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
    const admin = await requireAdmin(req);
    if (!admin.ok) return sendJson(res, admin.status, admin);
    const body = await readBody(req);
    sendJson(res, 200, await revokePremiumAccess(body));
    return;
  }

  if (url.pathname === "/api/market-status") {
    sendJson(res, 200, marketStatus());
    return;
  }

  if (url.pathname === "/api/provider-status") {
    if (env.ADMIN_HEALTH_PUBLIC !== "true") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
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
      supabase: hasSupabaseConfig(),
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
    // /admin-health.html is gated behind this same flag (serveStatic()), but the API
    // it fetches from wasn't -- confirmed live: this returned full internals
    // (database status, provider error history, cache state, learning metrics) to
    // an unauthenticated direct request even with the HTML page correctly 404ing.
    // /api/provider-status below had the identical gap. Matches the page's own
    // access model (env-controlled, not a login flow) rather than requireAdmin(),
    // since the admin-health.js frontend never attaches an admin token/session today.
    if (env.ADMIN_HEALTH_PUBLIC !== "true") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    const learning = await loadLearningLog();
    const database = await databaseSummary();
    sendJson(res, 200, {
      market: marketStatus(),
      database,
      providers: providerHealthSnapshot(),
      cache: await marketCacheSummary(),
      runtimeCache: runtimeCacheSummary(),
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
    const cached = memoryCache.signals.value;
    if (cached && Date.now() < memoryCache.signals.expiresAt) {
      sendJson(res, 200, { ...cached, cached: true, cacheTtlSeconds: Math.max(0, Math.round((memoryCache.signals.expiresAt - Date.now()) / 1000)) });
      return;
    }
    sendJson(res, 200, await computeSignalsPayload());
    return;
  }

  // Server-Sent Events: pushes fresh signals to connected clients instead of
  // making every browser tab poll on its own timer. Backed by the same cache
  // /api/signals uses (signalCacheTtlMs), so this doesn't call the price/
  // history providers any more often than a single active poller already did.
  if (url.pathname === "/api/signals/stream") {
    if (signalStreamClients.size >= MAX_SIGNAL_STREAM_CLIENTS) {
      sendJson(res, 503, { error: "stream_capacity_reached" });
      return;
    }
    const fingerprint = clientFingerprint(req);
    const currentForClient = signalStreamByClient.get(fingerprint) || 0;
    if (currentForClient >= MAX_SIGNAL_STREAM_PER_CLIENT) {
      sendJson(res, 429, { error: "too_many_streams", message: "Trop de connexions temps réel actives depuis cette adresse." });
      return;
    }
    signalStreamByClient.set(fingerprint, currentForClient + 1);
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(": connected\n\n");
    const cached = memoryCache.signals.value;
    if (cached) res.write(`data: ${JSON.stringify(cached)}\n\n`);
    signalStreamClients.add(res);
    req.on("close", () => {
      signalStreamClients.delete(res);
      const remaining = (signalStreamByClient.get(fingerprint) || 1) - 1;
      if (remaining <= 0) signalStreamByClient.delete(fingerprint);
      else signalStreamByClient.set(fingerprint, remaining);
    });
    return;
  }

  if (url.pathname === "/api/learning") {
    const prices = await getPrices();
    const learning = await updateLearningOutcomes(prices);
    sendJson(res, 200, learningSummary(learning));
    return;
  }

  if (url.pathname === "/api/performance") {
    if (memoryCache.performance.value && Date.now() < memoryCache.performance.expiresAt) {
      sendJson(res, 200, { ...memoryCache.performance.value, cached: true });
      return;
    }
    const prices = await getPrices();
    const learning = await updateLearningOutcomes(prices);
    const payload = await performancePayload(learning);
    memoryCache.performance = { value: payload, expiresAt: Date.now() + 5 * 60 * 1000 };
    sendJson(res, 200, payload);
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

  // /api/comment, /api/news-summary and /api/briefing used to call the paid Groq API
  // with no authentication and no quota check at all -- confirmed live, scriptable
  // in an unbounded loop at zero cost to the caller. They now share the same "chat"
  // quota bucket as /api/chat: same order of cost per call, no reason for a separate
  // limit config just for these decorative endpoints.
  if (url.pathname === "/api/comment") {
    const session = await currentSession(req);
    const quota = await consumeQuota(session?.user, "chat", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
    const body = await readBody(req);
    const prompt = `${body.pair} vient de passer de ${body.previous} à ${body.current} (${body.changePercent}%). 1 phrase d'analyse trader en français. Maximum 12 mots.`;
    const comment = await groq(prompt, 40, 0.3);
    sendJson(res, 200, { comment: cleanLine(comment) || "Momentum confirmé par Kronos." });
    return;
  }

  if (url.pathname === "/api/news-summary") {
    const session = await currentSession(req);
    const quota = await consumeQuota(session?.user, "chat", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
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
    const session = await currentSession(req);
    const quota = await consumeQuota(session?.user, "chat", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
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
    const session = await currentSession(req);
    const quota = await consumeQuota(session?.user, "chat", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
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
    const session = await currentSession(req);
    const quota = await consumeQuota(session?.user, "detection", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
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
    const quota = await consumeQuota(session?.user, "analysis", req);
    if (!quota.ok) {
      sendJson(res, 429, quota);
      return;
    }
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
    const autoDetectEnabled = body.autoDetect === true || body.autoDetect === "on" || body.autoDetect === "true";
    const analysisDepth = normalizeAnalysisDepth(body.analysisDepth);
    const deepAnalysis = analysisDepth === "Profonde";
    const includeNewsContext = deepAnalysis && (body.includeNewsContext === true || body.includeNewsContext === "on" || body.includeNewsContext === "true");
    const chartContext = autoDetectEnabled ? normalizeChartDetection(body.detectedContext) : normalizeChartDetection(null);
    const selectedPair = chartContext.primaryPair || body.pair || "EUR/USD";
    const selectedTimeframe = chartContext.executionTimeframe || body.timeframe || "H1";
    const livePrice = await getAnalysisPrice(selectedPair);
    const history = await getHistoryForSymbol(selectedPair, livePrice, {
      timeframe: selectedTimeframe,
      strategy: body.strategy || "Swing Trading",
      historyBudgetMs: deepAnalysis ? 11000 : 3500,
    });
    const technicalSnapshot = buildTechnicalSnapshot(selectedPair, history, livePrice, {
      timeframe: selectedTimeframe,
      strategy: body.strategy || "Swing Trading",
    });
    const multiTimeframe = deepAnalysis
      ? await buildMultiTimeframeContext(selectedPair, livePrice, {
        timeframe: selectedTimeframe,
        strategy: body.strategy || "Swing Trading",
        historyBudgetMs: images.length ? 7000 : 9000,
      })
      : [];
    const newsContext = includeNewsContext ? await analysisNewsContext(selectedPair) : { enabled: false, summary: "Contexte news/API désactivé par l'utilisateur.", events: [], headlines: [] };
    const learning = await loadLearningLog();
    const calibration = calibrationFor(learning, body);
    const quickApiSetup = !deepAnalysis && !images.length && Number.isFinite(Number(livePrice?.price)) && isUsableLivePrice(livePrice);
    const deepAssistedSetup = deepAnalysis && !images.length && Number.isFinite(Number(livePrice?.price)) && isUsableLivePrice(livePrice) && !newsContext?.activeRisk && technicalSnapshot?.valid;
    const apiOnlySetup = deepAssistedSetup || (!images.length && includeNewsContext && shouldUseApiOnlySetup({
      livePrice,
      technicalSnapshot,
      newsContext,
      multiTimeframe,
    }));
    const apiOnlyBlockReason = !images.length && includeNewsContext && !apiOnlySetup
      ? apiOnlyNoSignalReason({ livePrice, technicalSnapshot, newsContext, multiTimeframe })
      : null;
    const prompt = `${KRONOS_SYSTEM_PROMPT}

CONTEXTE:
- Paire confirmée: ${selectedPair}
- Timeframe formulaire: ${body.timeframe || "H1"}
- Timeframes détectés: ${(chartContext.timeframes || []).join(", ") || "non détectés"}
- Timeframe final d'exécution: ${selectedTimeframe}
- Style demandé: ${body.style || "Mixte"}
- Stratégie demandée: ${body.strategy || "Swing Trading"}
- Gestion du risque: ${body.risk || defaultRiskMode()}
- Capital indiqué: ${body.capital ? `${body.capital} unité(s) de compte` : "non indiqué"}
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
${deepAnalysis
  ? "Mode Profonde: réfléchis comme un analyste trading expérimenté. Tu dois lier explicitement paire, timeframe, capital, stratégie, style, risque, prix live, historique, MTF et news. Si une donnée contredit vraiment le setup, baisse le score ou rends le plan conditionnel. Ne retourne AUCUN SIGNAL que si prix live absent, news rouge active, niveaux incohérents ou risque structurel dangereux. Donne un raisonnement utile, pas seulement des niveaux."
  : "Mode Rapide: fais court, direct et exploitable. Reprends le comportement rapide classique: lecture du graphe ou du prix live, niveaux cohérents, validation prudente, sans analyse macro/MTF longue."}
Si aucun graphe n'est fourni, ne prétends jamais voir des chandeliers, order blocks, FVG, nuage Ichimoku, vagues Elliott ou structures visibles. Dans ce cas, écris clairement "Analyse sans screenshot", utilise seulement prix live/contexte formulaire, et plafonne le score à 70.
Si un ou plusieurs graphes sont fournis, distingue ce qui est réellement visible sur les images de ce qui vient du prix live/API.
Si le style demandé est "Mixte", compare ICT, SMC, Wyckoff, Elliott, Price Action et Ichimoku, puis retiens uniquement le style avec la meilleure efficacité visible.
Si le style demandé n'est pas "Mixte" et que sa structure n'est pas clairement visible, baisse le score d'efficacité mais ne bloque pas si les niveaux sont cohérents.
Tu dois citer les éléments techniques visibles qui justifient le style retenu.
Adapte les niveaux à la stratégie demandée: Scalping = entrée proche du prix live, SL court, TP1 proche/prudent et TP2 moyen; Swing Trading = structure H1/H4/D1; Position Trading = niveaux majeurs; Breakout = attendre clôture/retest; Reversal = confirmer rejet/CHOCH/divergence avant entrée.
En scalping, TP1 doit souvent être autour de 0.8R à 1.2R et TP2 autour de 1.4R à 2.0R. N'étire pas les profits comme un swing trade.
En mode Protection maximale, privilégie une prise partielle forte à TP1, un déplacement du SL à breakeven après TP1, et rappelle que la taille de lot doit limiter la perte à 0.5% du capital.
Si la détection automatique est désactivée, utilise la paire et le timeframe du formulaire comme contexte confirmé.
Si le setup n'est pas confirmé, retourne AUCUN SIGNAL au lieu de forcer une opportunité. Si le graphe est absent ou incomplet, fais une analyse prudente basée sur la paire, le timeframe et le prix live, sans prétendre lire des bougies.
Les niveaux doivent rester cohérents avec la structure du graphique et le ratio risque/rendement doit être calculable.
Format des niveaux: Forex non-JPY toujours avec 5 décimales (ex: 1.08472), paires JPY avec 3 décimales, métaux avec 2 décimales, indices/crypto selon leur cotation.
Si plusieurs graphes sont fournis ou si le mode Profonde est actif: utilise les timeframes élevés pour la tendance/contexte et le plus petit timeframe détecté pour l'entrée finale.
Si le contexte news/API est activé, croise le setup avec les titres récents et le calendrier économique. Si une news rouge proche touche la devise, bloque ou baisse le score au lieu de forcer un trade.
Retour obligatoire: direction, entrée, stop loss, TP1, TP2, R/R, SCORE_CONFIANCE, TECHNIQUE_UTILISEE, et une ligne "STYLE_EFFICACITE:[style]=[0-100]".

    Analyse le contexte fourni et donne un setup éducatif exploitable avec prudence.`;
    const aiBudgetMs = images.length
      ? deepAnalysis ? 85000 : 35000
      : deepAnalysis ? 32000 : 9000;
    // Fired now, alongside the main vision call below, so this only costs an extra
    // API call, not extra latency (both resolve around the same time; awaited once
    // `answer` is already settled). No-ops instantly (checked: false) unless both
    // GROQ_KEYS and GEMINI_KEYS are configured.
    const visionConsensusPromise = images.length ? visionConsensusCheck(images) : Promise.resolve({ checked: false });
    let answer = !deepAnalysis && !images.length
      ? buildDeterministicAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        strategy: body.strategy || "Swing Trading",
        livePrice,
        risk: body.risk,
        capital: body.capital,
        technicalSnapshot,
        newsContext,
        multiTimeframe,
      })
      : apiOnlySetup
      ? buildApiOnlyAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        strategy: body.strategy || "Swing Trading",
        risk: body.risk,
        livePrice,
        technicalSnapshot,
        newsContext,
        multiTimeframe,
      })
      : apiOnlyBlockReason
        ? buildApiOnlyNoSignalText({
          pair: selectedPair,
          timeframe: selectedTimeframe,
          style: body.style || "Mixte",
          strategy: body.strategy || "Swing Trading",
          livePrice,
          technicalSnapshot,
          newsContext,
          multiTimeframe,
          reason: apiOnlyBlockReason,
        })
      : await promiseWithTimeout(
        images.length ? analyzeChartImage(prompt, images, deepAnalysis ? 1800 : 1000) : groq(prompt, 700, 0.25),
        aiBudgetMs,
        "",
      );
    if (!answer) {
      answer = buildDeterministicAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        strategy: body.strategy || "Swing Trading",
        livePrice,
        risk: body.risk,
        capital: body.capital,
        technicalSnapshot,
        newsContext,
        multiTimeframe,
      });
    }
    if (deepAnalysis && isUnproductiveAnalysis(answer) && Number.isFinite(Number(livePrice?.price)) && isUsableLivePrice(livePrice) && !newsContext?.activeRisk) {
      answer = buildApiOnlyAnalysisText({
        pair: selectedPair,
        timeframe: selectedTimeframe,
        style: body.style || "Mixte",
        strategy: body.strategy || "Swing Trading",
        risk: body.risk,
        livePrice,
        technicalSnapshot,
        newsContext,
        multiTimeframe,
      });
    }
    const visionConsensus = await visionConsensusPromise;
    const result = normalizeAnalysis(answer, { ...body, pair: selectedPair, timeframe: selectedTimeframe, analysisDepth }, { livePrice, imageQuality, calibration, chartContext, technicalSnapshot, newsContext, multiTimeframe, apiOnlySetup: apiOnlySetup || quickApiSetup, visionConsensus });
    if (!result.educationalOnly && !result.noSignal) await recordLearningAnalysis(result, body, { livePrice, imageQuality, calibration, technicalSnapshot, multiTimeframe, analysisDepth, user: session?.user || null, isTest: isTestRequest(req) });
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

function signalCacheTtlMs(signals = [], newsRisk = null) {
  if (newsRisk?.active) return 60 * 1000;
  const hasDirect = signals.some((signal) => signal.direct && !signal.suspended);
  return hasDirect ? 3 * 60 * 1000 : 90 * 1000;
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
  if (/US500|NAS|SPX/i.test(symbol)) return [fetchMassivePrice, fetchTwelveDataPrice, fetchYahooPrice, fetchStooqPrice];
  if (/XAU|XAG|XPT|XPD/i.test(symbol)) return [fetchTwelveDataPrice, fetchMassivePrice, fetchYahooPrice, fetchStooqPrice];
  return [fetchTwelveDataPrice, fetchMassivePrice, fetchAlphaVantagePrice, fetchYahooPrice, fetchStooqPrice, fetchExchangeRatePrice, fetchFrankfurterPrice];
}

async function getExternalPrice(symbol) {
  if (!symbol) return null;
  try {
    return await fetchBestPrice(symbol, null);
  } catch {
    return null;
  }
}

async function getAnalysisPrice(symbol) {
  if (!symbol) return null;
  const cache = await loadMarketCache();
  const price = await fetchBestPrice(symbol, cache.prices?.[symbol]);
  if (price && Number.isFinite(Number(price.price)) && isLivePriceSource(price.source)) {
    await saveMarketCache({
      ...cache,
      prices: mergeCachedPrices(cache.prices || {}, { [symbol]: price }),
    });
  }
  return price;
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
  let lastError = null;
  for (let attempt = 0; attempt < keys.length; attempt += 1) {
    // Claim the slot synchronously, before the first await: two calls started
    // back-to-back (near-simultaneous HTTP requests) both read rotationCounters
    // before either write happened, so without this they pile onto the same key
    // instead of spreading across the pool. Confirmed empirically before this fix.
    const start = rotationCounters[apiName] || 0;
    const index = start % keys.length;
    rotationCounters[apiName] = (start + 1) % keys.length;
    const key = keys[index];
    if (isKeyExhausted(key)) continue;
    try {
      return await fetchFn(key, index);
    } catch (error) {
      lastError = error;
      if (isQuotaError(error.message)) markKeyExhausted(key);
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

// Stooq sits behind a JS proof-of-work bot challenge from a lot of cloud/hosting IPs
// (it returns an HTML challenge page instead of CSV -- confirmed while building
// scripts/backtest.mjs), so it can silently stop working depending on where this is
// hosted. Yahoo's unofficial chart endpoint is a free, keyless backup for the same
// FX/metals/index symbols; it requires a real User-Agent header or it 429s.
async function fetchYahooJson(yahooSymbol, range, interval) {
  const api = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
  api.searchParams.set("range", range);
  api.searchParams.set("interval", interval);
  const response = await fetch(api, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`yahoo_http_${response.status}`);
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || "yahoo_no_data");
  return result;
}

async function fetchYahooPrice(symbol) {
  const yahooSymbol = toYahooSymbol(symbol);
  if (!yahooSymbol) return null;
  try {
    const result = await fetchYahooJson(yahooSymbol, "5d", "1d");
    const closes = result.indicators?.quote?.[0]?.close?.filter(Number.isFinite) || [];
    const price = Number(result.meta?.regularMarketPrice ?? closes.at(-1));
    const prevClose = Number(closes.at(-2));
    const change = Number.isFinite(price) && Number.isFinite(prevClose) && prevClose > 0
      ? ((price - prevClose) / prevClose) * 100
      : 0;
    if (!Number.isFinite(price)) throw new Error("invalid_price");
    recordProviderHealth("yahoo_price", true);
    return pricePayload(symbol, { price, change }, "yahoo", null, { reliability: 74 });
  } catch (error) {
    recordProviderHealth("yahoo_price", false, error.message);
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
  const budget = Number.isFinite(Number(options.historyBudgetMs)) ? Number(options.historyBudgetMs) : 12000;
  const deadline = Date.now() + Math.max(2500, Math.min(12000, budget));
  const errors = [];
  let fallbackHistory = cached.length >= 30 ? cached : [];
  const attempts = [
    ["binance", fetchBinanceHistory],
    ["massive", fetchMassiveHistory],
    ["twelve_data", fetchTwelveDataHistory],
    ["yahoo", fetchYahooHistory],
    ["stooq", fetchStooqHistory],
  ];
  for (const [source, loader] of attempts) {
    for (const interval of preferredIntervals) {
      if (Date.now() > deadline) {
        errors.push("history_budget_exceeded");
        return fallbackHistory;
      }
      try {
        const bars = await loader(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `${source}:${interval}`, false);
          if (isHistoryCompatible(bars, options)) {
            await saveMarketCache({
              ...cache,
              histories: mergeCachedHistories(cache.histories || {}, { [symbol]: bars }),
            });
            recordProviderHealth(`${source}_history_single`, true);
            return bars;
          }
          if (!fallbackHistory.length || fallbackHistory._meta?.stale) fallbackHistory = bars;
          errors.push(`${source}_${interval}:not_timeframe_compatible`);
          continue;
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
  return fallbackHistory;
}

async function buildMultiTimeframeContext(symbol, livePrice, options = {}) {
  const timeframes = analysisTimeframes(options.timeframe, options.strategy);
  return Promise.all(timeframes.map(async (timeframe) => {
    const history = await getHistoryForSymbol(symbol, livePrice, {
      timeframe,
      strategy: options.strategy,
      historyBudgetMs: options.historyBudgetMs || 4500,
    });
    const snapshot = buildTechnicalSnapshot(symbol, history, livePrice, {
      timeframe,
      strategy: options.strategy,
    });
    return {
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
    };
  }));
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
        const bars = await fetchYahooHistory(symbol, interval);
        if (bars.length >= 30) {
          tagHistory(bars, `yahoo:${interval}`, false);
          recordProviderHealth("yahoo_history", true);
          return [symbol, bars];
        }
        if (bars.length) errors.push(`yahoo_${interval}:insufficient_bars`);
      } catch (error) {
        errors.push(`yahoo_${interval}:${error.message}`);
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
      volume: Number(bar.volume),
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
    volume: Number(bar[5]),
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
      volume: Number(bar.v),
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
    volume: Number(row.Volume || row.volume),
    datetime: `${row.Date || row.date || ""} ${row.Time || row.time || ""}`.trim(),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
  if (!bars.length) throw new Error("invalid_history");
  return bars.slice(-80);
}

async function fetchYahooHistory(symbol, interval) {
  const yahooSymbol = toYahooSymbol(symbol);
  const yahooInterval = toYahooInterval(interval);
  if (!yahooSymbol || !yahooInterval) return [];
  const result = await fetchYahooJson(yahooSymbol, yahooRangeFor(yahooInterval), yahooInterval);
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  const bars = timestamps.map((ts, i) => ({
    close: Number(quote.close?.[i]),
    high: Number(quote.high?.[i]),
    low: Number(quote.low?.[i]),
    volume: Number(quote.volume?.[i]),
    datetime: new Date(ts * 1000).toISOString(),
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
    volume: Number(row.Volume || row.volume),
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

function toYahooSymbol(symbol = "") {
  const normalized = String(symbol).toUpperCase().replace(/[^A-Z0-9/]/g, "");
  const aliases = {
    "EUR/USD": "EURUSD=X",
    "GBP/USD": "GBPUSD=X",
    "USD/JPY": "USDJPY=X",
    "USD/CHF": "USDCHF=X",
    "USD/CAD": "USDCAD=X",
    "AUD/USD": "AUDUSD=X",
    "NZD/USD": "NZDUSD=X",
    "GBP/JPY": "GBPJPY=X",
    "EUR/JPY": "EURJPY=X",
    "XAU/USD": "GC=F", // gold futures used as a spot-XAU/USD proxy: no free spot-gold ticker on Yahoo
    "XAG/USD": "SI=F",
    "BTC/USD": "BTC-USD",
    "ETH/USD": "ETH-USD",
    US500: "^GSPC",
    NAS100: "^NDX",
  };
  if (aliases[normalized]) return aliases[normalized];
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(normalized)) return `${normalized.replace("/", "")}=X`;
  return null;
}

function toYahooInterval(interval = "") {
  return ({
    "1min": "1m",
    "5min": "5m",
    "15min": "15m",
    "30min": "30m",
    "1h": "60m",
    "1day": "1d",
    "1week": "1wk",
  })[interval] || null;
}

function yahooRangeFor(yahooInterval = "") {
  if (yahooInterval === "1m") return "5d";
  if (["5m", "15m", "30m"].includes(yahooInterval)) return "1mo";
  if (yahooInterval === "60m") return "3mo";
  return "2y";
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
    const dataQuality = assessSignalDataQuality(price, history);
    if (dataQuality.score < 70) return cautiousSignal(symbol, price, base, `Fiabilité données insuffisante (${dataQuality.score}%, grade ${dataQuality.grade}) · aucun signal direct validé.`, history);
    if (history.length < 50) return cautiousSignal(symbol, price, base, "Historique insuffisant · aucun signal direct validé.", history);
    if (PAIRS_WITHOUT_VALIDATED_EDGE.has(symbol)) {
      return cautiousSignal(symbol, price, base, "Backtest (scripts/backtest.mjs) : cette logique n'a pas d'edge validé sur cette paire (R moyen négatif sur ~8 variantes testées, confluence/RSI/momentum/SL) · signal direct désactivé par prudence.", history);
    }

    const closes = history.map((bar) => bar.close);
    const last = Number(price.price);
    const sma10 = average(closes.slice(-10));
    const sma30 = average(closes.slice(-30));
    const atr = average(history.slice(-14).map((bar) => Math.max(0, Number(bar.high) - Number(bar.low)))) || last * 0.004;
    const momentum = ((sma10 - sma30) / sma30) * 100;
    const rsi = calculateRsi(closes.slice(-100));
    const move = Number(price.change) || 0;
    // Same 0.04 momentum floor as buildTechnicalSnapshot()'s "neutre/range" cutoff,
    // so a signal never fires while the technical snapshot text shown to the user
    // says the trend is neutral. Backtested neutral-to-slightly-negative on R (not a
    // performance fix), applied for narrative consistency.
    const trendAligned = Math.abs(momentum) >= 0.04 && (momentum >= 0 ? rsi >= 52 : rsi <= 48);
    const volatilityOk = atr / last >= 0.0008;
    const historyFresh = !history._meta?.stale;
    const confluence = [trendAligned, volatilityOk, historyFresh, Math.abs(move) >= 0.05].filter(Boolean).length;
    const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;

    if (!Number.isFinite(last) || !Number.isFinite(momentum) || !Number.isFinite(rsi)) {
      return cautiousSignal(symbol, price, base, "Indicateurs incomplets · aucun signal direct validé.", history);
    }

    // Backtested on ~5y real history (scripts/backtest.mjs): requiring full 4/4
    // confluence instead of 3/4 improved average R both in-sample and on held-out
    // data (+0.043->+0.045 train, +0.057->+0.070 test); a 3/4 bar let too much
    // noise through.
    if (strength < 0.18 || confluence < 4 || !trendAligned) {
      return cautiousSignal(symbol, price, base, `Momentum faible · setup non validé, confluence ${confluence}/4.`, history);
    }

    const direction = momentum >= 0 ? "ACHAT" : "VENTE";
    const spreadBuffer = executionCostBuffer(symbol, "Swing Trading");
    const risk = Math.max(atr * 1.2, last * 0.0025, spreadBuffer * 3);
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
      confiance: Math.min(confidence, dataQuality.score),
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
  const reliability = assessSignalDataQuality(price, history);
  return {
    valid: Boolean(valid && reliability.score >= 65),
    reason,
    source: price.source,
    stale: Boolean(price.stale),
    open: Boolean(price.open),
    reliability: price.reliability || 0,
    dataScore: reliability.score,
    grade: reliability.grade,
    blockers: reliability.blockers,
    historySource: history._meta?.source || (history.length ? "twelve_data" : "none"),
    historyStale: Boolean(history._meta?.stale),
    bars: history.length,
    asOf: price.asOf,
  };
}

function assessSignalDataQuality(price = {}, history = []) {
  const blockers = [];
  let score = 100;
  if (!price.open) {
    score -= 35;
    blockers.push("marché fermé");
  }
  if (!isLivePriceSource(price.source)) {
    score -= 35;
    blockers.push("source non-live");
  }
  if (price.stale) {
    score -= 25;
    blockers.push("prix différé");
  }
  const reliability = Number(price.reliability || 0);
  if (reliability < 80) {
    score -= Math.round((80 - reliability) * 0.45);
    blockers.push(`fiabilité source ${reliability}%`);
  }
  if (!Array.isArray(history) || history.length < 50) {
    score -= history.length >= 30 ? 12 : 28;
    blockers.push(`${history.length || 0} bougies`);
  }
  if (history._meta?.stale) {
    score -= 22;
    blockers.push("historique différé");
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    blockers,
  };
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : NaN;
}

function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  // Wilder's smoothed RSI (the formula TradingView/MT4/MT5 use), not a plain
  // moving average: seeded with a simple average, then smoothed recursively
  // over the rest of the series so it matches what's visible on a chart screenshot.
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
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
  return ["twelve_data", "massive", "alpha_vantage", "coinbase", "stooq", "binance", "yahoo"].includes(source);
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
      logOnce("groq", `${model} indisponible (${error.message})`);
    }
  }
  return geminiText(prompt, maxTokens, temperature);
}

async function groqOnce(key, model, prompt, maxTokens, temperature) {
  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(35000),
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
          signal: AbortSignal.timeout(35000),
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
      logOnce("gemini", `${model} indisponible (${error.message})`);
    }
  }
  return "";
}

async function groqVision(prompt, images, maxTokens = 1000) {
  if (!GROQ_KEYS.length || !GROQ_VISION_ENABLED) return "";
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
          signal: AbortSignal.timeout(45000),
          body: JSON.stringify({
            model,
            messages: [{
              role: "user",
              content: [{ type: "text", text: prompt }, ...imageContent],
            }],
            temperature: 0.25,
            max_tokens: maxTokens,
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
      logOnce("groq_vision", `${model} indisponible (${error.message})`);
    }
  }
  return "";
}

async function analyzeChartImage(prompt, images, maxTokens = 1000) {
  if (!images?.length) return "";
  if (GROQ_KEYS.length && GROQ_VISION_ENABLED) {
    const result = await groqVision(prompt, images, maxTokens);
    if (result && result.length > 50) return result;
    logOnce("vision", "Groq Vision insuffisant, bascule Gemini Vision.");
  }
  if (GEMINI_KEYS.length) {
    // The *0.7 discount here predates gemini-flash-latest and was sized for the old
    // (now-dead) gemini-2.0-flash, which didn't spend tokens on internal reasoning.
    // Confirmed live against the real production prompt (full KRONOS_SYSTEM_PROMPT +
    // context, not a simplified test prompt): even maxTokens+1800 still truncated
    // mid-answer on some runs (finishReason MAX_TOKENS, cut off before
    // SCORE_CONFIANCE) -- the real prompt's complexity pushes reasoning overhead
    // higher, and it varies run to run. maxOutputTokens is a ceiling, not a floor: a
    // generous cap costs nothing when the model finishes early (finishReason STOP),
    // so there's no real downside to erring high here.
    const result = await geminiVision(prompt, images, maxTokens + 3000);
    if (result && result.length > 50) return result;
    logOnce("vision", "Gemini Vision insuffisant.");
  }
  return "";
}

const VISION_CONSENSUS_PROMPT = `Regarde uniquement ce(s) graphe(s) de trading, sans aucun autre contexte.
Réponds en JSON strict uniquement, sans texte autour:
{"pair":"paire détectée ou null","bias":"haussier|baissier|neutre","keyLevel":niveau_numérique_le_plus_visible_ou_null}`;

// Ordinary analyzeChartImage() is a fallback chain: Groq first, Gemini only if Groq's
// answer is too short. That means the two providers never actually check each other --
// whichever answers first is trusted alone. crossCheckStructuralClaims() catches a
// model contradicting data it was already handed in its own prompt, but can't catch a
// model inventing a pattern that simply isn't on the chart. Querying both providers
// independently on the SAME image, in parallel (so latency stays ~1 call, only cost
// doubles), and comparing their raw reads is the one mechanism here that can.
async function visionConsensusCheck(images) {
  if (!images?.length || !GROQ_VISION_ENABLED || !GROQ_KEYS.length || !GEMINI_KEYS.length) return { checked: false };
  const [groqAnswer, geminiAnswer] = await Promise.all([
    // 120 tokens looked generous for ~10 words of JSON but wasn't: confirmed live
    // that gemini-flash-latest spends tokens on internal reasoning before the visible
    // answer, and got cut off mid-JSON (finishReason MAX_TOKENS, unparseable) at both
    // 120 and 200. 300 was the first value that reliably reached finishReason STOP
    // with valid JSON; 400 leaves margin.
    promiseWithTimeout(groqVision(VISION_CONSENSUS_PROMPT, images, 400), 12000, ""),
    promiseWithTimeout(geminiVision(VISION_CONSENSUS_PROMPT, images, 400), 12000, ""),
  ]);
  const a = parseJson(groqAnswer, null);
  const b = parseJson(geminiAnswer, null);
  if (!a || !b) return { checked: false };
  const biasA = String(a.bias || "").toLowerCase();
  const biasB = String(b.bias || "").toLowerCase();
  const biasAgree = !biasA || !biasB || biasA === biasB || biasA === "neutre" || biasB === "neutre";
  const levelA = Number(a.keyLevel);
  const levelB = Number(b.keyLevel);
  let levelAgree = true;
  let levelDeltaPct = null;
  if (Number.isFinite(levelA) && Number.isFinite(levelB) && levelA > 0 && levelB > 0) {
    levelDeltaPct = Math.abs(levelA - levelB) / Math.max(levelA, levelB);
    levelAgree = levelDeltaPct < 0.02;
  }
  const agree = biasAgree && levelAgree;
  return {
    checked: true,
    agree,
    groq: { pair: a.pair || null, bias: biasA || null, keyLevel: Number.isFinite(levelA) ? levelA : null },
    gemini: { pair: b.pair || null, bias: biasB || null, keyLevel: Number.isFinite(levelB) ? levelB : null },
    levelDeltaPct,
    note: agree
      ? "Lecture visuelle confirmée indépendamment par Groq Vision et Gemini Vision."
      : `Désaccord entre Groq Vision et Gemini Vision sur cette image (${!biasAgree ? `biais ${biasA || "?"} vs ${biasB || "?"}` : ""}${!biasAgree && !levelAgree ? ", " : ""}${!levelAgree ? `niveau clé écarté de ${(levelDeltaPct * 100).toFixed(1)}%` : ""}).`,
  };
}

async function geminiVision(prompt, images, maxTokens = 700) {
  if (!GEMINI_KEYS.length) return "";
  for (const model of GEMINI_FALLBACK_MODELS) {
    try {
      const result = await fetchWithRotation("gemini", GEMINI_KEYS, async (key) => {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(45000),
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [
                { text: prompt },
                ...images.map((image) => ({ inline_data: { mime_type: image.mimeType, data: image.data } })),
              ],
            }],
            generationConfig: { temperature: 0.25, maxOutputTokens: maxTokens },
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
      logOnce("gemini_vision", `${model} indisponible (${error.message})`);
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

function promiseWithTimeout(promise, timeoutMs, fallbackValue = null) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallbackValue), timeoutMs)),
  ]);
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

// No limit here used to mean literally none: readBody would buffer a request body
// of any size before even looking at it. Confirmed live -- a 40MB junk payload to
// /api/analyze-chart was accepted and fully processed with a 200. Every concurrent
// request holding one of these in memory multiplies the exposure; this is what
// actually threatens the whole process (and therefore every other connected user),
// not just the requester. 25MB is generous for two base64 chart screenshots (real
// uploads assessed by assessImageQuality() run well under 1MB each in practice).
const MAX_BODY_BYTES = Number(env.MAX_BODY_BYTES || 25 * 1024 * 1024);

function bodyTooLargeError() {
  const error = new Error("payload_too_large");
  error.statusCode = 413;
  return error;
}

async function readBody(req) {
  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) throw bodyTooLargeError();
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // Don't req.destroy() here: on a connection using "Expect: 100-continue" that
    // aborts the socket before our own 413 response goes out, leaving the client
    // with a bare connection reset instead of a readable error. Just stop
    // buffering and let the caller's error response close the connection cleanly
    // (see the top-level catch: 413 responses set Connection: close).
    if (total > MAX_BODY_BYTES) throw bodyTooLargeError();
    chunks.push(chunk);
  }
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
  return (GROQ_KEYS.length > 0 && GROQ_VISION_ENABLED) || GEMINI_KEYS.length > 0;
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
  const parsedScore = extractScore(text);
  return {
    answer: text,
    score: Number.isFinite(parsedScore) ? parsedScore : 40,
    scoreParsed: Number.isFinite(parsedScore),
    technique: extractTechnique(text),
  };
}

function isUnproductiveAnalysis(answer = "") {
  return /aucun signal|pas de signal|setup non confirm|signal non valid|niveaux? non exploit|entrée non exploit|entree non exploit|impossible de proposer|ne pas entrer/i.test(String(answer || ""));
}

function shouldUseApiOnlySetup({ livePrice, technicalSnapshot, newsContext, multiTimeframe = [] }) {
  if (!Number.isFinite(Number(livePrice?.price)) || !isUsableLivePrice(livePrice)) return false;
  if (!technicalSnapshot?.valid) return false;
  if (newsContext?.activeRisk) return false;
  const consensus = analyzeMultiTimeframeConsensus(multiTimeframe);
  if (consensus.conflict && consensus.usable >= 2) return false;
  const executionTrend = /haussi|baissi/i.test(String(technicalSnapshot.trend || ""));
  const strongMtfTrend = /haussi|baissi/i.test(String(consensus.dominant || "")) && consensus.usable >= 2 && consensus.score >= 75;
  if (executionTrend && strongMtfTrend && trendDirection(technicalSnapshot.trend) !== trendDirection(consensus.dominant)) return false;
  if (!executionTrend && !strongMtfTrend) return false;
  return Number(technicalSnapshot.confirmations || 0) >= 4;
}

function apiOnlyNoSignalReason({ livePrice, technicalSnapshot, newsContext, multiTimeframe = [] }) {
  if (!Number.isFinite(Number(livePrice?.price)) || !isUsableLivePrice(livePrice)) {
    return "Prix live absent ou source trop faible.";
  }
  if (!technicalSnapshot?.valid) {
    return "Historique API insuffisant ou non aligné avec le timeframe.";
  }
  if (newsContext?.activeRisk) {
    return "News économique forte proche: signal suspendu.";
  }
  const consensus = analyzeMultiTimeframeConsensus(multiTimeframe);
  if (consensus.conflict && consensus.usable >= 2) {
    return `Conflit multi-timeframe: ${consensus.summary}.`;
  }
  const executionDirection = trendDirection(technicalSnapshot.trend);
  const mtfDirection = trendDirection(consensus.dominant);
  if (executionDirection && mtfDirection && executionDirection !== mtfDirection && consensus.score >= 75) {
    return `Conflit timeframe: exécution ${technicalSnapshot.trend}, contexte supérieur ${consensus.summary}.`;
  }
  if (!executionDirection && !(mtfDirection && consensus.usable >= 2 && consensus.score >= 75)) {
    return `Marché sans tendance exploitable: ${technicalSnapshot.trend || "neutre"}; ${consensus.summary}.`;
  }
  return "Confluence insuffisante pour proposer un plan sans screenshot.";
}

function buildApiOnlyNoSignalText({ pair = "EUR/USD", timeframe = "H1", style = "Mixte", strategy = "Swing Trading", livePrice, technicalSnapshot = {}, newsContext = {}, multiTimeframe = [], reason }) {
  const technique = style === "Mixte" ? "Price Action" : style;
  const mtf = analyzeMultiTimeframeConsensus(multiTimeframe);
  return `📸 LECTURE DES GRAPHIQUES :
Analyse sans screenshot — utilise uniquement prix live + historique API + calendrier/news.

📡 DONNÉES LIVE :
- Prix live: ${formatLevel(livePrice?.price, pair)} | Source: ${livePrice?.source || "API"} | Fiabilité: ${livePrice?.reliability || "n/a"}
- Historique: ${technicalSnapshot.bars || 0} bougies | SMA10/SMA30: ${technicalSnapshot.sma10 ?? "n/a"} / ${technicalSnapshot.sma30 ?? "n/a"} | RSI: ${technicalSnapshot.rsi ?? "n/a"} | ATR: ${technicalSnapshot.atr ?? "n/a"}

📐 TECHNIQUE UTILISÉE : ${technique}
📊 ANALYSE :
- Tendance : ${technicalSnapshot.trend || "Neutre"}
- Signal détecté : AUCUN SIGNAL — ${reason}
- Zone d'entrée : —
- Stop Loss : —
- Take Profit 1 : —
- Take Profit 2 : —
- R/R ratio : —
✅ CONFLUENCE : ${technicalSnapshot.text || "snapshot technique disponible"} | MTF: ${mtf.summary} | News/API: ${newsContext?.summary || "non consulté"}
⚠️ RISQUE : Ce n'est pas un conseil financier. Kronos bloque le plan pour éviter une entrée faible ou contradictoire.
SCORE_CONFIANCE:45
TECHNIQUE_UTILISEE:${technique}
STYLE_EFFICACITE:${technique}=45`;
}

function buildApiOnlyAnalysisText({ pair = "EUR/USD", timeframe = "H1", style = "Mixte", strategy = "Swing Trading", risk, livePrice, technicalSnapshot = {}, newsContext = {}, multiTimeframe = [] }) {
  const mtf = analyzeMultiTimeframeConsensus(multiTimeframe);
  const rawTrend = /haussi|baissi/i.test(String(technicalSnapshot.trend || ""))
    ? String(technicalSnapshot.trend)
    : mtf.dominant;
  const trend = /baissi/i.test(String(rawTrend || "")) ? "baissière" : "haussière";
  const direction = trend === "baissière" ? "VENTE" : "ACHAT";
  const live = Number(livePrice?.price);
  const support = Number(technicalSnapshot.support);
  const resistance = Number(technicalSnapshot.resistance);
  const entry = Number.isFinite(live) ? live : direction === "ACHAT" ? support : resistance;
  const structuralSl = direction === "ACHAT" && Number.isFinite(support) && support < entry
    ? support
    : direction === "VENTE" && Number.isFinite(resistance) && resistance > entry
      ? resistance
      : NaN;
  const levels = buildAssistedLevels({
    direction,
    entry,
    sl: structuralSl,
    tp: NaN,
    tp2: NaN,
    live,
    pair,
    strategy,
    risk,
  });
  const rr = rewardRisk(direction, levels.entry, levels.sl, levels.tp);
  const technique = style === "Mixte" ? "Price Action" : style;
  const newsLine = newsContext?.enabled
    ? newsContext.activeRisk ? "risque macro actif détecté" : "aucune news rouge proche détectée"
    : "contexte news non demandé";
  const confidence = Math.max(62, Math.min(78, 58 + Number(technicalSnapshot.confirmations || 0) * 3 + (mtf.usable >= 2 ? 4 : 0)));
  return `📸 LECTURE DES GRAPHIQUES :
Analyse sans screenshot — utilise uniquement prix live + historique API + calendrier/news.

📡 DONNÉES LIVE :
- Prix live: ${formatLevel(live, pair)} | Source: ${livePrice?.source || "API"} | Fiabilité: ${livePrice?.reliability || "n/a"}
- Historique: ${technicalSnapshot.bars || 0} bougies | SMA10/SMA30: ${technicalSnapshot.sma10 ?? "n/a"} / ${technicalSnapshot.sma30 ?? "n/a"} | RSI: ${technicalSnapshot.rsi ?? "n/a"} | ATR: ${technicalSnapshot.atr ?? "n/a"}

📐 TECHNIQUE UTILISÉE : ${technique}
Lecture Price Action API: tendance ${trend}, support ${formatLevel(support, pair)}, résistance ${formatLevel(resistance, pair)}, cassure/retest à confirmer avant exécution.

📊 ANALYSE :
- Tendance : ${trend === "baissière" ? "Baissière" : "Haussière"}
- Signal détecté : ${direction} prudent basé sur prix live, structure API et gestion du risque
- Zone d'entrée : ${formatLevel(levels.entry, pair)}
- Stop Loss : ${formatLevel(levels.sl, pair)}
- Take Profit 1 : ${formatLevel(levels.tp, pair)}
- Take Profit 2 : ${formatLevel(levels.tp2, pair)}
- R/R ratio : 1:${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}
✅ CONFLUENCE : ${technicalSnapshot.text || "snapshot technique disponible"} | MTF: ${mtf.summary} | News/API: ${newsLine}
⚠️ RISQUE : Ce n'est pas un conseil financier. Sans screenshot, Kronos exige confirmation visuelle du rejet, retest ou momentum avant entrée réelle.
SCORE_CONFIANCE:${confidence}
TECHNIQUE_UTILISEE:${technique}
STYLE_EFFICACITE:${technique}=${confidence}`;
}

function trendDirection(value = "") {
  if (/baissi|vente/i.test(String(value))) return "VENTE";
  if (/haussi|achat/i.test(String(value))) return "ACHAT";
  return null;
}

function extractTradeDirection(text = "") {
  const signalLine = String(text).match(/Signal détecté\s*:\s*([^\n\r]+)/i)?.[1] || "";
  const direct = trendDirection(signalLine);
  if (direct) return direct;
  return trendDirection(text);
}

function buildDeterministicAnalysisText({ pair = "EUR/USD", timeframe = "H1", style = "Mixte", strategy = "Swing Trading", livePrice, risk, capital, technicalSnapshot = {}, newsContext = {}, multiTimeframe = [] }) {
  const price = Number.isFinite(Number(livePrice?.price))
    ? Number(livePrice.price)
    : Number(fallbackPrices[pair]?.price) || 1;
  const snapshotDirection = trendDirection(technicalSnapshot.trend);
  const mtf = analyzeMultiTimeframeConsensus(multiTimeframe);
  const mtfDirection = trendDirection(mtf.dominant);
  const direction = snapshotDirection || mtfDirection || (Number(livePrice?.change) < 0 ? "VENTE" : "ACHAT");
  const levels = buildAssistedLevels({
    direction,
    entry: Number.isFinite(price) ? price : NaN,
    sl: NaN,
    tp: NaN,
    tp2: NaN,
    live: price,
    pair,
    strategy,
    risk,
  });
  const technique = style === "Mixte" ? "Price Action" : style;
  const evidence = styleEvidenceLine(technique);
  const strategyLine = strategyGuide(strategy, timeframe);
  const rr = rewardRisk(direction, levels.entry, levels.sl, levels.tp);
  const profile = riskProfile(risk);
  const riskPlan = buildRiskPlan({ capital, profile });
  const technicalLine = technicalSnapshot?.text || "snapshot technique indisponible: lecture prudente par prix live.";
  const newsLine = newsContext?.enabled
    ? newsContext.activeRisk ? "news rouge proche: prudence maximale" : "pas de blocage macro détecté"
    : "news désactivées en mode rapide";
  const confidence = Math.max(52, Math.min(72,
    48
    + (technicalSnapshot?.valid ? 10 : 0)
    + (Number(technicalSnapshot?.confirmations || 0) * 2)
    + (Number.isFinite(Number(livePrice?.price)) ? 6 : 0)
    - (newsContext?.activeRisk ? 16 : 0),
  ));
  return `📸 LECTURE DES GRAPHIQUES :
Analyse sans screenshot — ou fallback API si la vision IA a dépassé le délai. Ne pas prétendre lire des éléments visuels non confirmés.

📡 DONNÉES LIVE :
- Prix live: ${formatLevel(price, pair)} | Source: ${livePrice?.source || "fallback"} | Fiabilité: ${livePrice?.reliability || "n/a"}
- Historique: ${technicalSnapshot.bars || 0} bougies | SMA10/SMA30: ${technicalSnapshot.sma10 ?? "n/a"} / ${technicalSnapshot.sma30 ?? "n/a"} | RSI: ${technicalSnapshot.rsi ?? "n/a"} | ATR: ${technicalSnapshot.atr ?? "n/a"}

📐 TECHNIQUE UTILISÉE : ${technique} + prix live/API, car l'IA n'a pas fourni un setup complet.
${evidence}
📊 ANALYSE :
- Tendance : ${direction === "ACHAT" ? "Haussière indicative" : "Baissière indicative"}
- Signal détecté : ${direction} prudent — ${strategyLine}
- Zone d'entrée : ${formatLevel(levels.entry, pair)}
- Stop Loss : ${formatLevel(levels.sl, pair)}
- Take Profit 1 : ${formatLevel(levels.tp, pair)}
- Take Profit 2 : ${formatLevel(levels.tp2, pair)}
- R/R ratio : 1:${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}
✅ CONFLUENCE : ${technicalLine} | MTF: ${mtf.summary} | News/API: ${newsLine}
⚠️ RISQUE : Ce n'est pas un conseil financier. ${riskPlan.instruction}
⚠️ NIVEAUX INDICATIFS UNIQUEMENT — Kronos n'a pas pu lire le graphique. Ne pas trader ces niveaux directement.
SCORE_CONFIANCE:${confidence}
TECHNIQUE_UTILISEE:${technique}
STYLE_EFFICACITE:${technique}=${confidence}`;
}

function styleEvidenceLine(style = "Price Action") {
  const normalized = normalizeForSearch(style);
  if (normalized.includes("ict")) return "Lecture ICT prudente: liquidité, OTE et kill zone à confirmer visuellement avant entrée.";
  if (normalized.includes("smc")) return "Lecture SMC prudente: order block, FVG, BOS/CHOCH et liquidité à confirmer visuellement avant entrée.";
  if (normalized.includes("wyckoff")) return "Lecture Wyckoff prudente: accumulation/distribution, spring/UTAD et effort/résultat à confirmer visuellement.";
  if (normalized.includes("elliott")) return "Lecture Elliott prudente: impulsion 1-5 ou correction ABC à confirmer visuellement avant entrée.";
  if (normalized.includes("ichimoku")) return "Lecture Ichimoku prudente: Kumo, Tenkan/Kijun et Chikou à confirmer visuellement.";
  return "Lecture Price Action prudente: tendance, support/résistance, cassure/retest et rejet à confirmer visuellement.";
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
  const rsi = closes.length >= 15 ? calculateRsi(closes.slice(-100)) : NaN;
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
  // Informational only, not a gating factor: scripts/backtest.mjs tested a volume
  // confirmation filter on the deterministic signal engine (soft AND hard variants)
  // and neither beat the shipped baseline on held-out data (hard: +0.051 train but
  // +0.000 test -- overfit). Kept here for the LLM cross-check (VSA/Wyckoff claims)
  // and future research, not to change buildDeterministicSignals()'s validated logic.
  const volumeSample = bars.slice(-21).map((bar) => Number(bar.volume));
  const volumeUsable = volumeSample.length >= 21 && volumeSample.every(Number.isFinite) && volumeSample.some((v) => v > 0);
  const volumeRatio = volumeUsable
    ? (() => {
      const current = volumeSample.at(-1);
      const priorAvg = average(volumeSample.slice(0, -1));
      return priorAvg > 0 ? Number((current / priorAvg).toFixed(2)) : null;
    })()
    : null;
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
    volumeRatio,
    confirmations,
    text: [
      `${closes.length} bougies ${meta.source || livePrice?.source || "API"}`,
      `tendance ${trend}`,
      `SMA10 ${formatLevel(sma10, pair)}${Number.isFinite(sma30) ? ` / SMA30 ${formatLevel(sma30, pair)}` : ""}`,
      Number.isFinite(rsi) ? `RSI ${Math.round(rsi)}` : "RSI indisponible",
      `ATR ${formatLevel(atr, pair)}`,
      Number.isFinite(support) && Number.isFinite(resistance) ? `support ${formatLevel(support, pair)}, résistance ${formatLevel(resistance, pair)}` : "zones S/R insuffisantes",
      Number.isFinite(volumeRatio) ? `volume ${volumeRatio}x la moyenne 20 bougies` : "volume indisponible pour cette source",
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

function scoreConfidenceBand(score, dataReliability, calibration) {
  let spread = 8;
  if (dataReliability?.grade === "C") spread = 14;
  if (dataReliability?.grade === "D") spread = 20;
  const weakCalibration = !calibration || ["aucune donnée", "échantillon trop petit", "indicatif"].includes(calibration.confidenceLabel);
  if (weakCalibration) spread += 5;
  const low = Math.max(0, Math.round(score - spread));
  const high = Math.min(100, Math.round(score + spread));
  return {
    low,
    high,
    note: `Score indicatif ${low}-${high}, pas un chiffre exact — fiabilité données ${dataReliability?.grade || "n/a"}, calibration ${calibration?.confidenceLabel || "aucune donnée"}.`,
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
  const apiOnlySetup = Boolean(context.apiOnlySetup);
  const quickMode = body.analysisDepth === "Rapide";
  const chartContext = context.chartContext || {};
  const live = Number(livePrice?.price);
  const mtfConsensus = analyzeMultiTimeframeConsensus(context.multiTimeframe || []);
  const dataReliability = assessAnalysisDataReliability({
    livePrice,
    technicalSnapshot: context.technicalSnapshot,
    multiTimeframe: context.multiTimeframe || [],
    hasChartImages,
  });
  const meta = {
    pair: body.pair || "EUR/USD",
    timeframe: body.timeframe || "H1",
    style: body.style || "Mixte",
    strategy: body.strategy || "Swing Trading",
    risk: body.risk || defaultRiskMode(),
    capital: body.capital || null,
    analysisDepth: body.analysisDepth || "Profonde",
    livePrice: Number.isFinite(live) ? live : null,
    imageQuality,
    calibration,
    chartContext,
    technicalSnapshot: context.technicalSnapshot || null,
    newsContext: context.newsContext || null,
    multiTimeframe: context.multiTimeframe || [],
    mtfConsensus,
    dataReliability,
    styleComparison: validation.styleComparison,
    // The three genuinely new narrative fields (everything else the raw answer says
    // is already available as clean structured data elsewhere in this payload) and a
    // display-safe version of the full text with emoji section headers and raw
    // machine tags (SCORE_CONFIANCE:, TECHNIQUE_UTILISEE:, STYLE_EFFICACITE:) removed
    // -- those were leaking straight into `explanation` before. `text` itself is left
    // untouched since extraction/regex logic below (direction, levels, RSI cross-
    // check, etc.) depends on the original markers.
    sections: extractNarrativeSections(text),
  };
  const displayText = stripMachineTags(text);
  if (!normalized.scoreParsed) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, 35),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: format de réponse IA non reconnu (SCORE_CONFIANCE manquant) — signal bloqué par prudence plutôt que d'inventer un score.`,
      validation: { ...validation, valid: false, reason: "Score de confiance non détecté dans la réponse IA." },
      meta,
    });
  }
  const explicitNoSignal = /\baucun signal\b|pas de signal|signal non valid|setup non valid/i.test(text);
  if (explicitNoSignal) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, validation.score, 45),
      technique: normalized.technique === "Mixte" ? "Aucun style validé" : normalized.technique || validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: signal bloqué volontairement, car l'analyse IA n'a pas confirmé un setup exploitable.`,
      validation: { ...validation, valid: false, reason: "Aucun signal confirmé par Kronos." },
      meta,
    });
  }
  if (hasChartImages && imageQuality.score < 20) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, imageQuality.score),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: qualité image insuffisante (${imageQuality.reason}).`,
      validation: { ...validation, valid: false, reason: `Qualité image insuffisante: ${imageQuality.reason}` },
      meta,
    });
  }
  if (!quickMode && !hasChartImages && !apiOnlySetup && meta.technicalSnapshot && meta.technicalSnapshot.valid === false) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, validation.score, 42),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: signal bloqué car aucun screenshot n'a été fourni et l'historique API n'est pas assez aligné avec la stratégie/timeframe demandé.`,
      validation: { ...validation, valid: false, reason: "Historique API insuffisant ou non aligné sans screenshot." },
      meta,
    });
  }
  const direction = extractTradeDirection(text);
  if (!direction) {
    return blockAnalysis(normalized, {
      score: Math.min(normalized.score, validation.score, 35),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: direction achat/vente non détectée dans la réponse IA — signal bloqué par prudence plutôt que de supposer un achat par défaut.`,
      validation: { ...validation, valid: false, reason: "Direction non détectée dans la réponse IA." },
      meta,
    });
  }
  let entry = extractLevel(text, /(?:zone d'entrée|entrée|entry)\s*:?\s*([0-9.,]+)/i, NaN);
  let sl = extractLevel(text, /(?:stop loss|sl)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp = extractLevel(text, /(?:take profit\s*1|tp1|take profit|tp)\s*:?\s*([0-9.,]+)/i, NaN);
  let tp2 = extractLevel(text, /(?:take profit\s*2|tp2)\s*:?\s*([0-9.,]+)/i, NaN);
  let assistedLevels = buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair: body.pair, strategy: body.strategy, risk: body.risk });
  if (assistedLevels.used) {
    entry = assistedLevels.entry;
    sl = assistedLevels.sl;
    tp = assistedLevels.tp;
    tp2 = assistedLevels.tp2;
  }
  let targetConstraint = constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy: body.strategy, risk: body.risk });
  if (targetConstraint.used) {
    tp = targetConstraint.tp;
    tp2 = targetConstraint.tp2;
  }
  if (![entry, sl, tp].every(Number.isFinite)) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, 35),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: niveaux entrée/SL/TP incomplets et aucun prix live disponible pour générer un plan prudent.`,
      validation: { ...validation, valid: false, reason: "Niveaux entrée/SL/TP incomplets." },
      meta,
    });
  }
  let levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair, strategy: body.strategy, risk: body.risk });
  if (!levelCheck.valid) {
    const repairedLevels = buildAssistedLevels({ direction, entry: NaN, sl: NaN, tp: NaN, tp2: NaN, live, pair: body.pair, strategy: body.strategy, risk: body.risk });
    if (repairedLevels.used) {
      entry = repairedLevels.entry;
      sl = repairedLevels.sl;
      tp = repairedLevels.tp;
      tp2 = repairedLevels.tp2;
      const repairedConstraint = constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy: body.strategy, risk: body.risk });
      if (repairedConstraint.used) {
        tp = repairedConstraint.tp;
        tp2 = repairedConstraint.tp2;
        targetConstraint = repairedConstraint;
      }
      assistedLevels = repairedLevels;
      levelCheck = validateTradeLevels({ direction, entry, sl, tp, live, pair: body.pair, strategy: body.strategy, risk: body.risk });
    }
  }
  if (!levelCheck.valid) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, levelCheck.score),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: ${levelCheck.reason}`,
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
      explanation: `${displayText}\n\nVALIDATION KRONOS: Trade risqué — ${suspicious.reason}. Les niveaux sont indicatifs uniquement et ne doivent pas être copiés directement.`,
      validation: { ...validation, valid: false, reason: `Trade risqué: ${suspicious.reason}` },
      meta: { ...meta, levelCheck, rr, suspiciousLevels: suspicious },
    });
  }
  const structuralCheck = crossCheckStructuralClaims(text, { technicalSnapshot: meta.technicalSnapshot, entry, pair: body.pair, hasChartImages });
  if (structuralCheck.checked && !structuralCheck.aligned) {
    validation.score = Math.max(0, validation.score - 15);
    validation.reason = `${validation.reason} ${structuralCheck.note}`;
  }
  meta.structuralCheck = structuralCheck;
  const visionConsensus = context.visionConsensus || { checked: false };
  if (visionConsensus.checked && !visionConsensus.agree) {
    // Both vision providers looked at the *same* image independently -- unlike the
    // structural cross-check above (which mostly re-checks the model against numbers
    // it was already handed in its own prompt, see crossCheckStructuralClaims), a
    // disagreement here means two separate models genuinely read the chart
    // differently. That's the strongest hallucination signal available without doing
    // real computer vision server-side.
    validation.score = Math.max(0, validation.score - 20);
    validation.reason = `${validation.reason} ${visionConsensus.note}`;
  }
  meta.visionConsensus = visionConsensus;
  const danger = computeDangerScore({ meta, validation, levelCheck, rr, live, entry, strategy: body.strategy, risk: body.risk });
  const qualityGate = buildQualityGate({ meta, validation, levelCheck, danger, hasChartImages, quickMode });
  if (!qualityGate.valid) {
    return blockAnalysis(normalized, {
      score: Math.min(validation.score, normalized.score, 58),
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: contrôle qualité non validé — ${qualityGate.reason}`,
      validation: { ...validation, valid: false, reason: qualityGate.reason },
      meta: { ...meta, levelCheck, rr, dangerScore: danger.score, danger, qualityGate },
    });
  }
  const profile = riskProfile(body.risk);
  const riskPlan = buildRiskPlan({ capital: body.capital, profile });
  const effectiveImageScore = hasChartImages ? imageQuality.score : apiOnlySetup ? 78 : 65;
  const calibratedScore = Math.max(0, Math.min(100, Math.round(
    normalized.score * 0.42 + validation.score * 0.18 + effectiveImageScore * 0.2 + levelCheck.score * 0.2 + calibration.adjustment,
  )));
  if (calibratedScore < 30) {
    return blockAnalysis(normalized, {
      score: calibratedScore,
      technique: validation.technique,
      explanation: `${displayText}\n\nVALIDATION KRONOS: score d'efficacité insuffisant (${calibratedScore}%).`,
      validation: { ...validation, valid: false, reason: "Score d'efficacité insuffisant." },
      meta: { ...meta, levelCheck, rr },
    });
  }
  const beginnerPlan = buildBeginnerPlan({ direction, entry, sl, tp1: tp, tp2, pair: body.pair, strategy: body.strategy, risk: body.risk, capital: body.capital });
  return {
    ...normalized,
    direction,
    entry: formatLevel(entry, body.pair),
    sl: formatLevel(sl, body.pair),
    tp1: formatLevel(tp, body.pair),
    tp2: formatLevel(Number.isFinite(tp2) ? tp2 : projectTp2(direction, entry, sl, tp), body.pair),
    rr: `1:${rr.toFixed(1)}`,
    score: calibratedScore,
    scoreRange: scoreConfidenceBand(calibratedScore, dataReliability, calibration),
    dangerScore: danger.score,
    beginnerPlan,
    explanation: `${displayText}\n\nVALIDATION KRONOS: ${validation.reason} Niveaux cohérents. R/R calculé 1:${rr.toFixed(1)}. Gestion du risque: ${profile.label}, perte maximale visée ${profile.percent}% si la taille de lot est correctement ajustée. ${calibration.message}`,
    validation,
    meta: {
      ...meta,
      levelCheck,
      rr,
      dangerScore: danger.score,
      danger,
      qualityGate,
      riskProfile: profile,
      riskPlan,
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

  const hasNewsRiskText = /news économique forte|news rouge proche|signal suspendu/.test(explanation)
    && !/aucune news rouge proche|pas de blocage macro/.test(explanation);
  if (meta.newsContext?.activeRisk || hasNewsRiskText) {
    return {
      status: "NEWS_ROUGE",
      statusLabel: "News rouge proche",
      userMessage: "Kronos bloque le trade car un événement macro fort peut fausser les niveaux et accélérer la volatilité.",
      nextActions: [
        "Attendre que la news soit publiée et que le spread se stabilise.",
        "Relancer l'analyse après 30 à 60 minutes.",
        "Ne pas entrer juste avant une annonce high impact.",
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

function defaultRiskMode() {
  return "Protection maximale 0.5%";
}

function riskProfile(value = "") {
  const text = normalizeForSearch(value || defaultRiskMode());
  if (/agressif|3/.test(text)) {
    return {
      label: "Agressif 3%",
      percent: 3,
      closeAtTp1: 50,
      breakeven: true,
      minScore: 82,
      warning: "Réservé aux comptes solides et aux setups très confirmés.",
    };
  }
  if (/standard|2/.test(text)) {
    return {
      label: "Standard 2%",
      percent: 2,
      closeAtTp1: 60,
      breakeven: true,
      minScore: 72,
      warning: "À utiliser seulement si l'utilisateur comprend la taille de lot.",
    };
  }
  if (/conservateur|1/.test(text)) {
    return {
      label: "Conservateur 1%",
      percent: 1,
      closeAtTp1: 70,
      breakeven: true,
      minScore: 62,
      warning: "Profil prudent pour limiter les pertes en série.",
    };
  }
  return {
    label: defaultRiskMode(),
    percent: 0.5,
    closeAtTp1: 80,
    breakeven: true,
    minScore: 55,
    warning: "Mode débutant: priorité à la survie du capital.",
  };
}

function riskAmountForCapital(capital, percent) {
  const amount = parseFormattedNumber(capital);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount * (Number(percent) / 100);
}

function buildRiskPlan({ capital, profile }) {
  const maxLoss = riskAmountForCapital(capital, profile.percent);
  return {
    label: profile.label,
    percent: profile.percent,
    closeAtTp1: profile.closeAtTp1,
    maxLoss: Number.isFinite(maxLoss) ? Number(maxLoss.toFixed(2)) : null,
    capital: Number.isFinite(parseFormattedNumber(capital)) ? parseFormattedNumber(capital) : null,
    warning: profile.warning,
    instruction: Number.isFinite(maxLoss)
      ? `Régler le lot pour perdre au maximum ${maxLoss.toFixed(2)} unité(s) si le SL est touché.`
      : `Régler le lot pour perdre au maximum ${profile.percent}% du capital si le SL est touché.`,
  };
}

function computeDangerScore({ meta = {}, validation = {}, levelCheck = {}, rr = null, live = null, entry = null, strategy = "", risk = "" }) {
  const reasons = [];
  let score = 12;
  const profile = riskProfile(risk || meta.risk);
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
  if (meta.mtfConsensus?.conflict) {
    score += 16;
    reasons.push("timeframes en conflit");
  }
  if (Number(meta.dataReliability?.score || 0) < 65) {
    score += 22;
    reasons.push("fiabilité données faible");
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
  if (profile.percent >= 3) {
    score += 10;
    reasons.push("profil agressif");
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    label: score >= 70 ? "Élevé" : score >= 40 ? "Moyen" : "Faible",
    reasons: reasons.length ? reasons : ["risque standard"],
  };
}

function assessAnalysisDataReliability({ livePrice = {}, technicalSnapshot = {}, multiTimeframe = [], hasChartImages = false }) {
  const blockers = [];
  let score = hasChartImages ? 76 : 62;
  if (Number.isFinite(Number(livePrice?.price))) score += 12;
  else blockers.push("prix live absent");
  if (isLivePriceSource(livePrice?.source) && !livePrice?.stale) score += 12;
  else blockers.push("prix non-live ou différé");
  if (technicalSnapshot?.valid) score += 16;
  else blockers.push("snapshot technique faible");
  if (Number(technicalSnapshot?.bars || 0) >= 50) score += 8;
  else blockers.push(`${Number(technicalSnapshot?.bars || 0)} bougies`);
  if (technicalSnapshot?.stale) {
    score -= 18;
    blockers.push("historique différé");
  }
  const usableMtf = multiTimeframe.filter((item) => item && item.trend && !/indisponible|n\/a/i.test(String(item.trend)));
  if (usableMtf.length >= 2) score += 8;
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 55 ? "C" : "D",
    blockers,
  };
}

function analyzeMultiTimeframeConsensus(items = []) {
  const usable = items.filter((item) => item && item.trend && !/indisponible|n\/a/i.test(String(item.trend)));
  const bullish = usable.filter((item) => /haussi/i.test(item.trend)).length;
  const bearish = usable.filter((item) => /baissi/i.test(item.trend)).length;
  const neutral = usable.length - bullish - bearish;
  const dominant = bullish > bearish && bullish >= neutral ? "haussière" : bearish > bullish && bearish >= neutral ? "baissière" : "mixte";
  const conflict = bullish > 0 && bearish > 0;
  const score = usable.length ? Math.round((Math.max(bullish, bearish, neutral) / usable.length) * 100) : 0;
  return {
    usable: usable.length,
    dominant,
    conflict,
    score,
    summary: usable.length ? `${dominant}, consensus ${score}% sur ${usable.length} timeframes` : "multi-timeframe indisponible",
  };
}

function buildQualityGate({ meta = {}, validation = {}, levelCheck = {}, danger = {}, hasChartImages = false, quickMode = false }) {
  const profile = riskProfile(meta.risk);
  const hasLivePrice = Number.isFinite(Number(meta.livePrice));
  const checks = [
    {
      name: "Prix live",
      ok: hasLivePrice,
      detail: hasLivePrice ? "prix disponible" : "prix indisponible",
    },
    {
      name: "Historique",
      ok: quickMode && hasLivePrice ? true : meta.technicalSnapshot?.valid !== false,
      detail: quickMode && hasLivePrice ? "mode rapide: prix live prioritaire" : meta.technicalSnapshot?.source || "source inconnue",
    },
    {
      name: "Fiabilité données",
      ok: Number(meta.dataReliability?.score || 0) >= 65,
      detail: `${Number(meta.dataReliability?.score || 0)}% · ${meta.dataReliability?.grade || "n/a"}`,
    },
    {
      name: "Multi-timeframe",
      ok: !meta.mtfConsensus?.conflict,
      detail: meta.mtfConsensus?.summary || "non requis",
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
      ok: quickMode && hasLivePrice ? Number(danger.score || 0) < 92 : Number(danger.score || 0) < 65,
      detail: quickMode && hasLivePrice ? `${Number(danger.score || 0)}% · tolérance rapide` : `${Number(danger.score || 0)}%`,
    },
    {
      name: "Risque compte",
      ok: profile.percent < 3 || (Number(validation.score || 0) >= profile.minScore && Number(danger.score || 0) < 45),
      detail: `${profile.label} · score requis ${profile.minScore}%`,
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

// Rough, broker-agnostic money illustration for a 0.01 lot (micro-lot) position:
// P&L = price distance x units-per-0.01-lot, using widely-cited conventions per
// instrument class. Real contract specs (lot size, tick value) vary by broker --
// this is a teaching example, not a precise quote, and says so.
function microLotUnits(pair = "") {
  const symbol = String(pair).toUpperCase();
  if (/XAU|XAG|XPT|XPD/.test(symbol)) return { units: 1, currency: "USD", note: "1 once pour 0.01 lot (convention courante)" };
  if (/BTC|ETH/.test(symbol)) return { units: 0.01, currency: "USD", note: "0.01 unité pour 0.01 lot (convention courante crypto CFD)" };
  if (/US500|NAS|SPX/.test(symbol)) return { units: 0.01, currency: "USD", note: "convention approximative: varie beaucoup selon le broker pour les indices" };
  if (/JPY/.test(symbol)) return { units: 1000, currency: "JPY", note: "1000 unités pour 0.01 lot" };
  return { units: 1000, currency: "USD", note: "1000 unités pour 0.01 lot" };
}

function microLotMoneyExample({ entry, sl, tp1, tp2, pair }) {
  if (![entry, sl, tp1, tp2].every(Number.isFinite)) return null;
  const { units, currency, note } = microLotUnits(pair);
  const round2 = (value) => Math.round(value * 100) / 100;
  return {
    lot: 0.01,
    currency,
    lossAtSl: round2(Math.abs(entry - sl) * units),
    gainAtTp1: round2(Math.abs(tp1 - entry) * units),
    gainAtTp2: round2(Math.abs(tp2 - entry) * units),
    note: `Estimation pour 0.01 lot (${note}). Valeur indicative: vérifie les spécifications de lot exactes de ton broker avant de trader en réel.`,
  };
}

function buildBeginnerPlan({ direction, entry, sl, tp1, tp2, pair, strategy, risk, capital }) {
  const profile = riskProfile(risk);
  const riskAmount = riskAmountForCapital(capital, profile.percent);
  const riskLine = riskAmount
    ? `Risque max: ${profile.percent}% du capital, soit environ ${riskAmount.toFixed(2)} unité(s) si le capital indiqué est correct.`
    : `Risque max: ${profile.percent}% du capital. Ajuster le lot pour que la perte au SL respecte cette limite.`;
  const money = microLotMoneyExample({ entry, sl, tp1, tp2, pair });
  const moneyLine = money
    ? `Astuce débutant (0.01 lot): perte ≈ ${money.lossAtSl} ${money.currency} si le SL est touché · gain ≈ ${money.gainAtTp1} ${money.currency} à TP1 · ≈ ${money.gainAtTp2} ${money.currency} à TP2. ${money.note}`
    : null;
  return {
    title: isScalpingStrategy(strategy) ? "Plan scalping débutant" : "Plan débutant",
    steps: [
      riskLine,
      ...(moneyLine ? [moneyLine] : []),
      `Entrée seulement si le prix confirme ${formatLevel(entry, pair)}.`,
      `Stop Loss à ${formatLevel(sl, pair)} sans l'élargir après entrée.`,
      `TP1 prudent à ${formatLevel(tp1, pair)}: fermer ${profile.closeAtTp1}% ou sécuriser une partie.`,
      `Après TP1, déplacer le SL vers breakeven si la plateforme le permet.`,
      `TP2 moyen à ${formatLevel(tp2, pair)}: laisser courir uniquement si le momentum reste propre.`,
      "Ne pas augmenter le lot après une perte: attendre un nouveau setup validé.",
    ],
    microLotExample: money,
    copy: [
      `ENTREE: ${formatLevel(entry, pair)}`,
      `SL: ${formatLevel(sl, pair)}`,
      `TP1 PRUDENT: ${formatLevel(tp1, pair)}`,
      `TP2 MOYEN: ${formatLevel(tp2, pair)}`,
      `RISQUE MAX: ${profile.percent}% du capital`,
      `GESTION: Fermer ${profile.closeAtTp1}% à TP1 puis protéger le reste.`,
      ...(money ? [`EXEMPLE 0.01 LOT: perte ~${money.lossAtSl} ${money.currency} au SL, gain ~${money.gainAtTp1} ${money.currency} au TP1`] : []),
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

// Pulls the narrative fields out of the raw KRONOS answer: "Structure visible" (the
// one field never handed to the model, only requested -- see crossCheckStructuralClaims
// for why that makes it useful for hallucination detection), "Confluence", and
// "Risque". Everything else in the raw text (price/tendance/entry/sl/tp/rr) is already
// available as clean structured fields elsewhere in the API response, so the frontend
// no longer needs to parse or display the whole blob -- these three are the only
// genuinely new narrative content in it.
// Confirmed live: real model answers don't reliably put a literal newline between
// section markers -- one real Gemini Vision answer ran the whole thing as one flowing
// paragraph. A newline-anchored match against that text finds nothing and produces a
// false "empty field" positive even when the content is present and detailed.
// Anchoring on the NEXT known section marker instead of a newline works regardless of
// how the model formats whitespace.
const NARRATIVE_SECTION_BOUNDARY = "📸|📡|📐|📊|✅|⚠️|SCORE_CONFIANCE|TECHNIQUE_UTILISEE|STYLE_EFFICACITE|$";
function extractNarrativeField(text, label) {
  const match = String(text).match(new RegExp(`${label}\\s*:?\\s*([\\s\\S]*?)(?=${NARRATIVE_SECTION_BOUNDARY})`, "i"));
  return match ? match[1].trim() : "";
}
function extractNarrativeSections(text) {
  return {
    visualReading: extractNarrativeField(text, "structure visible"),
    confluence: extractNarrativeField(text, "✅ CONFLUENCE"),
    risk: extractNarrativeField(text, "⚠️ RISQUE"),
  };
}

// Strips the emoji section headers and raw machine tags (SCORE_CONFIANCE:,
// TECHNIQUE_UTILISEE:, STYLE_EFFICACITE:) that KRONOS_OUTPUT_POLICY requires the model
// to emit for parsing (score/technique extraction, style grading) but that were never
// meant to be shown to the end user verbatim -- they were leaking straight into
// `explanation` because nothing ever cleaned them out before display.
function stripMachineTags(text) {
  return String(text)
    .replace(/📸\s*LECTURE DES GRAPHIQUES\s*:?/gi, "")
    .replace(/📡\s*DONNÉES LIVE\s*:?/gi, "")
    .replace(/📐\s*TECHNIQUE UTILISÉE\s*:?/gi, "")
    .replace(/📊\s*ANALYSE\s*:?/gi, "")
    .replace(/✅\s*CONFLUENCE\s*:?/gi, "")
    .replace(/⚠️\s*RISQUE\s*:?/gi, "")
    .replace(/SCORE_CONFIANCE\s*:\s*\d+/gi, "")
    .replace(/TECHNIQUE_UTILISEE\s*:\s*[^\n]*/gi, "")
    .replace(/STYLE_EFFICACITE\s*:\s*[^=\n]*=\s*\d+/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

const WEAK_VISUAL_READING_RE = /^(non pr[ée]cis[ée]?|n\/?a|aucune?( structure)?( notable)?|rien( de notable)?|ras|—|-|non visible|indisponible|inconnue?)\.?$/i;

function crossCheckStructuralClaims(text, { technicalSnapshot, entry, pair, hasChartImages = false }) {
  const issues = [];
  let checked = false;

  // The numbers checked below (support/résistance/RSI/tendance) are handed to the
  // model directly in its own prompt (technicalSnapshot.text) -- so a model that
  // simply parrots them back always "passes" this part, whether or not it actually
  // looked at the image. This check doesn't have that blind spot: "Structure
  // visible" is never given to the model, only requested, so a missing/generic
  // answer here is real evidence the image wasn't genuinely read.
  if (hasChartImages) {
    checked = true;
    const visual = extractNarrativeSections(text);
    if (!visual.visualReading || visual.visualReading.length < 15 || WEAK_VISUAL_READING_RE.test(visual.visualReading)) {
      issues.push('un graphe a été fourni mais le champ "Structure visible" est vide ou générique -- rien n\'indique que l\'image a réellement été lue');
    }
  }

  if (!technicalSnapshot?.valid) return { checked, aligned: issues.length === 0, note: issues.length ? `Incohérence(s) détectée(s): ${issues.join("; ")}.` : undefined };

  const mentionsZone = /\bsupport\b|r[ée]sistance|order block|\bfvg\b|zone de (?:demande|offre)/i.test(text);
  const support = Number(technicalSnapshot.support);
  const resistance = Number(technicalSnapshot.resistance);
  if (mentionsZone && Number.isFinite(support) && Number.isFinite(resistance) && Number.isFinite(entry) && resistance > support) {
    checked = true;
    const tolerance = (resistance - support) * 0.35;
    const withinRange = entry >= support - tolerance && entry <= resistance + tolerance;
    if (!withinRange) {
      issues.push(`zone citée éloignée du support ${formatLevel(support, pair)} / résistance ${formatLevel(resistance, pair)} calculés côté serveur`);
    }
  }

  const rsiMatch = String(text).match(/RSI\D{0,6}(\d{1,3})/i);
  const serverRsi = Number(technicalSnapshot.rsi);
  if (rsiMatch && Number.isFinite(serverRsi)) {
    checked = true;
    const citedRsi = Number(rsiMatch[1]);
    if (Number.isFinite(citedRsi) && Math.abs(citedRsi - serverRsi) > 15) {
      issues.push(`RSI cité (${citedRsi}) éloigné du RSI calculé côté serveur (${serverRsi})`);
    }
  }

  const trendMatch = String(text).match(/Tendance\s*:?\s*(haussi[eè]re|baissi[eè]re|neutre)/i);
  if (trendMatch && (technicalSnapshot.trend === "haussière" || technicalSnapshot.trend === "baissière")) {
    checked = true;
    const cited = /haussi/i.test(trendMatch[1]) ? "haussière" : /baissi/i.test(trendMatch[1]) ? "baissière" : "neutre";
    if (cited !== "neutre" && cited !== technicalSnapshot.trend) {
      issues.push(`tendance annoncée (${cited}) opposée à la tendance calculée côté serveur (${technicalSnapshot.trend})`);
    }
  }

  // Volume is not a gating factor for the deterministic engine (tested and rejected
  // in scripts/backtest.mjs), but a VSA/Wyckoff claim ("effort vs résultat") citing
  // volume the server can actually measure is worth catching if it contradicts data.
  const highVolumeClaim = /volume\s+(?:fort|élevé|important|en hausse|anormal)|spike de volume|forte activité/i.test(text);
  const lowVolumeClaim = /volume\s+(?:faible|bas|en baisse|réduit)|no supply|no demand|absence de volume/i.test(text);
  const volumeRatio = Number(technicalSnapshot.volumeRatio);
  if ((highVolumeClaim || lowVolumeClaim) && Number.isFinite(volumeRatio)) {
    checked = true;
    if (highVolumeClaim && volumeRatio < 1.15) {
      issues.push(`volume "fort" annoncé mais volume mesuré ${volumeRatio}x la moyenne 20 bougies (pas de confirmation)`);
    }
    if (lowVolumeClaim && volumeRatio > 0.85) {
      issues.push(`volume "faible" annoncé mais volume mesuré ${volumeRatio}x la moyenne 20 bougies (pas de confirmation)`);
    }
  }

  if (!checked) return { checked: false };
  return {
    checked: true,
    aligned: issues.length === 0,
    note: issues.length
      ? `Incohérence(s) détectée(s) avec les données serveur: ${issues.join("; ")}.`
      : "Claims IA cohérents avec les données techniques calculées côté serveur.",
  };
}

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
  const details = [];
  let totalScore = 0;
  for (const image of images) {
    const bytes = Math.round((image.data.length * 3) / 4);
    let dimensions = null;
    try {
      dimensions = imageSize(Buffer.from(image.data, "base64"));
    } catch {
      dimensions = null;
    }
    if (dimensions?.width && dimensions?.height) {
      const minSide = Math.min(dimensions.width, dimensions.height);
      let imgScore = 40;
      if (minSide >= 500) imgScore += 20;
      if (minSide >= 800) imgScore += 15;
      if (minSide >= 1200) imgScore += 10;
      if (minSide < 300) imgScore -= 30;
      totalScore += Math.max(0, Math.min(100, imgScore));
      details.push(`${dimensions.width}x${dimensions.height}`);
    } else {
      let imgScore = 45;
      if (bytes > 120000) imgScore += 15;
      if (bytes > 300000) imgScore += 10;
      if (bytes < 45000) imgScore -= 22;
      totalScore += Math.max(0, Math.min(100, imgScore));
      details.push(`${Math.round(bytes / 1024)}KB (résolution non détectée)`);
    }
  }
  let score = Math.round(totalScore / images.length);
  if (images.length >= 2) score = Math.min(100, score + 8);
  score = Math.max(0, Math.min(100, score));
  const reason = `${images.length} image(s): ${details.join(", ")}`;
  return { score, reason, images: images.length };
}

function validateTradeLevels({ direction, entry, sl, tp, live, pair, strategy, risk }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { valid: false, score: 0, reason: "Niveaux numériques invalides." };
  const buy = direction === "ACHAT";
  if (buy && !(sl < entry && tp > entry)) return { valid: false, score: 20, reason: "Pour un achat, SL doit être sous l'entrée et TP au-dessus." };
  if (!buy && !(sl > entry && tp < entry)) return { valid: false, score: 20, reason: "Pour une vente, SL doit être au-dessus de l'entrée et TP sous l'entrée." };
  const rr = rewardRisk(direction, entry, sl, tp);
  const profile = riskProfile(risk);
  const minRr = isScalpingStrategy(strategy) ? 0.75 : profile.percent <= 0.5 ? 1.0 : 1.2;
  if (!Number.isFinite(rr) || rr < minRr) return { valid: false, score: 35, reason: `R/R trop faible (${Number.isFinite(rr) ? rr.toFixed(1) : "n/a"}).` };
  const riskDistance = Math.abs(entry - sl);
  const executionBuffer = executionCostBuffer(pair, strategy);
  if (riskDistance < executionBuffer * 3) {
    return {
      valid: false,
      score: 30,
      reason: `SL trop serré après spread/slippage estimé (${formatLevel(riskDistance, pair)} < ${formatLevel(executionBuffer * 3, pair)}).`,
    };
  }
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

function buildAssistedLevels({ direction, entry, sl, tp, tp2, live, pair, strategy, risk }) {
  if ([entry, sl, tp].every(Number.isFinite)) {
    return { used: false, entry, sl, tp, tp2 };
  }
  if (!Number.isFinite(live) || live <= 0) {
    return { used: false, entry, sl, tp, tp2 };
  }
  const buy = direction !== "VENTE";
  const riskDistance = assistedRiskDistance(live, pair, strategy);
  const targets = targetMultipliers(strategy, risk);
  const finalEntry = Number.isFinite(entry) ? entry : live;
  const finalSl = Number.isFinite(sl) ? sl : buy ? finalEntry - riskDistance : finalEntry + riskDistance;
  const finalTp = Number.isFinite(tp) ? tp : buy ? finalEntry + riskDistance * targets.tp1 : finalEntry - riskDistance * targets.tp1;
  const finalTp2 = Number.isFinite(tp2) ? tp2 : buy ? finalEntry + riskDistance * targets.tp2 : finalEntry - riskDistance * targets.tp2;
  return {
    used: true,
    entry: finalEntry,
    sl: finalSl,
    tp: finalTp,
    tp2: finalTp2,
    reason: "Niveaux assistés générés depuis le prix live car l'IA n'a pas fourni tous les chiffres.",
  };
}

function constrainTargetsToStrategy({ direction, entry, sl, tp, tp2, strategy, risk }) {
  if (![entry, sl, tp].every(Number.isFinite)) return { used: false, tp, tp2 };
  const targets = targetMultipliers(strategy, risk);
  const riskDistance = Math.abs(entry - sl);
  if (!riskDistance) return { used: false, tp, tp2 };
  const buy = direction !== "VENTE";
  const rr1 = Math.abs(tp - entry) / riskDistance;
  const rr2 = Number.isFinite(tp2) ? Math.abs(tp2 - entry) / riskDistance : NaN;
  const clampRr = (value, min, max, fallback) => Math.max(min, Math.min(max, Number.isFinite(value) ? value : fallback));
  const safeRr1 = clampRr(rr1, targets.minTp1, targets.maxTp1, targets.tp1);
  const safeRr2 = clampRr(rr2, targets.minTp2, targets.maxTp2, targets.tp2);
  const finalTp = buy ? entry + riskDistance * safeRr1 : entry - riskDistance * safeRr1;
  const finalTp2 = buy ? entry + riskDistance * Math.max(safeRr2, safeRr1 + 0.25) : entry - riskDistance * Math.max(safeRr2, safeRr1 + 0.25);
  const changed = Math.abs(finalTp - tp) > riskDistance * 0.05 || !Number.isFinite(tp2) || Math.abs(finalTp2 - tp2) > riskDistance * 0.05;
  return {
    used: changed,
    tp: changed ? finalTp : tp,
    tp2: changed ? finalTp2 : tp2,
    reason: isScalpingStrategy(strategy)
      ? `Objectifs scalping resserrés: TP1 ${safeRr1.toFixed(1)}R prudent, TP2 ${Math.max(safeRr2, safeRr1 + 0.25).toFixed(1)}R moyen.`
      : `Objectifs ajustés selon la stratégie: TP1 ${safeRr1.toFixed(1)}R, TP2 ${Math.max(safeRr2, safeRr1 + 0.25).toFixed(1)}R.`,
  };
}

function targetMultipliers(strategy = "", risk = "") {
  const profile = riskProfile(risk);
  if (profile.percent <= 0.5) {
    if (isScalpingStrategy(strategy)) return { tp1: 0.85, tp2: 1.35, minTp1: 0.75, maxTp1: 1.05, minTp2: 1.2, maxTp2: 1.65 };
    return { tp1: 1.05, tp2: 1.65, minTp1: 0.9, maxTp1: 1.35, minTp2: 1.4, maxTp2: 2.2 };
  }
  if (profile.percent <= 1) {
    if (isScalpingStrategy(strategy)) return { tp1: 0.9, tp2: 1.5, minTp1: 0.75, maxTp1: 1.15, minTp2: 1.25, maxTp2: 1.85 };
    return { tp1: 1.2, tp2: 1.9, minTp1: 1.0, maxTp1: 1.6, minTp2: 1.55, maxTp2: 2.6 };
  }
  if (isScalpingStrategy(strategy)) {
    return { tp1: 0.95, tp2: 1.65, minTp1: 0.75, maxTp1: 1.2, minTp2: 1.35, maxTp2: 2.0 };
  }
  if (/breakout/i.test(String(strategy))) return { tp1: 1.2, tp2: 2.2, minTp1: 1.0, maxTp1: 1.8, minTp2: 1.7, maxTp2: 3.2 };
  if (/position/i.test(String(strategy))) return { tp1: 1.8, tp2: 3.2, minTp1: 1.2, maxTp1: 2.4, minTp2: 2.2, maxTp2: 4.5 };
  return { tp1: 1.35, tp2: 2.2, minTp1: 1.0, maxTp1: 1.8, minTp2: 1.7, maxTp2: 3.2 };
}

function assistedRiskDistance(price, pair = "", strategy = "") {
  const scalp = isScalpingStrategy(strategy);
  const buffer = executionCostBuffer(pair, strategy) * 3;
  if (/BTC/i.test(pair)) return scalp ? Math.max(price * 0.0022, 80, buffer) : Math.max(price * 0.006, 250, buffer);
  if (/ETH/i.test(pair)) return scalp ? Math.max(price * 0.003, 4, buffer) : Math.max(price * 0.008, 12, buffer);
  if (/XAU/i.test(pair)) return scalp ? Math.max(price * 0.00045, 1.2, buffer) : Math.max(price * 0.0025, 8, buffer);
  if (/XAG/i.test(pair)) return scalp ? Math.max(price * 0.0025, 0.06, buffer) : Math.max(price * 0.006, 0.18, buffer);
  if (/US500|NAS|SPX/i.test(pair)) return scalp ? Math.max(price * 0.0012, 6, buffer) : Math.max(price * 0.0035, 18, buffer);
  if (/JPY/i.test(pair)) return scalp ? Math.max(price * 0.00028, 0.03, buffer) : Math.max(price * 0.0025, 0.25, buffer);
  return scalp ? Math.max(price * 0.00025, 0.00025, buffer) : Math.max(price * 0.0018, 0.0018, buffer);
}

function executionCostBuffer(pair = "", strategy = "") {
  const scalp = isScalpingStrategy(strategy);
  if (/BTC/i.test(pair)) return scalp ? 35 : 60;
  if (/ETH/i.test(pair)) return scalp ? 1.8 : 3.5;
  if (/XAU/i.test(pair)) return scalp ? 0.35 : 0.8;
  if (/XAG/i.test(pair)) return scalp ? 0.015 : 0.035;
  if (/US500|SPX/i.test(pair)) return scalp ? 1.8 : 3.5;
  if (/NAS/i.test(pair)) return scalp ? 4 : 8;
  if (/JPY/i.test(pair)) return scalp ? 0.012 : 0.025;
  return scalp ? 0.00008 : 0.00016;
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

// Every store here (auth, learning-log) follows a load-whole-document -> mutate in
// JS -> overwrite-whole-document pattern, with no DB-level locking (confirmed: even
// the Postgres path is a plain INSERT ... ON CONFLICT DO UPDATE with no optimistic
// lock). Two concurrent requests hitting the same store used to both load the same
// snapshot and the second save silently discarded the first's change -- reproduced
// live with two concurrent signups where one account vanished after both returned
// 200 OK. This serializes every load+modify+save sequence for the same logical
// store so they can never interleave, regardless of how many requests arrive at once.
const fileLocks = new Map();
function withFileLock(key, fn) {
  const tail = fileLocks.get(key) || Promise.resolve();
  const run = tail.then(fn, fn);
  fileLocks.set(key, run.then(() => {}, () => {}));
  return run;
}

// Write to a temp file then rename over the target: a crash mid-write can no longer
// leave a truncated/corrupt JSON file that loadX() would silently treat as "no data"
// on next boot (rename is atomic on the same filesystem/directory).
async function atomicWriteFile(filePath, content) {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

async function loadMarketCache() {
  const fromState = await loadStateDocument("market-cache");
  if (fromState) {
    return {
      version: 1,
      prices: fromState.prices && typeof fromState.prices === "object" ? fromState.prices : {},
      histories: fromState.histories && typeof fromState.histories === "object" ? fromState.histories : {},
      updatedAt: fromState.updatedAt || null,
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
  await atomicWriteFile(marketCachePath, `${JSON.stringify(trimmed, null, 2)}\n`);
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

function runtimeCacheSummary() {
  const item = (cache) => ({
    active: Boolean(cache.value && Date.now() < cache.expiresAt),
    ttlSeconds: cache.value ? Math.max(0, Math.round((cache.expiresAt - Date.now()) / 1000)) : 0,
  });
  return {
    prices: item(memoryCache.prices),
    histories: item(memoryCache.histories),
    signals: item(memoryCache.signals),
    performance: item(memoryCache.performance),
    calendar: item(memoryCache.calendar),
  };
}

// Throttled, single-line, consistently formatted logging for things that can repeat
// on every request (a provider being down, a scheduler tick failing) -- without this,
// a single missing/expired API key spams the console with the same warning on every
// single analysis request.
const recentLogs = new Map();
function logOnce(scope, message, throttleMs = 5 * 60 * 1000) {
  const key = `${scope}:${message}`;
  const now = Date.now();
  const last = recentLogs.get(key);
  if (last && now - last < throttleMs) return;
  recentLogs.set(key, now);
  console.warn(`[${new Date(now).toISOString().slice(11, 19)}] ${scope}: ${message}`);
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
    yahoo: { status: "unlimited", noKey: true },
    exhaustedKeys: exhaustedKeys.size,
    blacklistTtlMinutes: 60,
  };
}

async function loadStateDocument(id) {
  if (!pgPool) return null;
  try {
    await ensureStateTable();
    const { rows } = await pgPool.query(
      `SELECT payload FROM ${supabaseStateTable} WHERE id = $1 LIMIT 1`,
      [id],
    );
    supabaseLastError = null;
    recordProviderHealth("database", true);
    return rows[0]?.payload || null;
  } catch (error) {
    supabaseLastError = sanitizeError(error.message);
    recordProviderHealth("database", false, supabaseLastError);
    return null;
  }
}

async function saveStateDocument(id, payload) {
  if (!pgPool) return false;
  try {
    await ensureStateTable();
    await pgPool.query(
      `INSERT INTO ${supabaseStateTable} (id, payload, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
      [id, JSON.stringify(payload)],
    );
    supabaseLastError = null;
    recordProviderHealth("database", true);
    return true;
  } catch (error) {
    supabaseLastError = sanitizeError(error.message);
    recordProviderHealth("database", false, supabaseLastError);
    return false;
  }
}

function hasSupabaseConfig() {
  return Boolean(pgPool);
}

function authPersistenceRequired() {
  return hasSupabaseConfig() && env.AUTH_ALLOW_FILE_FALLBACK !== "true";
}

async function checkSupabaseConnection() {
  if (!pgPool) return false;
  try {
    await ensureStateTable();
    await pgPool.query("SELECT 1");
    supabaseUnavailable = false;
    supabaseLastError = null;
    recordProviderHealth("database", true);
    return true;
  } catch (error) {
    supabaseUnavailable = true;
    supabaseLastError = sanitizeError(error.message);
    recordProviderHealth("database", false, supabaseLastError);
    return false;
  }
}

function healthRecommendations() {
  const tips = [];
  const providers = providerHealthSnapshot();
  if (!supabaseUrl) tips.push("Ajouter SUPABASE_URL dans secret.dev pour connecter le stockage Supabase.");
  if (!supabaseKey) tips.push("Ajouter SUPABASE_SERVICE_ROLE_KEY dans secret.dev pour autoriser la persistance serveur Supabase.");
  if (supabaseLastError) tips.push(`Supabase indisponible: ${supabaseLastError}. Le serveur utilise le fallback fichier local.`);
  for (const [name, health] of Object.entries(providers)) {
    if (["down", "degraded"].includes(health.status) && name !== "supabase") {
      tips.push(`${name} ${health.status}: ${health.lastError || "erreur inconnue"}. Kronos bascule sur les sources alternatives et bloque les signaux trop faibles.`);
    }
  }
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
  if (!hasSupabaseConfig()) {
    return { configured: false, connected: false, storage: "sqlite", dbName: null, lastError: null };
  }
  const connected = await checkSupabaseConnection();
  return {
    configured: true,
    connected,
    storage: connected ? "supabase" : "file_fallback",
    dbName: supabaseProjectRef,
    table: supabaseStateTable,
    lastError: supabaseLastError,
  };
}

function safeJsonParse(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    plan: row.plan || "free",
    role: row.role || "user",
    premiumUntil: row.premium_until || null,
    manualPremium: Boolean(Number(row.manual_premium)),
    premiumSource: row.premium_source || null,
    preferences: safeJsonParse(row.preferences, {}),
    usage: safeJsonParse(row.usage, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at || null,
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

async function upsertUserRow(user) {
  await sqlRun(
    `INSERT INTO users (id, name, email, password_hash, plan, role, premium_until, manual_premium, premium_source, preferences, usage, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name, email = excluded.email, password_hash = excluded.password_hash,
       plan = excluded.plan, role = excluded.role, premium_until = excluded.premium_until,
       manual_premium = excluded.manual_premium, premium_source = excluded.premium_source,
       preferences = excluded.preferences, usage = excluded.usage,
       updated_at = excluded.updated_at, last_login_at = excluded.last_login_at`,
    [
      user.id,
      user.name,
      user.email,
      user.passwordHash,
      user.plan || "free",
      user.role || "user",
      user.premiumUntil || null,
      user.manualPremium ? 1 : 0,
      user.premiumSource || null,
      JSON.stringify(user.preferences || {}),
      JSON.stringify(user.usage || {}),
      user.createdAt || new Date().toISOString(),
      user.updatedAt || new Date().toISOString(),
      user.lastLoginAt || null,
    ],
  );
}

async function upsertSessionRow(session) {
  await sqlRun(
    `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id, token_hash = excluded.token_hash,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
    [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt],
  );
}

// One-time import: if the relational tables are still empty, pull whatever the old
// whole-document store had (Postgres JSONB blob, or the local JSON file) so real
// existing accounts/sessions/analyses aren't lost when this migration ships. Safe to
// call on every startup -- it's a no-op once the tables have rows, checked via a
// real COUNT rather than a one-off flag file, so it self-heals if a first attempt
// only partially imported (e.g. process killed mid-way).
async function loadLegacyAuthBlob() {
  const fromState = await loadStateDocument("auth-store");
  if (fromState) {
    return {
      users: Array.isArray(fromState.users) ? fromState.users : [],
      sessions: Array.isArray(fromState.sessions) ? fromState.sessions : [],
    };
  }
  try {
    const raw = await readFile(authPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      users: Array.isArray(parsed.users) ? parsed.users : [],
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return null;
  }
}

async function loadLegacyLearningBlob() {
  const fromState = await loadStateDocument("learning-log");
  if (fromState) {
    return {
      analyses: Array.isArray(fromState.analyses) ? fromState.analyses : [],
      outcomes: Array.isArray(fromState.outcomes) ? fromState.outcomes : [],
    };
  }
  try {
    const raw = await readFile(learningPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      analyses: Array.isArray(parsed.analyses) ? parsed.analyses : [],
      outcomes: Array.isArray(parsed.outcomes) ? parsed.outcomes : [],
    };
  } catch {
    return null;
  }
}

async function migrateLegacyJsonIntoRelationalTables() {
  const userCount = Number((await sqlGet(`SELECT COUNT(*) AS c FROM users`))?.c ?? 0);
  if (userCount === 0) {
    const legacy = await loadLegacyAuthBlob();
    if (legacy && (legacy.users.length || legacy.sessions.length)) {
      for (const user of legacy.users) await upsertUserRow(user);
      const activeSessions = legacy.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
      for (const session of activeSessions) await upsertSessionRow(session);
      logOnce("migration-auth", `Import initial vers le stockage relationnel: ${legacy.users.length} compte(s), ${activeSessions.length} session(s) active(s) depuis l'ancien stockage document.`);
    }
  }
  const analysisCount = Number((await sqlGet(`SELECT COUNT(*) AS c FROM analyses`))?.c ?? 0);
  if (analysisCount === 0) {
    const legacy = await loadLegacyLearningBlob();
    if (legacy && legacy.analyses.length) {
      // rMultiple was only ever attached to the separate `outcomes` entry in the old
      // document model, never to the analysis record itself -- confirmed live (8/14
      // real outcomes had it) that skipping this merge would silently drop it during
      // import even though the analysis row otherwise carries everything else needed
      // to reconstruct that outcome.
      const rMultipleById = new Map((legacy.outcomes || []).filter((o) => Number.isFinite(o.rMultiple)).map((o) => [o.id, o.rMultiple]));
      for (const analysis of legacy.analyses) {
        const rMultiple = rMultipleById.has(analysis.id) ? rMultipleById.get(analysis.id) : (analysis.rMultiple ?? null);
        await upsertAnalysisRow({ ...analysis, rMultiple });
      }
      logOnce("migration-learning", `Import initial vers le stockage relationnel: ${legacy.analyses.length} analyse(s) depuis l'ancien stockage document.`);
    }
  }
}

async function loadAuthStore() {
  await ensureRelationalTables();
  const [userRows, sessionRows] = await Promise.all([
    sqlAll(`SELECT * FROM users`),
    sqlAll(`SELECT * FROM sessions WHERE expires_at > ?`, [new Date().toISOString()]),
  ]);
  return {
    version: 1,
    users: userRows.map(rowToUser),
    sessions: sessionRows.map(rowToSession),
    updatedAt: null,
  };
}

async function saveAuthStore(store) {
  await ensureRelationalTables();
  const activeSessions = store.sessions.filter((session) => new Date(session.expiresAt).getTime() > Date.now());
  for (const user of store.users) await upsertUserRow(user);
  const keepIds = activeSessions.map((session) => session.id);
  if (keepIds.length) {
    const placeholders = keepIds.map(() => "?").join(",");
    await sqlRun(`DELETE FROM sessions WHERE id NOT IN (${placeholders})`, keepIds);
  } else {
    await sqlRun(`DELETE FROM sessions`);
  }
  for (const session of activeSessions) await upsertSessionRow(session);
  return { version: 1, users: store.users, sessions: activeSessions, updatedAt: new Date().toISOString(), persisted: pgPool ? "supabase" : "sqlite" };
}

async function signupUser(body = {}) {
  const name = cleanLine(body.name || body.fullName || "");
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  if (name.length < 2) return { ok: false, error: "Nom trop court." };
  if (!isValidEmail(email)) return { ok: false, error: "Email invalide." };
  if (password.length < 8) return { ok: false, error: "Mot de passe trop court: 8 caractères minimum." };
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    const existing = store.users.find((user) => user.email === email);
    if (existing) {
      if (!verifyPassword(password, existing.passwordHash)) {
        return { ok: false, error: "Ce compte existe déjà. Connecte-toi avec le bon mot de passe." };
      }
      const session = createSession(existing.id);
      store.sessions = store.sessions.filter((item) => item.userId !== existing.id || new Date(item.expiresAt).getTime() > Date.now());
      store.sessions.push(session);
      existing.lastLoginAt = new Date().toISOString();
      existing.updatedAt = new Date().toISOString();
      const saved = await saveAuthStore(store);
      if (authPersistenceRequired() && saved.persisted !== "supabase") {
        return { ok: false, error: "Persistance Supabase indisponible. Réessaie dans quelques secondes." };
      }
      return { ok: true, user: existing, session, reused: true };
    }
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
    const saved = await saveAuthStore(store);
    if (authPersistenceRequired() && saved.persisted !== "supabase") {
      return { ok: false, error: "Persistance Supabase indisponible. Réessaie dans quelques secondes." };
    }
    return { ok: true, user, session };
  });
}

function loginRateLimitKey(req, email) {
  return `${clientFingerprint(req)}:${normalizeEmail(email)}`;
}

function checkLoginRateLimit(req, email) {
  const key = loginRateLimitKey(req, email);
  const entry = loginAttempts.get(key);
  if (!entry) return { ok: true };
  if (Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { ok: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.firstAttemptAt + LOGIN_WINDOW_MS - Date.now()) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  return { ok: true };
}

function registerLoginFailure(req, email) {
  const key = loginRateLimitKey(req, email);
  const entry = loginAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: Date.now() });
    return;
  }
  entry.count += 1;
}

function clearLoginAttempts(req, email) {
  loginAttempts.delete(loginRateLimitKey(req, email));
}

function checkSignupRateLimit(req) {
  const key = clientFingerprint(req);
  const entry = signupAttempts.get(key);
  if (!entry) return { ok: true };
  if (Date.now() - entry.firstAttemptAt > SIGNUP_WINDOW_MS) {
    signupAttempts.delete(key);
    return { ok: true };
  }
  if (entry.count >= SIGNUP_MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.firstAttemptAt + SIGNUP_WINDOW_MS - Date.now()) / 1000));
    return { ok: false, retryAfterSeconds };
  }
  return { ok: true };
}

function registerSignupAttempt(req) {
  const key = clientFingerprint(req);
  const entry = signupAttempts.get(key);
  if (!entry || Date.now() - entry.firstAttemptAt > SIGNUP_WINDOW_MS) {
    signupAttempts.set(key, { count: 1, firstAttemptAt: Date.now() });
    return;
  }
  entry.count += 1;
}

async function loginUser(body = {}, req = null) {
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const rateLimit = req ? checkLoginRateLimit(req, email) : { ok: true };
  if (!rateLimit.ok) {
    return {
      ok: false,
      error: "too_many_attempts",
      message: `Trop de tentatives. Réessaie dans ${Math.ceil(rateLimit.retryAfterSeconds / 60)} min.`,
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    };
  }
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    const user = store.users.find((item) => item.email === email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      if (req) registerLoginFailure(req, email);
      return { ok: false, error: "Email ou mot de passe incorrect." };
    }
    if (req) clearLoginAttempts(req, email);
    const session = createSession(user.id);
    store.sessions = store.sessions.filter((item) => item.userId !== user.id || new Date(item.expiresAt).getTime() > Date.now());
    store.sessions.push(session);
    user.lastLoginAt = new Date().toISOString();
    const saved = await saveAuthStore(store);
    if (authPersistenceRequired() && saved.persisted !== "supabase") {
      return { ok: false, error: "Persistance Supabase indisponible. Réessaie dans quelques secondes." };
    }
    return { ok: true, user, session };
  });
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
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    store.sessions = store.sessions.filter((item) => item.tokenHash !== tokenHash);
    await saveAuthStore(store);
  });
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
    plan: effectivePlan(user),
    role: user.role || "user",
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || null,
    premiumUntil: user.premiumUntil || null,
    preferences: user.preferences || {},
    quotas: quotaSnapshot(user),
  };
}

async function consumeQuota(user, feature, req = null) {
  if (!user) return consumeAnonymousQuota(req, feature);
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    const stored = store.users.find((item) => item.id === user.id) || user;
    if (hasPremiumAccess(stored)) {
      return { ok: true, unlimited: true, feature };
    }
    const limits = {
      analysis: Number(env.FREE_DAILY_ANALYSES || 3),
      chat: Number(env.FREE_DAILY_CHAT || 25),
      detection: Number(env.FREE_DAILY_DETECTIONS || 8),
    };
    const limit = limits[feature] ?? 10;
    const today = new Date().toISOString().slice(0, 10);
    if (!stored) return { ok: false, error: "session_invalid" };
    stored.usage = normalizeUsage(stored.usage, today);
    const used = Number(stored.usage[feature] || 0);
    if (used >= limit) {
      return quotaExceededPayload({
        error: "quota_exceeded",
        feature,
        plan: effectivePlan(stored),
        limit,
        used,
        message: "Quota gratuit atteint pour aujourd'hui.",
        upgradeHint: "Passe en premium pour débloquer les analyses illimitées.",
      });
    }
    stored.usage[feature] = used + 1;
    stored.updatedAt = new Date().toISOString();
    await saveAuthStore(store);
    return { ok: true, feature, plan: effectivePlan(stored), limit, used: used + 1, remaining: Math.max(0, limit - used - 1) };
  });
}

function consumeAnonymousQuota(req, feature) {
  const limits = {
    analysis: Number(env.VISITOR_DAILY_ANALYSES || 1),
    chat: Number(env.VISITOR_DAILY_CHAT || 5),
    detection: Number(env.VISITOR_DAILY_DETECTIONS || 2),
  };
  const limit = limits[feature] ?? 3;
  const today = new Date().toISOString().slice(0, 10);
  const key = `${clientFingerprint(req)}:${today}`;
  const usage = normalizeUsage(anonymousUsage.get(key), today);
  const used = Number(usage[feature] || 0);
  if (used >= limit) {
    return quotaExceededPayload({
      error: "visitor_quota_exceeded",
      feature,
      plan: "visitor",
      limit,
      used,
      message: "Limite visiteur atteinte.",
      upgradeHint: "Crée un compte gratuit ou demande un accès premium test.",
    });
  }
  usage[feature] = used + 1;
  anonymousUsage.set(key, usage);
  return { ok: true, anonymous: true, feature, plan: "visitor", limit, used: used + 1, remaining: Math.max(0, limit - used - 1) };
}

function quotaSnapshot(user = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const usage = normalizeUsage(user.usage, today);
  const premium = hasPremiumAccess(user);
  return {
    date: today,
    plan: effectivePlan(user),
    analysis: { used: usage.analysis || 0, limit: premium ? "illimité" : Number(env.FREE_DAILY_ANALYSES || 3) },
    chat: { used: usage.chat || 0, limit: premium ? "illimité" : Number(env.FREE_DAILY_CHAT || 25) },
    detection: { used: usage.detection || 0, limit: premium ? "illimité" : Number(env.FREE_DAILY_DETECTIONS || 8) },
    resetsAt: nextQuotaReset().toISOString(),
  };
}

function hasPremiumAccess(user = {}) {
  if (user.role === "admin") return true;
  const plan = String(user.plan || "").toLowerCase();
  if (["pro", "admin"].includes(plan)) return true;
  const manualPremium = user.manualPremium === true || user.manualPremium === "true";
  if (!["premium", "prenium"].includes(plan) && !manualPremium) return false;
  if (!user.premiumUntil) return true;
  return new Date(user.premiumUntil).getTime() > Date.now();
}

function effectivePlan(user = {}) {
  if (!hasPremiumAccess(user)) return "free";
  const plan = String(user.plan || "premium").toLowerCase();
  return ["premium", "prenium", "pro", "admin"].includes(plan) ? (plan === "prenium" ? "premium" : plan) : "premium";
}

// X-Forwarded-For is a plain client-supplied header -- trusting it unconditionally
// (as this used to) meant every quota and rate-limit in this file keyed on it could
// be bypassed just by sending a different value per request. Confirmed live: 429
// on request 2 from the same header, 200 on request 3 with the header changed to a
// different fake IP, for both the visitor quota and the login brute-force limiter.
// Default is now the actual TCP connection IP, which the client cannot spoof. Only
// trust X-Forwarded-For (last hop, the one closest to us, harder for the client to
// control than the first) when TRUST_PROXY=true is explicitly set -- i.e. once
// you've confirmed your host's edge proxy sets/overwrites this header itself rather
// than passing through whatever the client sent.
const TRUST_PROXY = env.TRUST_PROXY === "true";
function clientFingerprint(req) {
  let ip = req?.socket?.remoteAddress || "local";
  if (TRUST_PROXY) {
    const chain = String(req?.headers?.["x-forwarded-for"] || "").split(",").map((part) => part.trim()).filter(Boolean);
    if (chain.length) ip = chain[chain.length - 1];
  }
  return String(ip).replace(/[^a-zA-Z0-9:._-]/g, "_").slice(0, 80);
}

function normalizeUsage(usage = {}, today = new Date().toISOString().slice(0, 10)) {
  return usage?.date === today
    ? { date: today, analysis: Number(usage.analysis || 0), chat: Number(usage.chat || 0), detection: Number(usage.detection || 0) }
    : { date: today, analysis: 0, chat: 0, detection: 0 };
}

function nextQuotaReset() {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

function quotaExceededPayload({ error, feature, plan, limit, used, message, upgradeHint }) {
  const reset = nextQuotaReset();
  const localReset = formatResetTime(reset);
  const fullMessage = `${message} ${upgradeHint} Tu peux revenir à ${localReset}.`;
  return {
    ok: false,
    error,
    feature,
    plan,
    limit,
    used,
    resetsAt: reset.toISOString(),
    resetsAtLocal: localReset,
    message: fullMessage,
    userMessage: fullMessage,
    nextActions: [
      `Revenir à ${localReset}, heure de réinitialisation du quota.`,
      plan === "visitor" ? "Créer un compte gratuit pour obtenir plus d'essais." : "Activer Premium pour supprimer la limite.",
    ],
  };
}

function formatResetTime(date) {
  const timeZone = env.APP_TIMEZONE || env.TZ || "Africa/Porto-Novo";
  try {
    return new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      timeZone,
      timeZoneName: "short",
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
      timeZoneName: "short",
    }).format(date);
  }
}

async function requireAdmin(req) {
  const expectedToken = normalizeAdminToken(env.ADMIN_TOKEN || env.ADMIN_ACCESS_TOKEN || "");
  const providedToken = normalizeAdminToken(String(req.headers["x-admin-token"] || "")
    || String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  if (expectedToken && providedToken && timingSafeStringEqual(providedToken, expectedToken)) {
    return { ok: true, via: "token" };
  }
  const session = await currentSession(req);
  if (session?.user?.role === "admin") return { ok: true, via: "session", user: publicUser(session.user) };
  return {
    ok: false,
    status: 403,
    error: "admin_required",
    message: expectedToken
      ? "Accès admin requis. Utilise le token admin ou un compte admin."
      : "Ajoute ADMIN_TOKEN dans secret.dev pour gérer les accès premium manuels.",
  };
}

// Marks an analysis as QA/verification traffic so it's excluded from calibration and
// public stats (see loadLearningLog()) instead of silently mixing in. Requires
// TEST_MODE_TOKEN to be configured -- if it's unset, this always returns false, so a
// real end user can never accidentally (or deliberately) get their own trades
// excluded from calibration just by sending an arbitrary header.
function isTestRequest(req) {
  const expectedToken = normalizeAdminToken(env.TEST_MODE_TOKEN || "");
  if (!expectedToken) return false;
  const providedToken = normalizeAdminToken(String(req.headers["x-kronos-test-token"] || ""));
  return Boolean(providedToken) && timingSafeStringEqual(providedToken, expectedToken);
}

async function grantPremiumAccess(body = {}) {
  const email = normalizeEmail(body.email);
  const days = Math.max(1, Math.min(730, Number(body.days || body.durationDays || 30)));
  if (!isValidEmail(email)) return { ok: false, error: "Email invalide." };
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    const user = store.users.find((item) => item.email === email);
    if (!user) return { ok: false, error: "Utilisateur introuvable. La personne doit d'abord créer un compte." };
    const premiumUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    user.plan = "premium";
    user.premiumUntil = premiumUntil;
    user.manualPremium = true;
    user.premiumSource = "manual_admin";
    user.updatedAt = new Date().toISOString();
    user.usage = { date: new Date().toISOString().slice(0, 10), analysis: 0, chat: 0, detection: 0 };
    await saveAuthStore(store);
    return { ok: true, user: adminUserPayload(user), message: `Premium activé pour ${email} jusqu'au ${premiumUntil}.` };
  });
}

async function revokePremiumAccess(body = {}) {
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return { ok: false, error: "Email invalide." };
  return withFileLock("auth-store", async () => {
    const store = await loadAuthStore();
    const user = store.users.find((item) => item.email === email);
    if (!user) return { ok: false, error: "Utilisateur introuvable." };
    user.plan = "free";
    user.premiumUntil = null;
    user.manualPremium = false;
    user.premiumSource = null;
    user.updatedAt = new Date().toISOString();
    await saveAuthStore(store);
    return { ok: true, user: adminUserPayload(user), message: `Premium retiré pour ${email}.` };
  });
}

function adminUserPayload(user = {}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    plan: effectivePlan(user),
    rawPlan: user.plan || "free",
    role: user.role || "user",
    premiumUntil: user.premiumUntil || null,
    manualPremium: Boolean(user.manualPremium),
    createdAt: user.createdAt || null,
    lastLoginAt: user.lastLoginAt || null,
    quotas: quotaSnapshot(user),
  };
}

function timingSafeStringEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeAdminToken(value = "") {
  return String(value).trim().replace(/^["']+|["']+$/g, "");
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

function setSessionCookie(res, token, req = null) {
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const secure = env.COOKIE_SECURE === "true" || forwardedProto === "https" || env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `oracle_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 60 * 60}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "oracle_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

function rowToAnalysis(row) {
  if (!row) return null;
  return {
    id: row.id,
    createdAt: row.created_at,
    userId: row.user_id || null,
    pair: row.pair,
    timeframe: row.timeframe,
    style: row.style,
    strategy: row.strategy,
    risk: row.risk,
    capital: row.capital,
    analysisDepth: row.analysis_depth,
    direction: row.direction,
    entry: row.entry,
    sl: row.sl,
    tp1: row.tp1,
    tp2: row.tp2,
    rr: row.rr,
    score: row.score,
    active: Boolean(Number(row.active)),
    status: row.status,
    blockReason: row.block_reason || null,
    livePriceAtSignal: row.live_price_at_signal,
    imageQuality: safeJsonParse(row.image_quality, null),
    calibration: safeJsonParse(row.calibration, null),
    validation: safeJsonParse(row.validation, null),
    technicalSnapshot: safeJsonParse(row.technical_snapshot, null),
    multiTimeframe: safeJsonParse(row.multi_timeframe, []),
    closedAt: row.closed_at || null,
    closePrice: row.close_price ?? null,
    outcome: row.outcome || null,
    outcomeReason: row.outcome_reason || null,
    rMultiple: row.r_multiple ?? null,
    isTest: Boolean(Number(row.is_test)),
  };
}

async function upsertAnalysisRow(analysis) {
  await sqlRun(
    `INSERT INTO analyses (id, user_id, created_at, pair, timeframe, style, strategy, risk, capital, analysis_depth,
       direction, entry, sl, tp1, tp2, rr, score, active, status, block_reason, live_price_at_signal,
       image_quality, calibration, validation, technical_snapshot, multi_timeframe,
       closed_at, close_price, outcome, outcome_reason, r_multiple, is_test)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id, status = excluded.status, block_reason = excluded.block_reason,
       closed_at = excluded.closed_at, close_price = excluded.close_price,
       outcome = excluded.outcome, outcome_reason = excluded.outcome_reason, r_multiple = excluded.r_multiple`,
    [
      analysis.id,
      analysis.userId || null,
      analysis.createdAt || new Date().toISOString(),
      analysis.pair || null,
      analysis.timeframe || null,
      analysis.style || null,
      analysis.strategy || null,
      analysis.risk ? String(analysis.risk) : null,
      analysis.capital ? String(analysis.capital) : null,
      analysis.analysisDepth || null,
      analysis.direction || null,
      Number.isFinite(analysis.entry) ? analysis.entry : null,
      Number.isFinite(analysis.sl) ? analysis.sl : null,
      Number.isFinite(analysis.tp1) ? analysis.tp1 : null,
      Number.isFinite(analysis.tp2) ? analysis.tp2 : null,
      analysis.rr ? String(analysis.rr) : null,
      Number(analysis.score) || 0,
      analysis.active ? 1 : 0,
      analysis.status || "OPEN",
      analysis.blockReason || null,
      Number.isFinite(analysis.livePriceAtSignal) ? analysis.livePriceAtSignal : null,
      analysis.imageQuality ? JSON.stringify(analysis.imageQuality) : null,
      analysis.calibration ? JSON.stringify(analysis.calibration) : null,
      analysis.validation ? JSON.stringify(analysis.validation) : null,
      analysis.technicalSnapshot ? JSON.stringify(analysis.technicalSnapshot) : null,
      analysis.multiTimeframe ? JSON.stringify(analysis.multiTimeframe) : null,
      analysis.closedAt || null,
      Number.isFinite(analysis.closePrice) ? analysis.closePrice : null,
      analysis.outcome || null,
      analysis.outcomeReason || null,
      Number.isFinite(analysis.rMultiple) ? analysis.rMultiple : null,
      analysis.isTest ? 1 : 0,
    ],
  );
}

// outcomes was historically a second array, populated only when an analysis closed.
// It's redundant with analyses itself (every field it carries also lives on the
// analysis row once outcome is set) -- confirmed no BLOCKED analysis was ever pushed
// there, only OPEN-then-resolved ones -- so it's derived here instead of stored as
// its own table.
//
// is_test rows (recordLearningAnalysis called with a matching X-Kronos-Test-Token
// header, see isTestRequest()) are excluded here rather than at each individual
// consumer -- confirmed live this session that my own QA/verification traffic
// (Playwright runs, curl smoke tests) was silently mixing into calibrationFor()'s
// shrinkage math and the public performance/equity-curve numbers with no way to tell
// it apart from real signals. Filtering once here means every consumer
// (calibration, equity curve, performance payload, personal analyses, admin) gets
// clean data automatically instead of needing this check added at each call site.
async function loadLearningLog() {
  await ensureRelationalTables();
  const rows = await sqlAll(`SELECT * FROM analyses WHERE is_test = ? ORDER BY created_at ASC`, [0]);
  const analyses = rows.map(rowToAnalysis);
  const outcomes = analyses
    .filter((item) => item.outcome)
    .map((item) => ({
      id: item.id,
      userId: item.userId || null,
      pair: item.pair,
      timeframe: item.timeframe,
      style: item.style,
      strategy: item.strategy || "Swing Trading",
      analysisDepth: item.analysisDepth || "Profonde",
      score: item.score,
      result: item.outcome,
      status: item.status,
      rMultiple: item.rMultiple,
      closedAt: item.closedAt,
    }));
  return { version: 1, analyses, outcomes, updatedAt: null };
}

async function recordLearningAnalysis(result, body, context) {
  await ensureRelationalTables();
  const id = `ana_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const active = !result.noSignal && result.direction !== "AUCUN SIGNAL";
  const entry = parseFormattedNumber(result.entry);
  const sl = parseFormattedNumber(result.sl);
  const tp1 = parseFormattedNumber(result.tp1);
  const tp2 = parseFormattedNumber(result.tp2);
  await upsertAnalysisRow({
    id,
    createdAt: new Date().toISOString(),
    userId: context.user?.id || null,
    pair: body.pair || "EUR/USD",
    timeframe: body.timeframe || "H1",
    style: body.style || "Hybride SMC+Chartiste",
    strategy: body.strategy || "Swing Trading",
    risk: body.risk || defaultRiskMode(),
    capital: body.capital || null,
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
    isTest: Boolean(context.isTest),
  });
  result.learningId = id;
  return id;
}

async function updateLearningOutcomes(prices = null) {
  // Only OPEN+active rows are pulled here (an indexed WHERE, not a full-table load
  // like the old load-mutate-save-whole-blob version), and only the rows that
  // actually resolve this tick get written. Still wrapped in the lock: two overlapping
  // calls (an endpoint hit landing mid-scheduler-tick) could otherwise both evaluate
  // the same analysis against the same price and double-process it.
  return withFileLock("learning-log", async () => {
    await ensureRelationalTables();
    const openRows = await sqlAll(`SELECT * FROM analyses WHERE status = 'OPEN' AND active = ?`, [1]);
    if (openRows.length) {
      const livePrices = prices || await getPrices();
      for (const row of openRows) {
        const analysis = rowToAnalysis(row);
        const price = Number(livePrices[analysis.pair]?.price);
        if (!Number.isFinite(price)) continue;
        const outcome = evaluateOutcome(analysis, price);
        const ageHours = (Date.now() - new Date(analysis.createdAt).getTime()) / 3600000;
        if (!outcome && ageHours < 24) continue;
        const finalOutcome = outcome || {
          status: "EXPIRED",
          result: "neutral",
          price,
          rMultiple: markToMarketRMultiple(analysis, price),
          reason: "Ni TP1 ni SL touché après 24h.",
        };
        analysis.status = finalOutcome.status;
        analysis.closedAt = new Date().toISOString();
        analysis.closePrice = price;
        analysis.outcome = finalOutcome.result;
        analysis.outcomeReason = finalOutcome.reason;
        analysis.rMultiple = Number.isFinite(finalOutcome.rMultiple) ? finalOutcome.rMultiple : null;
        await upsertAnalysisRow(analysis);
      }
    }
    return loadLearningLog();
  });
}

function evaluateOutcome(analysis, price) {
  const buy = analysis.direction === "ACHAT";
  if (![analysis.entry, analysis.sl, analysis.tp1].every(Number.isFinite)) return null;
  const risk = Math.abs(analysis.entry - analysis.sl);
  const rMultipleAt = (level) => (risk > 0 ? Math.round((Math.abs(level - analysis.entry) / risk) * 1000) / 1000 : null);
  if (Number.isFinite(analysis.tp2)) {
    if (buy && price >= analysis.tp2) return { status: "TP2_HIT", result: "win", price, rMultiple: rMultipleAt(analysis.tp2), reason: "TP2 touché." };
    if (!buy && price <= analysis.tp2) return { status: "TP2_HIT", result: "win", price, rMultiple: rMultipleAt(analysis.tp2), reason: "TP2 touché." };
  }
  if (buy && price >= analysis.tp1) return { status: "TP1_HIT", result: "win", price, rMultiple: rMultipleAt(analysis.tp1), reason: "TP1 touché." };
  if (buy && price <= analysis.sl) return { status: "SL_HIT", result: "loss", price, rMultiple: -1, reason: "Stop Loss touché." };
  if (!buy && price <= analysis.tp1) return { status: "TP1_HIT", result: "win", price, rMultiple: rMultipleAt(analysis.tp1), reason: "TP1 touché." };
  if (!buy && price >= analysis.sl) return { status: "SL_HIT", result: "loss", price, rMultiple: -1, reason: "Stop Loss touché." };
  return null;
}

// Mark-to-market R for a signal that expired without hitting TP or SL --
// same convention scripts/backtest.mjs uses for its "expired" bucket, so
// live results and backtested results are computed the same way.
function markToMarketRMultiple(analysis, price) {
  const risk = Math.abs(analysis.entry - analysis.sl);
  if (!(risk > 0) || !Number.isFinite(price)) return 0;
  const buy = analysis.direction === "ACHAT";
  const signedMove = buy ? price - analysis.entry : analysis.entry - price;
  return Math.round((signedMove / risk) * 1000) / 1000;
}

// A raw win rate on a handful of trades is mostly noise (at n=5, one flipped
// result swings it by 20 points). Instead of trusting it past a hard cutoff,
// shrink it toward a prior in proportion to sample size (Bayesian/Beta-binomial
// -style shrinkage) so small samples barely move the score and only a genuinely
// large sample earns its full weight.
//
// The shrinkage TARGET is pair-specific, seeded from scripts/backtest.mjs's
// held-out test results for the deterministic SMA+RSI strategy (~5y EUR/USD,
// XAU/USD, GBP/JPY, US500; ~2.7y BTC/USD, ETH/USD -- see that script's git
// history for the exact run). It is a "this pair's general character" prior
// (some pairs trend-follow more cleanly than others), NOT a measurement of the
// LLM chart-reading engine's accuracy on that pair -- those are different
// mechanisms. As real per-bucket (style+strategy+pair+timeframe) outcomes
// accumulate, `trust` shifts weight from this backtested guess to what the LLM
// path is actually producing for that specific bucket.
const PAIR_WIN_RATE_PRIOR = {
  "EUR/USD": 0.34,
  "XAU/USD": 0.55,
  "GBP/JPY": 0.30,
  US500: 0.41,
  "BTC/USD": 0.36,
  "ETH/USD": 0.34,
};
const CALIBRATION_REFERENCE_WIN_RATE = 0.55; // anchor the +-15/+12 adjustment range was tuned against
const CALIBRATION_SHRINKAGE_K = 40;

function winRateConfidenceLabel(samples) {
  if (samples >= 300) return "fiable";
  if (samples >= 100) return "provisoire";
  if (samples >= 20) return "indicatif";
  return "échantillon trop petit";
}

function calibrationFor(log, body = {}) {
  const pair = body.pair || "EUR/USD";
  const timeframe = body.timeframe || "H1";
  const style = body.style || "Mixte";
  const strategy = body.strategy || "Swing Trading";
  const prior = PAIR_WIN_RATE_PRIOR[pair] ?? CALIBRATION_REFERENCE_WIN_RATE;
  const buckets = [
    (item) => item.style === style && (item.strategy || "Swing Trading") === strategy && item.pair === pair && item.timeframe === timeframe,
    (item) => item.style === style && item.pair === pair,
    (item) => item.style === style && (item.strategy || "Swing Trading") === strategy,
    (item) => item.style === style,
  ];
  for (const matches of buckets) {
    const sample = log.outcomes.filter((item) => matches(item) && ["win", "loss"].includes(item.result)).slice(-200);
    if (sample.length >= 8) {
      const wins = sample.filter((item) => item.result === "win").length;
      const rawWinRate = wins / sample.length;
      const trust = sample.length / (sample.length + CALIBRATION_SHRINKAGE_K);
      const shrunkWinRate = trust * rawWinRate + (1 - trust) * prior;
      const adjustment = Math.max(-15, Math.min(12, Math.round((shrunkWinRate - CALIBRATION_REFERENCE_WIN_RATE) * 35)));
      const confidenceLabel = winRateConfidenceLabel(sample.length);
      return {
        samples: sample.length,
        winRate: Math.round(rawWinRate * 100),
        shrunkWinRate: Math.round(shrunkWinRate * 100),
        confidenceLabel,
        adjustment,
        message: `${sample.length} résultats (${confidenceLabel}), winrate observé ${Math.round(rawWinRate * 100)}% ramené à ${Math.round(shrunkWinRate * 100)}% après pondération par la taille d'échantillon (prior ${pair} ${Math.round(prior * 100)}%), ajustement ${adjustment}.`,
      };
    }
  }
  const noDataAdjustment = Math.max(-15, Math.min(12, Math.round((prior - CALIBRATION_REFERENCE_WIN_RATE) * 35)));
  return {
    samples: 0,
    winRate: null,
    confidenceLabel: "aucune donnée",
    adjustment: noDataAdjustment,
    message: `Pas d'historique réel pour ce contexte: départ sur le prior backtesté ${pair} (${Math.round(prior * 100)}%), ajustement ${noDataAdjustment}.`,
  };
}

function winRateBucket(items) {
  const wins = items.filter((item) => item.result === "win").length;
  const samples = items.length;
  const withR = items.filter((item) => Number.isFinite(item.rMultiple));
  const totalR = withR.reduce((sum, item) => sum + item.rMultiple, 0);
  return {
    samples,
    winRate: samples ? Math.round((wins / samples) * 100) : null,
    avgR: withR.length ? Math.round((totalR / withR.length) * 1000) / 1000 : null,
    confidenceLabel: samples ? winRateConfidenceLabel(samples) : "aucune donnée",
  };
}

// Chronological cumulative R, the same convention scripts/backtest.mjs uses
// for its "R total" -- this is what an equity curve actually is: not a
// price chart, a running sum of risk-adjusted outcomes.
function buildEquityCurve(outcomes) {
  const withR = outcomes
    .filter((item) => ["win", "loss", "neutral"].includes(item.result) && Number.isFinite(item.rMultiple) && item.closedAt)
    .slice()
    .sort((a, b) => new Date(a.closedAt) - new Date(b.closedAt));
  let cumulative = 0;
  return withR.map((item) => {
    cumulative += item.rMultiple;
    return {
      closedAt: item.closedAt,
      pair: item.pair,
      rMultiple: item.rMultiple,
      cumulativeR: Math.round(cumulative * 1000) / 1000,
    };
  });
}

function learningSummary(log) {
  const closed = log.outcomes.filter((item) => ["win", "loss"].includes(item.result));
  const global = winRateBucket(closed);
  const byStyle = Object.fromEntries(Object.keys(styleRules).map((style) => [
    style,
    winRateBucket(closed.filter((item) => item.style === style)),
  ]));
  const strategies = ["Scalping", "Swing Trading", "Position Trading", "Breakout", "Reversal"];
  const byStrategy = Object.fromEntries(strategies.map((strategy) => [
    strategy,
    winRateBucket(closed.filter((item) => (item.strategy || "Swing Trading") === strategy)),
  ]));
  const byPair = Object.fromEntries(symbols.map((pair) => [
    pair,
    winRateBucket(closed.filter((item) => item.pair === pair)),
  ]));
  return {
    updatedAt: log.updatedAt,
    totalAnalyses: log.analyses.length,
    openAnalyses: log.analyses.filter((item) => item.status === "OPEN").length,
    blockedAnalyses: log.analyses.filter((item) => item.status === "BLOCKED").length,
    closedAnalyses: closed.length,
    globalWinRate: global.winRate,
    globalAvgR: global.avgR,
    globalConfidenceLabel: global.confidenceLabel,
    byStyle,
    byStrategy,
    byPair,
    equityCurve: buildEquityCurve(log.outcomes),
    note: "Apprentissage contrôlé: Kronos calibre ses scores avec les résultats, sans modifier le code automatiquement. Les winrates affichés restent indicatifs tant que l'échantillon (n) est petit — voir confidenceLabel.",
  };
}

async function performancePayload(log) {
  const summary = learningSummary(log);
  const closed = log.outcomes.filter((item) => ["win", "loss"].includes(item.result));
  const recent = closed.slice(-12).reverse();
  const totalSignals = log.analyses.filter((item) => item.active).length;
  const authStore = await loadAuthStore();
  const memberCount = Array.isArray(authStore.users) ? authStore.users.length : 0;
  const precisionLabel = summary.globalWinRate !== null
    ? `${summary.globalWinRate}% (${summary.globalConfidenceLabel}, n=${summary.closedAnalyses})`
    : "Pas encore de données";
  return {
    updatedAt: summary.updatedAt,
    precision: summary.globalWinRate,
    precisionLabel,
    precisionConfidenceLabel: summary.globalConfidenceLabel,
    precisionAudited: summary.closedAnalyses >= 100,
    closedAnalyses: summary.closedAnalyses,
    totalAnalyses: summary.totalAnalyses,
    activeSignals: totalSignals,
    blockedAnalyses: summary.blockedAnalyses,
    openAnalyses: summary.openAnalyses,
    instrumentsTracked: symbols.length,
    membersLabel: String(memberCount),
    avgR: summary.globalAvgR,
    equityCurve: summary.equityCurve,
    byStyle: summary.byStyle,
    byStrategy: summary.byStrategy,
    byPair: summary.byPair,
    recent: recent.map((item) => ({
      pair: item.pair,
      style: item.style,
      strategy: item.strategy,
      result: item.result,
      status: item.status,
      score: item.score,
      rMultiple: Number.isFinite(item.rMultiple) ? item.rMultiple : null,
      closedAt: item.closedAt,
    })),
    disclaimer: summary.closedAnalyses >= 100
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

function extractScore(text) {
  const match = String(text).match(/SCORE_CONFIANCE\s*:?\s*(\d{1,3})/i);
  if (!match) return NaN;
  return Math.max(0, Math.min(100, Number(match[1])));
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
    .replace(/https:\/\/[a-z0-9-]+\.supabase\.co/gi, "https://<supabase-project>.supabase.co")
    .replace(/(Bearer|key|token|password|pwd)\s+[^"'\s]+/gi, "$1 <redacted>");
}

function normalizeSupabaseUrl(value = "") {
  const raw = String(value || "").trim().replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[a-z0-9-]+$/i.test(raw)) return `https://${raw}.supabase.co`;
  return raw;
}

function inferSupabaseProjectRef(url = "") {
  try {
    const host = new URL(url).hostname;
    return host.endsWith(".supabase.co") ? host.split(".")[0] : null;
  } catch {
    return null;
  }
}

async function loadEnv(path) {
  const out = {};
  if (!existsSync(path)) return { ...process.env };
  const raw = await readFile(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return { ...out, ...process.env };
}

const COMPRESSIBLE_EXT = new Set([".html", ".js", ".css", ".json", ".svg"]);
const HASHED_ASSET_RE = /-[A-Za-z0-9_]{6,}\.(?:js|css)$/;

function cacheControlFor(pathname, ext) {
  if (ext === ".html" || pathname === "/") return "no-cache";
  if (HASHED_ASSET_RE.test(pathname)) return "public, max-age=31536000, immutable";
  if (ext === ".js" || ext === ".css") return "public, max-age=300, must-revalidate";
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return "public, max-age=86400";
  return "no-cache";
}

async function serveStatic(res, pathname, req = null) {
  if ((pathname === "/admin-health" || pathname === "/admin-health.html") && env.ADMIN_HEALTH_PUBLIC !== "true") {
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
    "/premium-admin": "/premium-admin.html",
    "/admin-premium": "/premium-admin.html",
    "/admin-health": "/admin-health.html",
    "/admin": "/premium-admin.html",
    "/legal": "/legal.html",
    "/cgu": "/legal.html",
    "/confidentialite": "/legal.html",
    "/mentions-legales": "/legal.html",
    "/risques": "/legal.html",
  };
  pathname = aliases[pathname] || pathname;
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, pathname === "/" ? "index.html" : safe);
  if (existsSync(file) && statSync(file).isDirectory()) file = join(root, "index.html");
  if (!existsSync(file) && !extname(file)) file = join(root, "index.html");
  if (!existsSync(file) || statSync(file).isDirectory()) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }
  const ext = extname(file);
  res.setHeader("Content-Type", mime[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", cacheControlFor(pathname, ext));
  const compressible = COMPRESSIBLE_EXT.has(ext);
  if (compressible) res.setHeader("Vary", "Accept-Encoding");
  const acceptEncoding = String(req?.headers?.["accept-encoding"] || "");
  if (compressible && /\bbr\b/.test(acceptEncoding)) {
    res.setHeader("Content-Encoding", "br");
    res.writeHead(200);
    createReadStream(file).pipe(createBrotliCompress()).pipe(res);
    return;
  }
  if (compressible && /\bgzip\b/.test(acceptEncoding)) {
    res.setHeader("Content-Encoding", "gzip");
    res.writeHead(200);
    createReadStream(file).pipe(createGzip()).pipe(res);
    return;
  }
  res.writeHead(200);
  createReadStream(file).pipe(res);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
