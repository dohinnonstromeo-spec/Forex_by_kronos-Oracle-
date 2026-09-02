// Integration tests for the auth/quota/rate-limit/admin surface -- the exact class
// of endpoint that had two real, shipped bugs this session (a quota bypass via the
// chatbot, and a signup path that skipped the login rate limiter entirely) with zero
// automated coverage catching either. CI's smoke test only checks the server boots
// and a handful of endpoints respond -- it never exercises signup, login, quotas,
// rate-limiting, or admin auth. This does.
//
// Spawns the real server as a child process (not an import: server.mjs starts an
// HTTP server as a side effect of being loaded, so importing it directly would
// conflict with this test's own lifecycle) and makes real HTTP requests against it,
// same as every manual verification round this session did by hand. Uses
// TEST_MODE_TOKEN so any analyses created here are excluded from real
// stats/calibration; deletes every row it creates before exiting.
//
// Run with: node --test --test-concurrency=1 scripts/api-tests.mjs
// Needs secret.dev present with ADMIN_TOKEN and TEST_MODE_TOKEN set (already true
// for local dev; CI runs this without secret.dev, see the guard in main()).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer as createNetServer } from "node:net";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretPath = join(root, "secret.dev");
const dbPath = join(root, "data", "api-tests-" + process.pid + ".db");
// Reserve an ephemeral port so parallel or stale processes cannot hijack a test run.
let PORT = 0;
let BASE = "";

async function findFreePort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("could not reserve a test port");
  return port;
}

function readSecret(name) {
  if (!existsSync(secretPath)) return "";
  const raw = readFileSync(secretPath, "utf8");
  const match = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

const ADMIN_TOKEN = readSecret("ADMIN_TOKEN");
const TEST_TOKEN = readSecret("TEST_MODE_TOKEN");
// CI runs with no secret.dev at all (deliberately, see ci.yml) -- admin/rate-limit
// tests need a real ADMIN_TOKEN to mean anything, so they're skipped rather than
// false-failing on an environment that was never supposed to have one.
const hasSecrets = Boolean(ADMIN_TOKEN);

let serverProcess = null;
const createdEmails = [];

before(async () => {
  // server.mjs loads secret.dev before applying process.env. Empty overrides are
  // therefore required here, otherwise local integration tests can hit Neon.
  process.env.DATABASE_URL = '';
  process.env.SUPABASE_URL = '';
  process.env.SUPABASE_PROJECT_URL = '';
  process.env.SUPABASE_SERVICE_ROLE_KEY = '';
  process.env.SUPABASE_ANON_KEY = '';
  PORT = await findFreePort();
  BASE = `http://127.0.0.1:${PORT}`;
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", SQLITE_DB_PATH: dbPath, MOCK_BROKER_ENABLED: "true", MOCK_MARKET_DATA: "true", MAX_BODY_BYTES: "65536", BROKER_CREDENTIALS_ENCRYPTION_KEY: "api-test-broker-encryption-key-0123456789" },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 360; i++) {
        try {
          const res = await fetch(`${BASE}/api/health`);
          if (!res.ok) continue;
          const readyRes = await fetch(`${BASE}/api/me`, { headers: { Cookie: "oracle_session=readiness_probe" } });
          if (readyRes.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })(),
    new Promise((r) => setTimeout(() => r(false), 90000)),
  ]);
  if (!ready) throw new Error("server did not become ready in time");
});

