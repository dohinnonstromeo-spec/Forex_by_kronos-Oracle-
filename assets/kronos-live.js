(() => {
  const state = {
    prices: {},
    signals: [],
    generatedAt: null,
    nextSignalAt: nextQuarter(),
  };

  const marketSymbols = ["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"];

  boot();

  async function boot() {
    injectStyles();
    await updatePrices();
    await updateSignals();
    wireNewsSummaries();
    setInterval(updateCountdowns, 1000);
    setInterval(updatePrices, 60000);
    setInterval(updateSignals, 15 * 60 * 1000);
    setInterval(updateSignalScores, 5 * 60 * 1000);
  }

  async function updatePrices() {
    const data = await getJson("/api/prices");
    if (!data?.prices) {
      updateMarketBanner(null, null, "API marché indisponible");
      return;
    }
    updateMarketBanner(data.market, data.prices);

    for (const symbol of marketSymbols) {
      const next = data.prices[symbol];
      if (!next) continue;
      const previous = state.prices[symbol]?.price;
      state.prices[symbol] = next;
      renderMarket(symbol, next);

      if (previous && Math.abs(((next.price - previous) / previous) * 100) >= 0.1) {
        renderLiveComment(symbol, previous, next.price);
      }
    }
  }

  async function updateSignals() {
    const data = await getJson("/api/signals");
    const signals = Array.isArray(data?.signals) ? data.signals : [];
    if (!signals.length) {
      updateMarketBanner(null, null, "API signaux indisponible");
      return;
    }
    state.signals = signals;
    state.generatedAt = data.generatedAt ? new Date(data.generatedAt) : new Date();
    state.nextSignalAt = new Date(Date.now() + 15 * 60 * 1000);
    updateMarketBanner(data.market, state.prices);
    renderSignals(signals);
    updateCountdowns();
  }

  async function updateSignalScores() {
    for (const signal of state.signals) {
      const price = state.prices[signal.paire]?.price;
      if (!price) continue;
      const changePercent = (((price - Number(signal.entree)) / Number(signal.entree)) * 100).toFixed(2);
      const score = await postJson("/api/confidence", {
        pair: signal.paire,
        direction: signal.direction,
        entry: signal.entree,
        current: price,
        changePercent,
      });
      const card = document.querySelector(`[data-kronos-pair="${cssEscape(signal.paire)}"]`);
      if (!card || !score) continue;
      const scoreEl = card.querySelector("[data-kronos-score]");
      const barEl = card.querySelector("[data-kronos-bar]");
      const badgeEl = card.querySelector("[data-kronos-status]");
      if (scoreEl) scoreEl.innerHTML = flap(String(Math.round(score.score || signal.confiance)));
      if (barEl) barEl.style.width = `${Math.max(0, Math.min(100, Number(score.score) || 0))}%`;
      if (badgeEl) {
        badgeEl.textContent = Number(score.score) < 20 ? "SIGNAL ANNULÉ" : Number(score.score) < 40 ? "SIGNAL FAIBLIT" : score.statut || "FORT";
        badgeEl.className = `kronos-status ${Number(score.score) < 40 ? "danger" : ""}`;
      }
    }
  }

  function renderMarket(symbol, price) {
    const pairEl = [...document.querySelectorAll(".font-mono.text-xs.text-muted-foreground")]
      .find((node) => node.textContent.trim() === symbol);
    if (!pairEl) return;
    const card = pairEl.closest(".flex.items-center.justify-between");
    const priceBox = pairEl.parentElement?.querySelector(".mt-1");
    const changeBox = card?.lastElementChild;
    if (priceBox) priceBox.innerHTML = `<span class="inline-flex">${flap(formatPrice(symbol, price.price))}</span>`;
    if (changeBox) {
      const up = Number(price.change) >= 0;
      changeBox.className = `font-mono text-sm ${up ? "text-neon-green" : "text-neon-red"}`;
      changeBox.textContent = price.open && !price.stale ? `${up ? "▲" : "▼"} ${Number(price.change).toFixed(2)}%` : "FERMÉ";
    }
    const staleText = price.open && !price.stale ? "" : price.source === "fallback" ? "Donnée fallback" : "Marché fermé";
    if (staleText && pairEl.parentElement && !pairEl.parentElement.querySelector(".kronos-source")) {
      pairEl.parentElement.insertAdjacentHTML("beforeend", `<div class="kronos-source">${staleText}</div>`);
    } else if (pairEl.parentElement?.querySelector(".kronos-source")) {
      pairEl.parentElement.querySelector(".kronos-source").textContent = staleText;
    }
  }

  async function renderLiveComment(symbol, previous, current) {
    const pairEl = [...document.querySelectorAll(".font-mono.text-xs.text-muted-foreground")]
      .find((node) => node.textContent.trim() === symbol);
    const holder = pairEl?.parentElement;
    if (!holder) return;
    const changePercent = (((current - previous) / previous) * 100).toFixed(2);
    const data = await postJson("/api/comment", { pair: symbol, previous, current, changePercent });
    const text = data?.comment || "Momentum confirmé par Kronos.";
    let comment = holder.querySelector(".kronos-type");
    if (!comment) {
      comment = document.createElement("div");
      comment.className = "kronos-type";
      holder.appendChild(comment);
    }
    typewrite(comment, text);
    setTimeout(() => comment.remove(), 30000);
  }

  function renderSignals(signals) {
    const section = document.querySelector("#signaux");
    const grid = section?.querySelector(".grid.gap-6.md\\:grid-cols-2, .grid.gap-6");
    if (!section || !grid) return;

    const titleRow = section.querySelector(".mb-12");
    if (titleRow && !titleRow.querySelector(".kronos-generated")) {
      const badge = document.createElement("div");
      badge.className = "kronos-generated glass rounded-full px-4 py-2 text-xs font-mono";
      titleRow.appendChild(badge);
    }

    grid.innerHTML = signals.map(signalCard).join("");
  }

  function signalCard(signal) {
    const buy = signal.direction === "ACHAT";
    const score = Number(signal.confiance) || 0;
    const pair = escapeHtml(signal.paire);
    const suspended = signal.suspended || signal.direct === false;
    const suspendLabel = signal.open === false ? "⏸ MARCHÉ FERMÉ" : "⏸ NON VALIDÉ";
    return `<article data-kronos-pair="${escapeAttr(signal.paire)}" class="glass-card group relative overflow-hidden rounded-xl p-5 transition-all hover:border-amber-neon/40">
      <div class="flex items-start justify-between">
        <div>
          <div class="font-mono text-lg font-bold tracking-wider">${pair}</div>
          <div class="mt-1 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-widest ${suspended ? "bg-neon-orange/15 text-neon-orange" : buy ? "bg-neon-green/15 text-neon-green" : "bg-neon-red/15 text-neon-red"}">${suspended ? suspendLabel : `${buy ? "▲" : "▼"} ${escapeHtml(signal.direction)}`}</div>
        </div>
        <span data-kronos-status class="kronos-status ${suspended ? "danger" : ""}">${suspended ? "ANALYSE SUSPENDUE" : (score < 40 ? "SIGNAL FAIBLIT" : "LIVE")}</span>
      </div>
      ${suspended ? suspendedMetrics(signal) : activeMetrics(signal, score)}
      <p class="mt-3 text-xs text-muted-foreground">${escapeHtml(signal.raison || "Signal généré par Kronos.")}</p>
      <div class="mt-4 flex items-center justify-between border-t border-border pt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
        <div class="flex gap-1"><span class="rounded border border-amber-neon/30 px-1.5 py-0.5 text-amber-neon">${escapeHtml(signal.technique || "SMC")}</span></div>
        <button class="font-medium text-foreground hover:text-amber-neon">Partager →</button>
      </div>
    </article>`;
  }

  function metric(label, value, color = "text-foreground") {
    return `<div class="flex items-center justify-between"><span class="text-muted-foreground">${label}</span><span class="font-bold ${color}">${flap(String(value))}</span></div>`;
  }

  function activeMetrics(signal, score) {
    return `<div class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
      ${metric("Entrée", signal.entree)}
      ${metric("R:R", signal.rr, "text-amber-neon")}
      ${metric("SL", signal.sl, "text-neon-red")}
      ${metric("TP1", signal.tp1, "text-neon-green")}
      ${metric("TP2", signal.tp2, "text-neon-green")}
      <div class="flex items-center justify-between"><span class="text-muted-foreground">Confiance</span><span data-kronos-score class="font-bold text-amber-neon">${flap(String(score))}</span></div>
    </div>
    <div class="mt-4 h-1 overflow-hidden rounded-full bg-secondary"><div data-kronos-bar class="h-full bg-gradient-to-r from-amber-neon to-neon-orange" style="width:${score}%"></div></div>`;
  }

  function suspendedMetrics(signal) {
    return `<div class="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 font-mono text-xs">
      ${metric("Entrée", "Suspendue", "text-muted-foreground")}
      ${metric("R:R", "—", "text-muted-foreground")}
      ${metric("SL", "Suspendu", "text-muted-foreground")}
      ${metric("TP1", "Suspendu", "text-muted-foreground")}
      ${metric("TP2", "Suspendu", "text-muted-foreground")}
      ${metric("Reprise", signal.nextOpen ? "Ouverture" : "Donnée fraîche", "text-neon-orange")}
    </div>
    <div class="mt-4 h-1 overflow-hidden rounded-full bg-secondary"><div data-kronos-bar class="h-full bg-neon-red" style="width:0%"></div></div>`;
  }

  function updateCountdowns() {
    const remaining = Math.max(0, state.nextSignalAt.getTime() - Date.now());
    const minutes = String(Math.floor(remaining / 60000)).padStart(2, "0");
    const seconds = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
    const generated = state.generatedAt ? Math.max(0, Math.floor((Date.now() - state.generatedAt.getTime()) / 60000)) : 0;

    document.querySelectorAll(".kronos-generated").forEach((el) => {
      el.textContent = `⚡ Généré par Kronos il y a ${generated}min · prochain signal ${minutes}:${seconds}`;
    });

    [...document.querySelectorAll(".glass.rounded-full")]
      .filter((el) => el.textContent.includes("Prochain signal Kronos"))
      .forEach((el) => {
        const span = el.querySelector(".text-amber-neon");
        if (span) span.textContent = `${minutes}:${seconds}`;
      });
  }

  function updateMarketBanner(market, prices, fallbackText = "Statut marché indisponible") {
    const liveHeaders = [...document.querySelectorAll(".border-b.border-border.bg-background\\/40, .flex.items-center.gap-2.border-b")];
    const marketHeader = liveHeaders.find((el) => el.textContent.includes("Marchés en direct"));
    if (marketHeader && !market?.forex) {
      marketHeader.innerHTML = `<span class="h-2 w-2 rounded-full bg-neon-red pulse-dot"></span>${fallbackText}`;
      return;
    }
    if (marketHeader && market?.forex) {
      const anyLive = Object.values(prices || {}).some((price) => price.open && !price.stale);
      const text = anyLive ? "Marchés en direct" : market.forex.open ? "Marché ouvert · données non-live" : "Marchés fermés";
      const sources = [...new Set(Object.values(prices || {})
        .filter((price) => price?.source && price.source !== "static_fallback")
        .map((price) => sourceLabel(price.source)))].slice(0, 3);
      const sourceText = sources.length ? sources.join(" · ") : "sources indisponibles";
      marketHeader.innerHTML = `<span class="h-2 w-2 rounded-full ${anyLive ? "bg-neon-green" : "bg-neon-red"} pulse-dot"></span>${text} · ${sourceText}`;
    }
  }

  function sourceLabel(source) {
    return ({
      twelve_data: "Twelve Data",
      polygon: "Polygon",
      alpha_vantage: "Alpha Vantage",
      coinbase: "Coinbase",
      stooq: "Stooq",
      binance: "Binance",
      frankfurter_daily: "Frankfurter",
      exchangerate_api: "ExchangeRate",
    })[source] || source;
  }

  async function wireNewsSummaries() {
    const rows = [...document.querySelectorAll("#news li")].slice(0, 6);
    for (const row of rows) {
      const title = row.textContent.replace(/\s+/g, " ").trim();
      const firstCell = row.children[1];
      if (!firstCell || firstCell.dataset.kronosSummarized) continue;
      firstCell.dataset.kronosSummarized = "true";
      const data = await postJson("/api/news-summary", { title });
      if (data?.summary) firstCell.innerHTML = `<span class="inline-flex text-xs md:text-sm">${flap(data.summary.slice(0, 38))}</span>`;
    }
  }

  function flap(value) {
    return String(value).toUpperCase().split("").map((char, index) =>
      `<span class="flap flap-flip" style="animation-delay:${index * 30}ms">${char === " " ? "&nbsp;" : escapeHtml(char)}</span>`
    ).join("");
  }

  function typewrite(node, text) {
    node.textContent = "";
    let i = 0;
    const timer = setInterval(() => {
      node.textContent += text[i++] || "";
      if (i > text.length) clearInterval(timer);
    }, 18);
  }

  function nextQuarter() {
    return new Date(Date.now() + 15 * 60 * 1000);
  }

  function formatPrice(symbol, value) {
    if (symbol.includes("BTC") || symbol === "US500") return String(Math.round(value));
    if (symbol.includes("XAU")) return Number(value).toFixed(1);
    return Number(value).toFixed(symbol.includes("JPY") ? 2 : 4);
  }

  async function getJson(url) {
    try {
      const response = await fetch(url);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  async function postJson(url, body) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  function injectStyles() {
    const style = document.createElement("style");
    style.textContent = `
      .kronos-type { margin-top: .35rem; max-width: 13rem; color: var(--amber-neon); font-family: var(--font-mono); font-size: 10px; line-height: 1.35; }
      .kronos-status { border: 1px solid oklch(81% .16 78 / .35); color: var(--amber-neon); border-radius: 999px; padding: .15rem .45rem; font-family: var(--font-mono); font-size: 10px; letter-spacing: .08em; }
      .kronos-status.danger { border-color: oklch(66% .24 25 / .45); color: var(--neon-red); }
      .kronos-source { margin-top: .25rem; color: var(--neon-orange); font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; letter-spacing: .08em; }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function cssEscape(value) {
    return String(value).replace(/["\\]/g, "\\$&");
  }
})();
