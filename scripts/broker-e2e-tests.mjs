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

// Closes a position at the end of the SAME test that opened it, rather than
// letting every test's position pile up until the file's after(). Found live
// while debugging this suite: with several tests' positions still open at
// once, later checkTrailingStops ticks have more real rows to iterate (each
// a real broker HTTP call), which pushed timing-sensitive tests past their
// wait window in a full-suite run even though they passed in isolation. Also
// keeps real (if demo) exposure to what one test actually needs, not
// whatever has accumulated so far.
async function closeReal(positionId) {
  await brokerFetch("/trade", { method: "POST", body: JSON.stringify({ actionType: "POSITION_CLOSE_ID", positionId: String(positionId) }) }).catch(() => {});
  const idx = openedPositions.indexOf(positionId);
  if (idx !== -1) openedPositions.splice(idx, 1);
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
  db.exec("PRAGMA busy_timeout = 5000"); // see the identical pragma added to server.mjs's getSqliteDb() -- same "database is locked" flakiness class, now on both sides of every DB access this suite does concurrently with the spawned server.
  // Re-running this suite repeatedly during development trips the real
  // signup rate limiter (SIGNUP_MAX_ATTEMPTS) from this same local IP --
  // that limiter is doing its real job, not a bug, but it shouldn't block
  // iterating on this specific suite. Same reset api-tests.mjs's own
  // resetRateLimits() does for the same reason.
  db.prepare(`DELETE FROM rate_limit_attempts`).run();
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
  await closeReal(data.order.brokerOrderId);
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
  await closeReal(data.order.brokerOrderId);
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
  await closeReal(data.order.brokerOrderId);
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
  // The server computes the raw, unrounded midpoint (see secureHalfForOrder)
  // -- comparing with an epsilon rather than strict equality, since
  // Math.round(...*100000)/100000 on the test's side can legitimately differ
  // from the server's raw float in the last decimal (e.g. 1.17067 vs
  // 1.1706699999999999), which is not a real discrepancy.
  const expected = entry + (tp1 - entry) * 0.5;
  assert.ok(Math.abs(data.newTakeProfit - expected) < 0.00001, `reported newTakeProfit ${data.newTakeProfit} should match expected ${expected}`);
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  assert.ok(Math.abs(real.takeProfit - expected) < 0.0001, `real broker TP ${real.takeProfit} should match expected ${expected}`);
  await closeReal(brokerOrderId);
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
  // Compared against realSl (the REAL stop the broker actually set at open),
  // not seededSl (a fictional test input) -- seededSl is deliberately far
  // wider than any real stop this scenario would produce, so comparing
  // against it would pass trivially regardless of whether anything moved.
  assert.ok(real.stopLoss < realSl, `the new stop (${real.stopLoss}) should improve on the REAL initial stop (${realSl})`);
  await closeReal(brokerOrderId);
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
  // Compared against realSl, the REAL stop set at open -- see the identical
  // note on the secure-half profit test above.
  assert.ok(real.stopLoss < realSl, `scheduler should have moved the stop favorably (real initial ${realSl}, now ${real.stopLoss})`);
  const dbRow = db.prepare(`SELECT trailing_stop_price FROM trade_orders WHERE broker_order_id = ?`).get(brokerOrderId);
  assert.ok(Math.abs(dbRow.trailing_stop_price - real.stopLoss) < 0.0001, "our own DB record should match the real broker stop the scheduler set");
  await closeReal(brokerOrderId);
});

test("secure-half priority: turning the toggle ON retroactively halves an already-open fixed-TP position", { skip: !hasSecrets }, async () => {
  const price = await getRealPrice("EURUSD");
  const entry = price.ask;
  const sl = Math.round((entry - 0.0030) * 100000) / 100000;
  const tp1 = Math.round((entry + 0.0050) * 100000) / 100000;
  const brokerOrderId = await openRealPosition({ direction: "ACHAT", symbol: "EURUSD", stopLoss: sl, takeProfit: tp1 });
  seedOrder({ pair: "EUR/USD", direction: "ACHAT", entry, sl, tp1, status: "SENT", brokerOrderId });
  const { data } = await postJson("/api/auto-trade/toggle-secure-half", { enabled: true });
  assert.equal(data.ok, true, JSON.stringify(data));
  assert.ok(data.securedCount >= 1, `expected at least 1 position secured, got ${data.securedCount}`);
  const expected = Math.round((entry + (tp1 - entry) * 0.5) * 100000) / 100000;
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  assert.ok(Math.abs(real.takeProfit - expected) < 0.0001, `real broker TP ${real.takeProfit} should match expected ${expected} after toggling on`);
  await closeReal(brokerOrderId);
});

test("secure-half priority: with the toggle on, the scheduler locks the stop once price has reached halfway to the reference target (tp2)", { skip: !hasSecrets }, async () => {
  // Toggle already ON from the previous test, but explicit here so this test
  // is self-contained regardless of run order.
  await postJson("/api/auto-trade/toggle-secure-half", { enabled: true });

  const price = await getRealPrice("EURUSD");
  const realAsk = price.ask;
  const realEntry = price.bid;
  const realSl = Math.round((realEntry + 0.0030) * 100000) / 100000;
  const brokerOrderId = await openRealPosition({ direction: "VENTE", symbol: "EURUSD", stopLoss: realSl, takeProfit: undefined });
  // Seeded so the halfway point (between seededEntry and tp2) sits ~25 pips
  // ABOVE the real current ask -- i.e. already comfortably "reached" for a
  // SELL (whose close side is ask) the moment the scheduler looks, with
  // margin against normal tick noise between this fetch and its own.
  const seededEntry = Math.round((realAsk + 0.0060) * 100000) / 100000;
  const seededSl = Math.round((seededEntry + 0.0030) * 100000) / 100000;
  const tp2 = Math.round((realAsk - 0.0010) * 100000) / 100000;
  const { orderId } = seedOrder({ pair: "EUR/USD", direction: "VENTE", entry: seededEntry, sl: seededSl, tp1: null, status: "SENT", brokerOrderId, trailingStopPrice: seededSl, bestFavorablePrice: seededEntry });
  db.prepare(`UPDATE trade_orders SET tp2 = ? WHERE id = ?`).run(tp2, orderId);

  await new Promise((r) => setTimeout(r, 7000));
  const positions = await getRealPositions();
  const real = positions.find((p) => String(p.id) === brokerOrderId);
  assert.ok(real, "position should still be open at the broker");
  // Compared against realSl, the REAL stop set at open -- seededSl is a
  // fictional test input, deliberately far wider than any real stop this
  // scenario would produce, so comparing against it would pass trivially
  // (found live: the first version of this test did exactly that, and
  // silently proved nothing).
  assert.ok(real.stopLoss < realSl, `half-target lock should have moved the stop favorably (real initial ${realSl}, now ${real.stopLoss})`);
  const dbRow = db.prepare(`SELECT trailing_stop_price, half_target_secured FROM trade_orders WHERE broker_order_id = ?`).get(brokerOrderId);
  assert.equal(dbRow.half_target_secured, 1, "half_target_secured should be marked so this never re-triggers");
  assert.ok(Math.abs(dbRow.trailing_stop_price - real.stopLoss) < 0.0001, "our own DB record should match the real broker stop");
  await closeReal(brokerOrderId);
});
