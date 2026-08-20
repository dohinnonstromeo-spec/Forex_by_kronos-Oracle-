// End-to-end regression suite for the real broker-execution pipeline --
// insufficiency #2 from an engine audit ("un test d'integration bout-en-bout,
// bot complet contre un broker simule"). Reworked from "simulated broker" to
// "the real demo broker" after being told directly: "c'est un compte demo
// donc c'est de l'argent fictif tu peux donc l'utiliser et faire tout les
// test possibles". This is exactly what the critical sideValid/tp1-null bug
// (fixed earlier this session -- every BUY order with no broker-side TP was
// silently rejected) would have caught immediately instead of shipping
// unnoticed through months of scalp/trailing-stop live testing that happened
// to only exercise SELL directions or seeded state. That bug is now test
// case #1 below, permanently.
//
// Same spawn-the-real-server pattern as scripts/api-tests.mjs (server.mjs
// starts an HTTP server as an import side effect, so this can't import it
// directly) -- real HTTP requests against a real running instance, a real
// connected demo broker account, real orders opened and closed. Every
// position this suite opens is tracked and force-closed in after(), even on
// failure, and every DB row it seeds is deleted afterward.
//
// Run with: node --test scripts/broker-e2e-tests.mjs
// Needs secret.dev present with METAAPI_TOKEN/METAAPI_ACCOUNT_ID and
// ADMIN_TOKEN set (already true for local dev) -- skips entirely otherwise,
// same reasoning as api-tests.mjs's hasSecrets guard: CI has no secret.dev
// and must never touch a real broker account automatically on every push.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const secretPath = join(root, "secret.dev");
const dbPath = join(root, "data", "oracle.db");
const PORT = 4178; // distinct from api-tests.mjs's 4177 -- safe to run both at once
const BASE = `http://127.0.0.1:${PORT}`;

function readSecret(name) {
  if (!existsSync(secretPath)) return "";
  const raw = readFileSync(secretPath, "utf8");
  const match = raw.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1].trim() : "";
}

const ADMIN_TOKEN = readSecret("ADMIN_TOKEN");
const METAAPI_TOKEN = readSecret("METAAPI_TOKEN");
const METAAPI_ACCOUNT_ID = readSecret("METAAPI_ACCOUNT_ID");
const METAAPI_REGION = readSecret("METAAPI_REGION") || "new-york";
const hasSecrets = Boolean(ADMIN_TOKEN && METAAPI_TOKEN && METAAPI_ACCOUNT_ID);
const brokerBase = `https://mt-client-api-v1.${METAAPI_REGION}.agiliumtrade.ai/users/current/accounts/${METAAPI_ACCOUNT_ID}`;

let serverProcess = null;
let db = null;
let testUserId = null;
let testEmail = null;
let cookie = null;
const openedPositions = []; // broker position ids to force-close in after()
const seededIds = []; // { analysisId } to delete from analyses/trade_orders in after()