after(async () => {
  const processToStop = serverProcess;
  if (processToStop && processToStop.exitCode === null) {
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 5000);
      processToStop.once('exit', finish);
      processToStop.kill();
    });
  }
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 30000"); // the helper opens a separate cleanup connection and waits for active server writes to finish.
    for (const email of createdEmails) {
      db.prepare("DELETE FROM push_subscriptions WHERE user_id IN (SELECT id FROM users WHERE email = ?)").run(email);
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)").run(email);
      db.prepare("DELETE FROM user_usage WHERE user_id IN (SELECT id FROM users WHERE email = ?)").run(email);
      db.prepare("DELETE FROM analyses WHERE user_id IN (SELECT id FROM users WHERE email = ?)").run(email);
      db.prepare("DELETE FROM users WHERE email = ?").run(email);
    }
    // The quota test's /api/analyze-chart calls are anonymous (no user_id), so the
    // per-email cleanup above never touches them -- is_test=1 is what actually
    // marks them (see X-Kronos-Test-Token / isTestRequest in server.mjs), same
    // cleanup this session used by hand every other time this header was involved.
    db.prepare("DELETE FROM analyses WHERE is_test = 1").run();
    db.prepare("DELETE FROM rate_limit_attempts").run();
    db.prepare("DELETE FROM anonymous_usage").run();
    db.prepare("DELETE FROM password_reset_tokens").run();
    db.close();
  }
  for (const suffix of ["", "-shm", "-wal"]) {
    const path = dbPath + suffix;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(path, { force: true });
        break;
      } catch (error) {
        if (!["EPERM", "EBUSY"].includes(error?.code) || attempt === 9) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

function uniqueEmail(prefix) {
  const email = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
  createdEmails.push(email);
  return email;
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// Every request in this suite comes from the same local IP, so signup/login/
// password-reset rate limits all share one counter per kind across every test in
// this file -- without resetting between tests, an earlier test's attempts would
// spuriously trip the limiter for a later, unrelated test. Only touches
// rate_limit_attempts/anonymous_usage, never real user data.
function resetRateLimits() {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 30000");
  db.prepare("DELETE FROM rate_limit_attempts").run();
  db.prepare("DELETE FROM anonymous_usage").run();
  db.close();
}

test("signup: valid signup succeeds", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_signup");
  const { status, data } = await postJson("/api/signup", { name: "ApiTest", email, password: "ValidPass123!" });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.user.email, email);
});

test("session cookie carries protective attributes behind HTTPS", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_cookie");
  const res = await fetch(BASE + "/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json", Connection: "close", "X-Forwarded-Proto": "https" },
    body: JSON.stringify({ name: "ApiTest", email, password: "ValidPass123!" }),
  });
  const cookie = res.headers.get("set-cookie") || "";
  assert.equal(res.status, 200);
  assert.match(cookie, /^oracle_session=[^;]+;/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Max-Age=\d+/);
});
test("signup: password under 8 chars is rejected", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_weakpw");
  const { status, data } = await postJson("/api/signup", { name: "ApiTest", email, password: "short" });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test("signup: wrong password against an existing account is rejected, not silently logged in", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_dup");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  const { data } = await postJson("/api/signup", { name: "ApiTest", email, password: "WrongPass123!" });
  assert.equal(data.ok, false);
});

test("login: correct credentials succeed", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_login_ok");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  const { status, data } = await postJson("/api/login", { email, password: "CorrectPass123!" });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

test("login: wrong password is rejected", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_login_bad");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  const { status, data } = await postJson("/api/login", { email, password: "WrongPass123!" });
  assert.equal(status, 401);
  assert.equal(data.ok, false);
});

test("login: rate limiter trips after repeated failures on the same account", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_ratelimit");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  let lastStatus = 0;
  for (let i = 0; i < 6; i++) {
    const { status } = await postJson("/api/login", { email, password: "WrongPass!" });
    lastStatus = status;
  }
  assert.equal(lastStatus, 429, "6th consecutive wrong-password attempt should be rate-limited");
  // The regression this covers: the same limiter must also apply through
  // /api/signup's "existing account, right password" reuse path, not just /api/login.
  const { data } = await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  assert.equal(data.ok, false, "correct password should still be blocked while the account is rate-limited");
  assert.equal(data.error, "too_many_attempts");
});

test("admin: grant-premium rejects a wrong token", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_admin_wrong");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  const { status, data } = await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": "definitely-not-the-real-token" });
  assert.equal(status, 403);
  assert.equal(data.ok, false);
});

test("admin: grant-premium then revoke-premium work with the real token", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_admin_ok");
  await postJson("/api/signup", { name: "ApiTest", email, password: "CorrectPass123!" });
  const granted = await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  assert.equal(granted.data.ok, true);
  assert.equal(granted.data.user.plan, "premium");
  const revoked = await postJson("/api/admin/revoke-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  assert.equal(revoked.data.ok, true);
  assert.equal(revoked.data.user.plan, "free");
});

