(() => {
  "use strict";

  // Uses the same verified /api/prices payload as kronos-live.js. No quote or
  // conclusion is manufactured when a source is closed, stale or untrusted.
  const symbols = ["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"];
  const minReadableSources = 2;
  const root = document.querySelector("[data-kronos-pulse]");
  if (!root) return;

  const ui = {
    ring: root.querySelector("[data-pulse-ring]"),
    score: root.querySelector("[data-pulse-score]"),
    confidence: root.querySelector("[data-pulse-confidence]"),
    state: root.querySelector("[data-pulse-state]"),
    summary: root.querySelector("[data-pulse-summary]"),
    generated: root.querySelector("[data-pulse-generated]"),
    sources: root.querySelector("[data-pulse-sources]"),
    consensus: root.querySelector("[data-pulse-consensus]"),
    volatility: root.querySelector("[data-pulse-volatility]"),
    refresh: root.querySelector("[data-pulse-refresh]"),
    details: root.querySelector("[data-pulse-details]"),
    detailsToggle: root.querySelector("[data-pulse-details-toggle]"),
  };

  const setText = (node, value) => { if (node) node.textContent = value; };
  const isFresh = (price) => Boolean(
    price && price.trustworthy === true && price.open && !price.stale && Number.isFinite(Number(price.price)),
  );

  function formatPrice(symbol, value) {
    const price = Number(value);
    if (!Number.isFinite(price)) return "--";
    if (symbol === "BTC/USD") return Math.round(price).toLocaleString("fr-FR");
    if (symbol === "XAU/USD") return price.toFixed(1);
    return price.toFixed(symbol.includes("JPY") ? 2 : 4);
  }

  function formatTimestamp(value) {
    const time = new Date(value || Date.now());
    return Number.isNaN(time.getTime())
      ? "Synchronisation en cours"
      : `Mis \u00e0 jour \u00e0 ${time.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function renderInstrument(symbol, price) {
    const card = root.querySelector(`[data-pulse-instrument="${symbol}"]`);
    if (!card) return;
    const fresh = isFresh(price);
    const change = Number(price?.change);
    card.dataset.state = fresh ? (change >= 0 ? "up" : "down") : "unavailable";
    setText(card.querySelector("strong"), fresh ? formatPrice(symbol, price.price) : "--");
    setText(card.querySelector("em"), fresh && Number.isFinite(change)
      ? `${change >= 0 ? "+" : ""}${change.toFixed(2)} %`
      : "Donn\u00e9e indisponible");
  }

  function renderUnavailable(prices = {}, generatedAt) {
    symbols.forEach((symbol) => renderInstrument(symbol, prices[symbol]));
    root.setAttribute("aria-busy", "false");
    root.dataset.ready = "false";
    ui.ring?.style.setProperty("--pulse-score", "0");
    setText(ui.score, "--");
    setText(ui.confidence, "Donn\u00e9es insuffisantes");
    setText(ui.state, "Contexte non confirm\u00e9");
    setText(ui.summary, "Kronos attend au moins deux sources ouvertes, fra\u00eeches et fiables avant de proposer une lecture de march\u00e9.");
    setText(ui.sources, `${symbols.filter((symbol) => isFresh(prices[symbol])).length} / ${symbols.length}`);
    setText(ui.consensus, "--");
    setText(ui.volatility, "--");
    setText(ui.generated, generatedAt ? formatTimestamp(generatedAt) : "Donn\u00e9es march\u00e9 indisponibles");
  }

  function render(payload) {
    const prices = payload?.prices || {};
    const fresh = symbols.map((symbol) => ({ symbol, price: prices[symbol] })).filter(({ price }) => isFresh(price));
    symbols.forEach((symbol) => renderInstrument(symbol, prices[symbol]));
    const changes = fresh.map(({ price }) => Number(price.change)).filter(Number.isFinite);

    if (fresh.length < minReadableSources || changes.length < minReadableSources) {
      renderUnavailable(prices, payload?.generatedAt);
      return;
    }

    const upward = changes.filter((change) => change > 0).length;
    const downward = changes.filter((change) => change < 0).length;
    const consensus = Math.max(upward, downward) / changes.length;
    const averageMove = changes.reduce((total, change) => total + Math.abs(change), 0) / changes.length;
    const freshness = fresh.length / symbols.length;
    // Context clarity, never a buy/sell score. A single volatile quote cannot
    // create a high reading because freshness and breadth are both required.
    const clarity = Math.round(Math.min(100, 35 + freshness * 25 + consensus * 28 + Math.min(1, averageMove / 0.5) * 12));
    const dominant = upward === downward ? "partag\u00e9" : upward > downward ? "acheteur" : "vendeur";
    const directional = consensus >= 0.75;

    root.setAttribute("aria-busy", "false");
    root.dataset.ready = "true";
    ui.ring?.style.setProperty("--pulse-score", String(clarity));
    setText(ui.score, String(clarity));
    setText(ui.confidence, clarity >= 75 ? "Contexte lisible" : "Contexte \u00e0 confirmer");
    setText(ui.state, directional ? `Flux ${dominant} dominant` : "March\u00e9 partag\u00e9");
    setText(ui.summary, directional
      ? `${Math.round(consensus * 100)} % des instruments disponibles \u00e9voluent dans le m\u00eame sens. Utilise cette lecture comme contexte, jamais comme ordre.`
      : "Les variations disponibles ne convergent pas suffisamment. La prudence et la s\u00e9lection du setup priment.");
    setText(ui.sources, `${fresh.length} / ${symbols.length}`);
    setText(ui.consensus, directional ? `${Math.round(consensus * 100)} % ${dominant}` : "Fragment\u00e9");
    setText(ui.volatility, `${averageMove.toFixed(2)} %`);
    setText(ui.generated, formatTimestamp(payload?.generatedAt));
  }

  async function refresh() {
    if (ui.refresh?.disabled) return;
    if (ui.refresh) { ui.refresh.disabled = true; ui.refresh.textContent = "Actualisation..."; }
    try {
      const response = await fetch("/api/prices", { signal: AbortSignal.timeout(9000) });
      const payload = response.ok ? await response.json() : null;
      if (payload?.prices) render(payload);
      else renderUnavailable(window.__oraclePricesPayload?.prices || {});
    } catch {
      renderUnavailable(window.__oraclePricesPayload?.prices || {});
    } finally {
      if (ui.refresh) { ui.refresh.disabled = false; ui.refresh.textContent = "Actualiser les donn\u00e9es"; }
    }
  }

  ui.refresh?.addEventListener("click", refresh);
  ui.detailsToggle?.addEventListener("click", () => {
    const expanded = ui.detailsToggle.getAttribute("aria-expanded") === "true";
    ui.detailsToggle.setAttribute("aria-expanded", String(!expanded));
    if (ui.details) ui.details.hidden = expanded;
  });
  window.addEventListener("oracle:prices", (event) => render(event.detail));
  if (window.__oraclePricesPayload?.prices) render(window.__oraclePricesPayload);
})();
