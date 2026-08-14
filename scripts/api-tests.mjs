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
// Run with: node --test scripts/api-tests.mjs
// Needs secret.dev present with ADMIN_TOKEN and TEST_MODE_TOKEN set (already true
// for local dev; CI runs this without secret.dev, see the guard in main()).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretPath = join(root, "secret.dev");
const dbPath = join(root, "data", "oracle.db");
const PORT = 4177;
const BASE = `http://127.0.0.1:${PORT}`;

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
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "pipe",
  });
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 40; i++) {
        try {
          const res = await fetch(`${BASE}/api/prices`);
          if (res.ok) return true;
        } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })(),
    new Promise((r) => setTimeout(() => r(false), 12000)),
  ]);
  if (!ready) throw new Error("server did not become ready in time");
});

after(async () => {
  if (existsSync(dbPath)) {
    const db = new DatabaseSync(dbPath);
    for (const email of createdEmails) {
      db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)").run(email);
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
  serverProcess?.kill();
});

function uniqueEmail(prefix) {
  const email = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}@example.com`;
  createdEmails.push(email);
  return email;
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
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