test("admin: member detail returns safe account telemetry", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_member_detail");
  const signup = await postJson("/api/signup", { name: "Api Detail", email, password: "CorrectPass123!" });
  const userId = signup.data.user.id;
  const denied = await fetch(BASE + "/api/admin/members/" + encodeURIComponent(userId), { headers: { "X-Admin-Token": "wrong-token" } });
  assert.equal(denied.status, 403);
  const res = await fetch(BASE + "/api/admin/members/" + encodeURIComponent(userId), { headers: { "X-Admin-Token": ADMIN_TOKEN } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.user.email, email);
  assert.equal(typeof data.performance.totalAnalyses, "number");
  assert.equal(Array.isArray(data.byPair), true);
  assert.equal(typeof data.trading.totalOrders, "number");
  assert.equal(typeof data.account.activeSessions, "number");
  assert.equal(Object.prototype.hasOwnProperty.call(data, "brokerToken"), false);
  assert.equal(JSON.stringify(data).includes("broker_token"), false);
});
test("push: subscribing to the new_signal topic is blocked for a free account", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_push_free");
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  const { status, data } = await postJson(
    "/api/push/subscribe",
    { endpoint: "https://fake.push/apitest-free", keys: { p256dh: "abc", auth: "def" }, topic: "new_signal" },
    { Cookie: cookie },
  );
  assert.equal(status, 403);
  assert.equal(data.error, "premium_required");
});

test("push: a premium account can hold both topics on one subscription, and dropping one keeps the other", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_push_premium");
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  const endpoint = "https://fake.push/apitest-premium";
  await postJson("/api/push/subscribe", { endpoint, keys: { p256dh: "abc", auth: "def" }, topic: "tp_sl" }, { Cookie: cookie });
  const both = await postJson("/api/push/subscribe", { endpoint, keys: { p256dh: "abc", auth: "def" }, topic: "new_signal" }, { Cookie: cookie });
  assert.deepEqual(both.data.topics.sort(), ["new_signal", "tp_sl"]);

  await fetch(`${BASE}/api/push/unsubscribe-topic`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ endpoint, topic: "new_signal" }),
  });
  const remaining = await fetch(`${BASE}/api/push/subscription-topics?endpoint=${encodeURIComponent(endpoint)}`, { headers: { Cookie: cookie } });
  const remainingData = await remaining.json();
  assert.deepEqual(remainingData.topics, ["tp_sl"]);
});

