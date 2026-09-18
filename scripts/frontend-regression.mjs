// Contract checks for the Kronos Oracle Pulse. Node-only by design: they run in CI
// without a browser and protect page wiring, data integrity, accessibility and the
// fail-closed behaviour that prevents stale prices from looking like live context.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(rootDir, path), "utf8");
const [home, script, styles] = await Promise.all([
  read("index.html"),
  read("assets/kronos-pulse.js"),
  read("assets/oracle-extras.css"),
]);

function expect(label, condition) {
  assert.ok(condition, label);
  console.log(`PASS - ${label}`);
}

console.log("=== Kronos Oracle Pulse: front-end regression contract ===");

expect("homepage contains the unique Pulse landmark", /<section id="kronos-pulse"[^>]*aria-labelledby="kronos-pulse-title"/.test(home));
expect("Pulse remains inside the document body", home.indexOf('id="kronos-pulse"') < home.indexOf("</body>"));
expect("Pulse is loaded after the live-price producer", home.indexOf('src="/assets/kronos-live.js"') < home.indexOf('src="/assets/kronos-pulse.js"'));
expect("Pulse script is loaded before the closing body tag", home.indexOf('src="/assets/kronos-pulse.js"') < home.indexOf("</body>"));
expect("Pulse keeps an accessible live region for market-state changes", /data-pulse-state aria-live="polite"/.test(home));
expect("Pulse keeps an accessible disclosure control", /data-pulse-details-toggle aria-expanded="false" aria-controls="pulse-method"/.test(home));
expect("all four monitored instruments retain stable data hooks", ["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"].every((symbol) => home.includes(`data-pulse-instrument="${symbol}"`)));

expect("Pulse listens to the shared verified price event", script.includes('window.addEventListener("oracle:prices", (event) => render(event.detail))'));
expect("Pulse reads the existing verified price payload", script.includes("window.__oraclePricesPayload") && script.includes("payload?.prices"));
expect("Pulse requires the server trust marker", script.includes("price.trustworthy === true"));
expect("Pulse fails closed when fewer than two sources are fresh", script.includes("const minReadableSources = 2") && script.includes("fresh.length < minReadableSources"));
expect("Pulse has an explicit stale/closed quote guard", script.includes("price.open && !price.stale"));
expect("manual refresh is time-bounded", script.includes("AbortSignal.timeout(9000)"));
expect("Pulse does not generate decorative random market data", !script.includes("Math.random"));
expect("Pulse writes API values as text, not interpolated HTML", script.includes("node.textContent = value") && !script.includes("innerHTML"));

expect("Pulse styles include a reduced-motion-safe animation gate", styles.includes("@media (prefers-reduced-motion: no-preference)") && styles.includes(".kronos-pulse__live-dot"));
expect("Pulse has a small-screen layout", styles.includes("@media (max-width: 640px)") && styles.includes(".kronos-pulse__instrument-grid"));
expect("Pulse marks available directions distinctly", styles.includes('.kronos-pulse__instrument[data-state="up"]') && styles.includes('.kronos-pulse__instrument[data-state="down"]'));

function element() {
  const attributes = new Map();
  const listeners = new Map();
  return {
    attributes,
    dataset: {},
    disabled: false,
    hidden: false,
    listeners,
    style: { setProperty(name, value) { this[name] = String(value); } },
    textContent: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
  };
}

function createPulseHarness() {
  const pulseRoot = element();
  const ui = new Map([
    ["[data-pulse-ring]", element()],
    ["[data-pulse-score]", element()],
    ["[data-pulse-confidence]", element()],
    ["[data-pulse-state]", element()],
    ["[data-pulse-summary]", element()],
    ["[data-pulse-generated]", element()],
    ["[data-pulse-sources]", element()],
    ["[data-pulse-consensus]", element()],
    ["[data-pulse-volatility]", element()],
    ["[data-pulse-refresh]", element()],
    ["[data-pulse-details]", element()],
    ["[data-pulse-details-toggle]", element()],
  ]);
  const cards = new Map();
  for (const symbol of ["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"]) {
    const card = element();
    const price = element();
    const change = element();
    card.querySelector = (selector) => selector === "strong" ? price : selector === "em" ? change : null;
    cards.set(symbol, { card, price, change });
  }
  pulseRoot.querySelector = (selector) => {
    const instrument = selector.match(/^\[data-pulse-instrument="(.+)"\]$/);
    if (instrument) return cards.get(instrument[1])?.card ?? null;
    return ui.get(selector) ?? null;
  };

  let priceListener = null;
  const window = {
    __oraclePricesPayload: null,
    addEventListener(type, listener) { if (type === "oracle:prices") priceListener = listener; },
  };
  vm.runInNewContext(script, {
    AbortSignal: { timeout: () => ({}) },
    Boolean,
    Date,
    Math,
    Number,
    String,
    document: { querySelector: (selector) => selector === "[data-kronos-pulse]" ? pulseRoot : null },
    fetch: async () => { throw new Error("fetch should not run in a price-event test"); },
    window,
  });
  assert.equal(typeof priceListener, "function", "Pulse must subscribe to oracle:prices");
  return {
    cards,
    pulseRoot,
    ui,
    dispatch(payload) { priceListener({ detail: payload }); },
  };
}

const reliableQuote = (price, change, extra = {}) => ({
  price,
  change,
  open: true,
  stale: false,
  trustworthy: true,
  ...extra,
});

const unavailableHarness = createPulseHarness();
unavailableHarness.dispatch({
  prices: {
    "EUR/USD": reliableQuote(1.085, 0.2, { stale: true }),
    "XAU/USD": reliableQuote(2350, 0.4, { trustworthy: false }),
  },
});
expect("stale or untrusted data fails closed at runtime", unavailableHarness.pulseRoot.dataset.ready === "false" && unavailableHarness.ui.get("[data-pulse-score]").textContent === "--");
expect("untrusted quotes are visibly unavailable", unavailableHarness.cards.get("XAU/USD").card.dataset.state === "unavailable");

const liveHarness = createPulseHarness();
liveHarness.dispatch({
  generatedAt: "2026-09-18T09:30:00.000Z",
  prices: {
    "EUR/USD": reliableQuote(1.085, 0.2),
    "XAU/USD": reliableQuote(2350.4, 0.4),
    "GBP/JPY": reliableQuote(201.5, -0.1, { trustworthy: false }),
    "BTC/USD": reliableQuote(65000, 1.2, { stale: true }),
  },
});
expect("two server-trusted fresh sources enable a context reading", liveHarness.pulseRoot.dataset.ready === "true" && /^\d+$/.test(liveHarness.ui.get("[data-pulse-score]").textContent));
expect("trusted data is rendered with the expected quote formatting", liveHarness.cards.get("EUR/USD").price.textContent === "1.0850" && liveHarness.cards.get("XAU/USD").price.textContent === "2350.4");
expect("source count excludes stale and untrusted quotes", liveHarness.ui.get("[data-pulse-sources]").textContent === "2 / 4");
expect("score ring is updated alongside the visible score", liveHarness.ui.get("[data-pulse-ring]").style["--pulse-score"] === liveHarness.ui.get("[data-pulse-score]").textContent);

console.log("Pulse front-end contract passed.");