async function brokerFetch(path, options = {}) {
  const response = await fetch(`${brokerBase}${path}`, {
    ...options,
    headers: { "auth-token": METAAPI_TOKEN, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  return response.json();
}

async function openRealPosition({ direction, symbol, volume = 0.01, stopLoss, takeProfit }) {
  const data = await brokerFetch("/trade", {
    method: "POST",
    body: JSON.stringify({ actionType: direction === "ACHAT" ? "ORDER_TYPE_BUY" : "ORDER_TYPE_SELL", symbol, volume, stopLoss, takeProfit }),
  });
  if (data?.numericCode !== 10009) throw new Error(`real broker open failed: ${JSON.stringify(data)}`);
  const positionId = String(data.orderId ?? data.positionId);
  openedPositions.push(positionId);
  return positionId;
}

async function getRealPositions() {
  return brokerFetch("/positions");
}

async function getRealPrice(symbol) {
  return brokerFetch(`/symbols/${symbol}/current-price`);
}

function seedOrder({ pair, direction, entry, sl, tp1, status, brokerOrderId, trailingStopPrice, bestFavorablePrice }) {
  const id = "e2e_" + randomBytes(4).toString("hex");
  const orderId = "ord_" + id;
  const now = new Date().toISOString();
  // analyses.status is always 'OPEN' at creation time in real production,
  // regardless of trade_orders.status (PENDING_CONFIRMATION/SENT/...) -- see
  // processAutoTradeForUser, which creates both rows in the same breath.
  db.prepare(`INSERT INTO analyses (id, user_id, created_at, pair, direction, entry, sl, tp1, tp2, status, active, source, broker_slot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1, 'auto_signal', 'demo')`)
    .run(id, testUserId, now, pair, direction, entry, sl, tp1, tp1);
  db.prepare(`INSERT INTO trade_orders (id, user_id, analysis_id, pair, direction, entry, sl, tp1, tp2, status, created_at, broker_slot, broker_order_id, sent_at, trailing_stop_price, best_favorable_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?, ?, ?, ?)`)
    .run(orderId, testUserId, id, pair, direction, entry, sl, tp1, tp1, status, now, brokerOrderId ?? null, brokerOrderId ? now : null, trailingStopPrice ?? null, bestFavorablePrice ?? null);
  seededIds.push(id);
  return { analysisId: id, orderId };
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() };
}

before(async () => {
  if (!hasSecrets) return;
  // Short trailing-stop interval so the "real scheduler moves a real stop"
  // test doesn't need to wait the normal 15s+ margin for confidence -- this
  // spawned instance is fully isolated (its own port), never the dev server.
  serverProcess = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), TRAILING_STOP_INTERVAL_SECONDS: "4" },
    stdio: "pipe",
  });
  const ready = await Promise.race([
    (async () => {
      for (let i = 0; i < 40; i++) {
        try { const res = await fetch(`${BASE}/api/prices`); if (res.ok) return true; } catch { /* not up yet */ }
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })(),
    new Promise((r) => setTimeout(() => r(false), 15000)),
  ]);
  if (!ready) throw new Error("server did not become ready in time");

  db = new DatabaseSync(dbPath);
  testEmail = `broker_e2e_${Date.now()}@example.com`;
  const signupRes = await fetch(`${BASE}/api/signup`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Broker E2E", email: testEmail, password: "TestPass123!" }),
  });
  cookie = signupRes.headers.get("set-cookie")?.split(";")[0];
  const signupData = await signupRes.json();
  if (!signupData.ok) throw new Error(`test user signup failed: ${JSON.stringify(signupData)}`);
  await fetch(`${BASE}/api/admin/grant-premium`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Token": ADMIN_TOKEN },
    body: JSON.stringify({ email: testEmail }),
  });
  const userRow = db.prepare(`SELECT id FROM users WHERE email = ?`).get(testEmail);
  testUserId = userRow.id;
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO auto_trading_accounts (user_id, broker_demo_token, broker_demo_account_id, broker_demo_region, broker_demo_connected_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET broker_demo_token = excluded.broker_demo_token, broker_demo_account_id = excluded.broker_demo_account_id, broker_demo_region = excluded.broker_demo_region, broker_demo_connected_at = excluded.broker_demo_connected_at`)
    .run(testUserId, METAAPI_TOKEN, METAAPI_ACCOUNT_ID, METAAPI_REGION, now, now, now);
});

after(async () => {
  if (!hasSecrets) return;
  // Force-close every real position this suite opened, regardless of which
  // tests passed or failed -- never leave real (if demo) exposure behind.
  for (const positionId of openedPositions) {
    await brokerFetch("/trade", { method: "POST", body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId }) }).catch(() => {});
  }
  if (db) {
    for (const analysisId of seededIds) {
      db.prepare(`DELETE FROM trade_orders WHERE analysis_id = ?`).run(analysisId);
      db.prepare(`DELETE FROM analyses WHERE id = ?`).run(analysisId);
    }
    if (testUserId) {
      db.prepare(`DELETE FROM auto_trading_accounts WHERE user_id = ?`).run(testUserId);
      db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(testUserId);
      db.prepare(`DELETE FROM users WHERE id = ?`).run(testUserId);
    }
    db.close();
  }
  serverProcess?.kill();
});

test("confirm: BUY with NO broker TP opens successfully -- regression test for the sideValid/tp1-null bug", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const entry = price.ask;
  const sl = Math.round((entry - 0.0030) * 100000) / 100000;
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "ACHAT", entry, sl, tp1: null, status: "PENDING_CONFIRMATION" });
  const { status, data } = await postJson("/api/trade/confirm", { orderId, volume: 0.01, brokerSlot: "demo" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
  assert.equal(data.order.status, "SENT");
  assert.ok(data.order.brokerOrderId, "expected a real brokerOrderId");
  openedPositions.push(data.order.brokerOrderId);
});

test("confirm: SELL with NO broker TP opens successfully (this direction always worked -- symmetry check)", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const entry = price.bid;
  const sl = Math.round((entry + 0.0030) * 100000) / 100000;
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "VENTE", entry, sl, tp1: null, status: "PENDING_CONFIRMATION" });
  const { status, data } = await postJson("/api/trade/confirm", { orderId, volume: 0.01, brokerSlot: "demo" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
  assert.equal(data.ok, true);
  assert.equal(data.order.status, "SENT");
  openedPositions.push(data.order.brokerOrderId);
});

test("confirm: BUY WITH a real broker TP (fixed-TP pairs) opens successfully", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const entry = price.ask;
  const sl = Math.round((entry - 0.0030) * 100000) / 100000;
  const tp1 = Math.round((entry + 0.0050) * 100000) / 100000;
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "ACHAT", entry, sl, tp1, status: "PENDING_CONFIRMATION" });
  const { status, data } = await postJson("/api/trade/confirm", { orderId, volume: 0.01, brokerSlot: "demo" });
  assert.equal(status, 200, `expected 200, got ${status}: ${JSON.stringify(data)}`);
  assert.equal(data.order.status, "SENT");
  openedPositions.push(data.order.brokerOrderId);
});

test("secure-half: halves a real broker TP", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const entry = price.ask;
  const sl = Math.round((entry - 0.0030) * 100000) / 100000;
  const tp1 = Math.round((entry + 0.0050) * 100000) / 100000;
  const brokerOrderId = await openRealPosition({ direction: "ACHAT", symbol: "EURUSD", stopLoss: sl, takeProfit: tp1 });
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "ACHAT", entry, sl, tp1, status: "SENT", brokerOrderId });
  const { data } = await postJson("/api/trade/secure-half", { orderId });
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(data.mode, "tp_halved");
  const expected = Math.round((entry + (tp1 - entry) * 0.5) * 100000) / 100000;
  assert.equal(data.newTakeProfit, expected);
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  assert.ok(Math.abs(real.takeProfit - expected) < 0.0001, `real broker TP ${real.takeProfit} should match expected ${expected}`);
});

test("secure-half: locks half of unrealized profit via the stop when there is no broker TP", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const realEntry = price.bid;
  const realSl = Math.round((realEntry + 0.0030) * 100000) / 100000;
  const brokerOrderId = await openRealPosition({ direction: "VENTE", symbol: "EURUSD", stopLoss: realSl, takeProfit: undefined });
  // Seeded entry deliberately worse than the real fill -- a controlled test
  // input simulating ~1R of existing profit without waiting on real market
  // movement (see the identical technique this exact scenario was first
  // verified with, live, before this suite existed).
  const seededEntry = Math.round((realEntry + 0.0030) * 100000) / 100000;
  const seededSl = Math.round((seededEntry + 0.0030) * 100000) / 100000;
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "VENTE", entry: seededEntry, sl: seededSl, tp1: null, status: "SENT", brokerOrderId, bestFavorablePrice: seededEntry });
  const { data } = await postJson("/api/trade/secure-half", { orderId });
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.equal(data.mode, "stop_locked_half_profit");
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  assert.ok(Math.abs(real.stopLoss - data.newStopLoss) < 0.0001, `real broker stop ${real.stopLoss} should match reported ${data.newStopLoss}`);
  assert.ok(real.stopLoss < seededSl, "the new stop should be an improvement over the original (closer to price, in profit)");
});

test("trailing-stop scheduler moves a real position's stop on its own, on a real tick", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const realEntry = price.bid;
  const realSl = Math.round((realEntry + 0.0030) * 100000) / 100000;
  const brokerOrderId = await openRealPosition({ direction: "VENTE", symbol: "EURUSD", stopLoss: realSl, takeProfit: undefined });
  // Seeded as an EUR/USD swing position (one of the 3 real
  // SWING_TRAILING_PARAMS_BY_PAIR pairs: activationR 0.2, trailR 0.3) already
  // ~1R in profit, same seeding technique as the secure-half profit test --
  // this time verifying the BACKGROUND SCHEDULER acts on it by itself,
  // nobody calling an endpoint.
  const seededEntry = Math.round((realEntry + 0.0030) * 100000) / 100000;
  const seededSl = Math.round((seededEntry + 0.0030) * 100000) / 100000;
  seedOrder({ pair: "EUR/USD", direction: "VENTE", entry: seededEntry, sl: seededSl, tp1: null, status: "SENT", brokerOrderId, trailingStopPrice: seededSl, bestFavorablePrice: seededEntry });
  // TRAILING_STOP_INTERVAL_SECONDS=4 on this spawned instance -- 7s covers at
  // least one full real tick with margin.
  await new Promise((r) => setTimeout(r, 7000));
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  assert.ok(real.stopLoss < seededSl, `scheduler should have moved the stop favorably (from ${seededSl}, now ${real.stopLoss})`);
  const dbRow = db.prepare(`SELECT trailing_stop_price FROM trade_orders WHERE broker_order_id = ?`).get(brokerOrderId);
  assert.ok(Math.abs(dbRow.trailing_stop_price - real.stopLoss) < 0.0001, "our own DB record should match the real broker stop the scheduler set");
});