test("push subscriptions cannot be reassigned across accounts", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const ownerEmail = uniqueEmail("apitest_push_owner");
  const attackerEmail = uniqueEmail("apitest_push_attacker");
  const ownerSignup = await fetch(`${BASE}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Owner", email: ownerEmail, password: "CorrectPass123!" }),
  });
  const ownerCookie = ownerSignup.headers.get("set-cookie");
  const attackerSignup = await fetch(`${BASE}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Attacker", email: attackerEmail, password: "CorrectPass123!" }),
  });
  const attackerCookie = attackerSignup.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email: ownerEmail }, { "X-Admin-Token": ADMIN_TOKEN });
  await postJson("/api/admin/grant-premium", { email: attackerEmail }, { "X-Admin-Token": ADMIN_TOKEN });
  const endpoint = `https://fake.push/apitest-owned-${Date.now()}`;
  const ownerSub = await postJson("/api/push/subscribe", { endpoint, keys: { p256dh: "owner-key", auth: "owner-auth" }, topic: "tp_sl" }, { Cookie: ownerCookie });
  assert.equal(ownerSub.status, 200);
  const attackerSub = await postJson("/api/push/subscribe", { endpoint, keys: { p256dh: "attacker-key", auth: "attacker-auth" }, topic: "new_signal" }, { Cookie: attackerCookie });
  assert.equal(attackerSub.status, 403);
  assert.equal(attackerSub.data.error, "subscription_owned_by_another_user");
  const ownerTopics = await fetch(`${BASE}/api/push/subscription-topics?endpoint=${encodeURIComponent(endpoint)}`, { headers: { Cookie: ownerCookie } });
  assert.deepEqual((await ownerTopics.json()).topics, ["tp_sl"]);
});
test("push subscriptions validate endpoint and key sizes", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_push_validation");
  const signup = await fetch(`${BASE}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signup.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  const insecure = await postJson("/api/push/subscribe", { endpoint: "http://insecure.example/push", keys: { p256dh: "key", auth: "auth" }, topic: "tp_sl" }, { Cookie: cookie });
  assert.equal(insecure.status, 400);
  assert.equal(insecure.data.error, "invalid_subscription");
  const oversized = await postJson("/api/push/subscribe", { endpoint: "https://valid.example/push", keys: { p256dh: "x".repeat(513), auth: "auth" }, topic: "tp_sl" }, { Cookie: cookie });
  assert.equal(oversized.status, 400);
  assert.equal(oversized.data.error, "invalid_subscription");
});
test("password reset: request never reveals whether an email has an account", async () => {
  resetRateLimits();
  const realEmail = uniqueEmail("apitest_reset_real");
  await postJson("/api/signup", { name: "ApiTest", email: realEmail, password: "CorrectPass123!" });
  const forReal = await postJson("/api/forgot-password", { email: realEmail });
  const forFake = await postJson("/api/forgot-password", { email: `nobody_${Date.now()}@example.com` });
  assert.equal(forReal.data.ok, forFake.data.ok);
  assert.equal(forReal.data.message, forFake.data.message);
});

test("password reset: garbage token is rejected", async () => {
  const { status, data } = await postJson("/api/reset-password", { token: "not-a-real-token", password: "NewPass123!" });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

test("quota: anonymous analysis quota blocks after the configured limit", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const limitRes = await fetch(`${BASE}/api/config`);
  await limitRes.json(); // just confirms the server responds before hammering the quota
  let sawBlock = false;
  for (let i = 0; i < 6; i++) {
    const { data } = await postJson(
      "/api/analyze-chart",
      { pair: "EUR/USD", timeframe: "H1", style: "Mixte", strategy: "Swing Trading", analysisDepth: "Rapide" },
      { "X-Kronos-Test-Token": TEST_TOKEN },
    );
    if (data.error === "visitor_quota_exceeded") { sawBlock = true; break; }
  }
  assert.equal(sawBlock, true, "anonymous quota should eventually block repeated requests");
});
test("supported PNG image quality is parsed without image-size", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const result = await postJson("/api/analyze-chart", { images: [tinyPng], pair: "EUR/USD", timeframe: "H1" }, { "X-Kronos-Test-Token": TEST_TOKEN });
  assert.equal(result.status, 200);
  assert.equal(result.data.noSignal, true);
  assert.match(result.data.meta?.imageQuality?.reason || "", /1x1/);
});
test("public health and config expose safe shapes only", async () => {
  const health = await fetch(`${BASE}/api/health`);
  const healthData = await health.json();
  assert.equal(health.status, 200);
  assert.equal(healthData.database, undefined);
  assert.equal(healthData.cache, undefined);
  assert.equal(healthData.learning, undefined);
  const config = await fetch(`${BASE}/api/config`);
  const configData = await config.json();
  assert.equal(config.status, 200);
  assert.equal(configData.ADMIN_TOKEN, undefined);
  assert.equal(configData.DATABASE_URL, undefined);
  assert.doesNotMatch(JSON.stringify(configData), /BEGIN PRIVATE KEY|postgresql:|sk-[A-Za-z0-9]/i);
  assert.equal(typeof configData.groq, "boolean");
  assert.equal(typeof configData.gemini, "boolean");
});
test("public surface: security headers are present on the home page", async () => {
  const res = await fetch(`${BASE}/`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(res.headers.get("content-security-policy") || "", /default-src/);
});
test("public surface: internal files and traversal are not served", async () => {
  for (const path of ["/secret.dev", "/server.mjs", "/scripts/api-tests.mjs", "/..%5c..%5csecret.dev"]) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text();
    assert.equal(res.status, 404, path);
    assert.doesNotMatch(body, /ADMIN_TOKEN|TEST_MODE_TOKEN|createServer/);
  }
});
test("malformed session cookies are ignored safely", async () => {
  const res = await fetch(`${BASE}/api/me`, { headers: { Cookie: "oracle_session=%ZZ" } });
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.equal(data.ok, false);
});
test("api responses are never cacheable", async () => {
  const res = await fetch(`${BASE}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
});
test("malformed JSON is rejected as a client error", async () => {
  const res = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{malformed",
  });
  const data = await res.json();
  assert.equal(res.status, 400);
  assert.equal(data.ok, undefined);
  assert.equal(data.error, "invalid_json");
});
test("oversized JSON bodies are rejected before route processing", async () => {
  const res = await fetch(BASE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "oversized@example.com", password: "x".repeat(70000) }),
  });
  const data = await res.json();
  assert.equal(res.status, 413);
  assert.equal(data.error, "payload_too_large");
});
test("reset-token flow removes the token from browser history", async () => {
  const source = readFileSync(join(root, "assets", "auth.js"), "utf8");
  assert.ok(source.includes("const resetToken = new URLSearchParams(window.location.search).get(\"token\") || \"\";"));
  assert.ok(source.includes("window.history.replaceState({}, document.title, window.location.pathname)"));
  assert.ok(source.includes("const token = resetToken;"));
  assert.match(source, /function fetchWithTimeout\(url, options = \{\}\)/);
  assert.match(source, /AbortSignal\.timeout\(CLIENT_REQUEST_TIMEOUT_MS\)/);
  assert.doesNotMatch(source, /await fetch\(/);
});
test("market source label is escaped before HTML rendering", () => {
  const source = readFileSync(join(root, "assets", "kronos-live.js"), "utf8");
  assert.ok(source.includes('${escapeHtml(sourceText)}'));
});
test("auth persistence never rewrites the full sessions table", () => {
  const source = readFileSync(join(root, "server.mjs"), "utf8");
  assert.doesNotMatch(source, /saveAuthStore/);
  assert.match(source, /DELETE FROM sessions WHERE token_hash = \\?/);
  assert.match(source, /DELETE FROM sessions WHERE user_id = \\?/);
});

test("quota counters use atomic database increments", () => {
  const source = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS user_usage/);
  assert.match(source, /UPDATE user_usage SET .*< \?/);
  assert.match(source, /UPDATE anonymous_usage SET .*< \?/);
  assert.match(source, /ON CONFLICT \(user_id, date\) DO NOTHING/);
  assert.match(source, /ON CONFLICT \(fingerprint, date\) DO NOTHING/);
  assert.match(source, /async function incrementRateLimitEntry/);
  assert.match(source, /UPDATE rate_limit_attempts SET count = CASE/);
  assert.doesNotMatch(source, /withFileLock\("rate-limit-attempts"/);
});
test("external responses are bounded before parsing", () => {
  const source = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(source, /function readResponseTextLimited\(response, maxBytes/);
  assert.match(source, /function readResponseJsonLimited\(response, maxBytes/);
  assert.doesNotMatch(source, /await response\.json\(\)/);
  assert.doesNotMatch(source, /await response\.text\(\)/);
  assert.match(source, /sendCrashAlert[\s\S]*?AbortSignal\.timeout\(3500\)/);
  assert.match(source, /api\.resend\.com\/emails[\s\S]*?AbortSignal\.timeout\(10000\)/);
  assert.match(source, /normalizedSymbol = normalizePair/);
  assert.match(source, /const newsInFlight = new Map/);
  assert.match(source, /memoryCache\.news\.size > 32/);
  assert.match(source, /clearSessionCookie\(res, req = null\)/);
  assert.match(source, /Max-Age=0" \+ secure/);
});

test("position modifications are serialized across replicas", () => {
  const source = readFileSync(join(root, "server.mjs"), "utf8");
  assert.match(source, /CREATE TABLE IF NOT EXISTS trade_operation_leases/);
  assert.match(source, /async function tryAcquireTradeOperationLease/);
  assert.match(source, /secureHalfForOrderUnlocked/);
  assert.match(source, /tryAcquireTradeOperationLease\(order\.id, "position-modify"\)/);
  assert.match(source, /tryAcquireTradeOperationLease\(row\.order_id, "position-modify"\)/);
  assert.match(source, /releaseTradeOperationLease\(row\.order_id, "position-modify", positionLeaseToken\)/);
  assert.match(source, /closeBrokerPosition\(credentials, latestRow\.broker_order_id\)/);
  assert.match(source, /broker_request_uncertain/);
  assert.match(source, /releaseTradeOperationLease\(order\.id, "position-modify", leaseToken\)/);
  assert.match(source, /const latestOrderRow = await sqlGet/);
  assert.match(source, /Number\(latestRow\.half_target_secured\) === 1/);
  assert.match(source, /const providedPreferences =/);
  assert.match(source, /const requestedCap = hasCapUpdate/);
  assert.match(source, /if \(hasCapUpdate && \(!Number\.isFinite\(requestedCap\)/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(body, key\)/);
});test("broker errors are sanitized before user-facing responses", () => {
  const source = readFileSync(join(root, "server.mjs"), "utf8");
  assert.ok(source.includes("function publicBrokerError(value)"));
  assert.ok(source.includes("MOCK_BROKER_ENABLED"));
  assert.ok(source.includes("MOCK_MARKET_DATA"));
  assert.ok(source.includes('order.status = broker.ok ? "SENT" : broker.uncertain ? "DELIVERY_UNKNOWN"'));
  assert.ok(source.includes('order.errorMessage = broker.ok ? null : broker.uncertain ? "broker_delivery_uncertain" : publicBrokerError(broker.error);'));
  assert.ok(source.includes("message: publicBrokerError(result.error)"));
  assert.ok(source.includes("deliveryUnknownOrders"));
  assert.ok(source.includes("WHERE o.status = 'DELIVERY_UNKNOWN'"));
  assert.ok(source.includes("status IN ('SENT', 'FAILED', 'DELIVERY_UNKNOWN')"));
  assert.ok(source.includes("WHERE id = ? AND status = 'SENDING'"));
  assert.ok(source.includes("if (!broker.ok && !broker.uncertain)"));
  assert.match(source, /brokerUnavailable/);
  assert.match(source, /brokerResult\?\.stillOpen \|\| brokerResult\?\.brokerUnavailable/);
  assert.doesNotMatch(source, /message: result\\.error/);
});
test("public navigation aliases resolve and protected pages redirect", async () => {
  const publicPages = [
    "/",
    "/analyse",
    "/analyse-ia",
    "/tester-gratuitement",
    "/paiement",
    "/abonnement",
    "/login",
    "/connexion",
    "/signup",
    "/inscription",
    "/forgot-password",
    "/mot-de-passe-oublie",
    "/reset-password",
    "/legal",
    "/cgu",
    "/confidentialite",
    "/mentions-legales",
    "/risques",
    "/premium-admin",
    "/admin-contenu",
  ];
  for (const page of publicPages) {
    const res = await fetch(`${BASE}${page}`);
    assert.equal(res.status, 200, `${page} should resolve`);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
  }

  const dashboard = await fetch(`${BASE}/dashboard`, { redirect: "manual" });
  assert.equal(dashboard.status, 302);
  assert.equal(dashboard.headers.get("location"), "/login");

  const adminHealth = await fetch(`${BASE}/admin-health`, { redirect: "manual" });
  assert.equal(adminHealth.status, 404);
});
test("admin site-content registry rejects anonymous access", async () => {
  const res = await fetch(`${BASE}/api/admin/site-content/registry`);
  const data = await res.json();
  assert.equal(res.status, 403);
  assert.equal(data.ok, false);
  assert.equal(data.error, "admin_required");
});

test("site-content rich text is sanitized before returning public overrides", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  const key = "legal.mentions.placeholder";
  const payload = `<strong>Safe</strong><script>alert(1)</script><img src=x onerror=alert(2)><a href="javascript:alert(3)">bad</a><a href="//evil.example">external</a><a href="/safe">local</a>`;

  const setRes = await postJson(
    "/api/admin/site-content/set",
    { key, value: payload },
    { "X-Admin-Token": ADMIN_TOKEN },
  );
  assert.equal(setRes.status, 200);
  assert.equal(setRes.data.ok, true);

  const publicRes = await fetch(`${BASE}/api/site-content`);
  const publicData = await publicRes.json();
  assert.equal(publicRes.status, 200);
  assert.equal(publicData.ok, true);
  assert.match(publicData.overrides[key] || "", /<strong>Safe<\/strong>/);
  assert.doesNotMatch(publicData.overrides[key] || "", /script|onerror|javascript:|href="\/\/evil\.example"/i);
  assert.match(publicData.overrides[key] || "", /href="\/safe"/i);

  await postJson(
    "/api/admin/site-content/reset",
    { key },
    { "X-Admin-Token": ADMIN_TOKEN },
  );
});
test("trade surface rejects anonymous access", async () => {
  const ordersRes = await fetch(`${BASE}/api/trade/orders`);
  const ordersData = await ordersRes.json();
  assert.equal(ordersRes.status, 401);
  assert.equal(ordersData.ok, false);
  assert.equal(ordersData.error, "auth_required");

  const prepareRes = await postJson("/api/trade/prepare", { analysisId: "fake" });
  assert.equal(prepareRes.status, 401);
  assert.equal(prepareRes.data.ok, false);
  assert.equal(prepareRes.data.error, "auth_required");
});
test("authenticated mutations reject a foreign Origin", async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_csrf");
  const signup = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "ValidPass123!" }),
  });
  const cookie = signup.headers.get("set-cookie");
  const blocked = await fetch(`${BASE}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: "https://evil.example" } });
  const blockedData = await blocked.json();
  assert.equal(blocked.status, 403);
  assert.equal(blockedData.error, "csrf_origin_invalid");
  const stillLoggedIn = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  assert.equal((await stillLoggedIn.json()).ok, true);
  await fetch(`${BASE}/api/logout`, { method: "POST", headers: { Cookie: cookie, Origin: BASE } });
});
test("logout invalidates the session cookie", async () => {
  const email = uniqueEmail("apitest_logout");
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  const before = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  const beforeData = await before.json();
  assert.equal(before.status, 200);
  assert.equal(beforeData.ok, true);

  const logout = await fetch(`${BASE}/api/logout`, { method: "POST", headers: { Cookie: cookie } });
  const logoutData = await logout.json();
  assert.equal(logout.status, 200);
  assert.equal(logoutData.ok, true);

  const after = await fetch(`${BASE}/api/me`, { headers: { Cookie: cookie } });
  const afterData = await after.json();
  assert.equal(after.status, 200);
  assert.equal(afterData.ok, false);
});

// End-to-end regression for the safest positive path we can test without a real
// broker: a premium user can create an analysis, prepare an order from it, and
// see that order in the pending list. This catches accidental breakage in the
// analysis -> order binding and the premium gate together.
function seedOpenAnalysis(email) {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 30000");
  const user = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  assert.ok(user?.id);
  const id = "ana_test_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  db.prepare("INSERT INTO analyses (id, user_id, created_at, pair, timeframe, style, strategy, risk, capital, analysis_depth, direction, entry, sl, tp1, tp2, rr, score, active, status, block_reason, live_price_at_signal, image_quality, calibration, validation, technical_snapshot, multi_timeframe, closed_at, close_price, outcome, outcome_reason, r_multiple, broker_profit_amount, is_test, source, broker_slot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, user.id, now, "EUR/USD", "H1", "Mixte", "Swing Trading", "Protection maximale 0.5%", null, "Rapide", "ACHAT", 1.16818, 1.16608, 1.17039, 1.17165, "1:1.0", 80, 1, "OPEN", null, 1.16818, "{}", "{}", "{}", "{}", "[]", null, null, null, null, null, null, 1, "manual", null);
  db.prepare('UPDATE analyses SET entry = ?, sl = ?, tp1 = ?, tp2 = ? WHERE id = ?').run(1.1531, 1.151, 1.15531, 1.15657, id);
  db.close();
  return id;
}
test("premium user can prepare an order from a fresh analysis", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_trade_prepare");
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });

  const analysisId = seedOpenAnalysis(email);

  const prepareRes = await postJson("/api/trade/prepare", { analysisId: analysisId }, { Cookie: cookie });
  assert.equal(prepareRes.status, 200);
  assert.equal(prepareRes.data.ok, true);
  assert.equal(prepareRes.data.order.analysisId, analysisId);
  assert.equal(prepareRes.data.order.status, "PENDING_CONFIRMATION");

  const ordersRes = await fetch(`${BASE}/api/trade/orders`, { headers: { Cookie: cookie } });
  const ordersData = await ordersRes.json();
  assert.equal(ordersRes.status, 200);
  assert.equal(ordersData.ok, true);
  assert.ok(ordersData.orders.some((order) => order.analysisId === analysisId && order.status === "PENDING_CONFIRMATION"));
});

test("trade prepare is single-flight under concurrent requests", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_trade_double_prepare");
  const signupRes = await fetch(BASE + "/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  const analysisId = seedOpenAnalysis(email);

  const results = await Promise.all([
    postJson("/api/trade/prepare", { analysisId }, { Cookie: cookie }),
    postJson("/api/trade/prepare", { analysisId }, { Cookie: cookie }),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 1);
  assert.equal(results.find((result) => result.status === 409)?.data.error, "order_already_prepared");

  const ordersRes = await fetch(BASE + "/api/trade/orders", { headers: { Cookie: cookie } });
  const ordersData = await ordersRes.json();
  const prepared = ordersData.orders.filter((order) => order.analysisId === analysisId && order.status === "PENDING_CONFIRMATION");
  assert.equal(prepared.length, 1);
});
// Same setup as above, but with the broker mock enabled so the full confirm ->
// send path can be exercised deterministically without an external MetaApi
// account. This catches regressions in the confirmation guard chain and the
// state transition to SENT.
test("premium user can confirm and send an order with the mock broker", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_trade_confirm");
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  const connectRes = await postJson(
    "/api/auto-trade/broker/connect",
    { token: "mock-token", accountId: "mock-account", region: "london", slot: "demo" },
    { Cookie: cookie },
  );
  assert.equal(connectRes.status, 200);
  assert.equal(connectRes.data.ok, true);

  const brokerDb = new DatabaseSync(dbPath);
  brokerDb.exec("PRAGMA busy_timeout = 30000; PRAGMA query_only = ON");
  const storedBroker = brokerDb.prepare("SELECT broker_demo_token FROM auto_trading_accounts WHERE user_id = (SELECT id FROM users WHERE email = ?)").get(email);
  brokerDb.close();
  assert.match(storedBroker?.broker_demo_token || "", /^enc:v1:/);
  assert.notEqual(storedBroker?.broker_demo_token, "mock-token");

  const analysisId = seedOpenAnalysis(email);

  const prepareRes = await postJson("/api/trade/prepare", { analysisId: analysisId }, { Cookie: cookie });
  assert.equal(prepareRes.status, 200);
  assert.equal(prepareRes.data.ok, true);
  assert.equal(prepareRes.data.order.status, "PENDING_CONFIRMATION");

  const confirmRes = await postJson(
    "/api/trade/confirm",
    { orderId: prepareRes.data.order.id, volume: 0.01, brokerSlot: "demo" },
    { Cookie: cookie },
  );
  assert.equal(confirmRes.status, 200, JSON.stringify(confirmRes.data));
  assert.equal(confirmRes.data.ok, true);
  assert.equal(confirmRes.data.order.status, "SENT");
  assert.match(confirmRes.data.order.brokerOrderId || "", /^mock_/);

  const ordersRes = await fetch(`${BASE}/api/trade/orders`, { headers: { Cookie: cookie } });
  const ordersData = await ordersRes.json();
  assert.equal(ordersRes.status, 200);
  assert.equal(ordersData.ok, true);
  assert.ok(ordersData.orders.some((order) => order.id === prepareRes.data.order.id && order.status === "SENT" && order.brokerOrderId));
});
test("trade confirm is single-flight under concurrent requests", { skip: !hasSecrets && "needs secret.dev" }, async () => {
  resetRateLimits();
  const email = uniqueEmail("apitest_trade_double_confirm");
  const signupRes = await fetch(BASE + "/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "ApiTest", email, password: "CorrectPass123!" }),
  });
  const cookie = signupRes.headers.get("set-cookie");
  await postJson("/api/admin/grant-premium", { email }, { "X-Admin-Token": ADMIN_TOKEN });
  await postJson(
    "/api/auto-trade/broker/connect",
    { token: "mock-token", accountId: "mock-account", region: "london", slot: "demo" },
    { Cookie: cookie },
  );
  const analysisId = seedOpenAnalysis(email);
  const prepareRes = await postJson("/api/trade/prepare", { analysisId }, { Cookie: cookie });
  assert.equal(prepareRes.status, 200);
  const orderId = prepareRes.data.order.id;

  const results = await Promise.all([
    postJson("/api/trade/confirm", { orderId, volume: 0.01, brokerSlot: "demo" }, { Cookie: cookie }),
    postJson("/api/trade/confirm", { orderId, volume: 0.01, brokerSlot: "demo" }, { Cookie: cookie }),
  ]);
  assert.equal(results.filter((result) => result.status === 200).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.status === 400).length, 1);
  assert.equal(results.find((result) => result.status === 400)?.data.error, "order_not_pending");

  const ordersRes = await fetch(BASE + "/api/trade/orders", { headers: { Cookie: cookie } });
  const ordersData = await ordersRes.json();
  const order = ordersData.orders.find((item) => item.id === orderId);
  assert.equal(order?.status, "SENT");
});
