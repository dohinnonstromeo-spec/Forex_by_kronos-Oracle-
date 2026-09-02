(() => {
  const sparkHost = document.querySelector("[data-home-sparks]");
  const newsHost = document.querySelector("[data-home-news]");
  const clock = document.querySelector("[data-news-clock]");

  const fallbackNews = [
    { title: "DOLLAR STABLE AVANT DONNÉES MACRO US", asset: "USD", impact: "HIGH" },
    { title: "GOLD SURVEILLE UNE ZONE DE RÉSISTANCE", asset: "XAU", impact: "MED" },
    { title: "EURO ATTEND CATALYSEUR BCE CETTE SEMAINE", asset: "EUR", impact: "MED" },
    { title: "BITCOIN RESTE SENSIBLE AU SENTIMENT RISQUE", asset: "BTC", impact: "LOW" },
  ];

  boot();

  function boot() {
    renderFallbackSparks();
    window.addEventListener("oracle:prices", (event) => {
      renderSparksFromPayload(event.detail);
    });
    if (window.__oraclePricesPayload) {
      renderSparksFromPayload(window.__oraclePricesPayload);
    }
    scheduleVisiblePoll(refreshNews, 10 * 60 * 1000);
    scheduleVisiblePoll(tickClock, 1000);
  }

  function scheduleVisiblePoll(callback, intervalMs) {
    const tick = () => {
      if (document.visibilityState !== "hidden") callback();
    };
    tick();
    setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "hidden") callback();
    });
  }

  function renderSparksFromPayload(data) {
    if (!sparkHost || !data) return;
    const prices = data?.prices || {};
    const symbols = ["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"];
    renderSparks(symbols.map((pair, index) => {
      const item = prices[pair] || {};
      const price = Number(item.price || fallbackPrice(pair));
      const change = Number(item.change || (index % 2 ? -0.18 : 0.32));
      return {
        pair,
        price,
        change,
        source: item.source || "fallback visuel",
        stale: item.stale,
        series: makeSeries(price, change, index),
      };
    }));
  }

  function renderFallbackSparks() {
    if (!sparkHost) return;
    renderSparks(["EUR/USD", "XAU/USD", "GBP/JPY", "BTC/USD"].map((pair, index) => ({
      pair,
      price: fallbackPrice(pair),
      change: index % 2 ? -0.18 : 0.32,
      source: "chargement",
      stale: true,
      series: makeSeries(fallbackPrice(pair), index % 2 ? -0.18 : 0.32, index),
    })));
  }

  function renderSparks(items) {
    sparkHost.innerHTML = items.map((item) => {
      const up = item.change >= 0;
      return `<article class="home-spark-card">
        <div class="home-spark-top">
          <div>
            <div class="home-spark-pair">${escapeHtml(item.pair)}</div>
            <div class="home-spark-price">${formatPrice(item.pair, item.price)}</div>
          </div>
          <span class="home-spark-change ${up ? "up" : "down"}">${up ? "▲" : "▼"} ${Math.abs(item.change).toFixed(2)}%</span>
        </div>
        ${sparkSvg(item.series, up)}
        <div class="home-spark-bottom">
          <span>${escapeHtml(item.source)}</span>
          <span>${item.stale ? "Indicatif" : "Live"}</span>
        </div>
      </article>`;
    }).join("");
  }

  async function refreshNews() {
    if (!newsHost) return;
    const data = await getJson("/api/news?symbol=EURUSD", 9000);
    const rows = Array.isArray(data?.news) && data.news.length
      ? data.news.slice(0, 6).map(normalizeNews)
      : fallbackNews.map((item) => ({ ...item, time: nowShort() }));
    newsHost.innerHTML = rows.map((item) => `
      <li>
        <span>${escapeHtml(item.time)}</span>
        <strong>${escapeHtml(item.title)}</strong>
        <em>${escapeHtml(item.asset)}</em>
        <b>${escapeHtml(item.impact)}</b>
      </li>
    `).join("");
  }

  function normalizeNews(item) {
    const title = item.title || item.headline || item.description || "Actualité marché";
    const published = item.published_at || item.publishedAt || item.date;
    return {
      time: published ? formatNewsTime(published) : nowShort(),
      title: title.toUpperCase().slice(0, 72),
      asset: inferAsset(title),
      impact: inferImpact(title),
    };
  }

  function sparkSvg(values, up) {
    const width = 220;
    const height = 72;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    const step = width / (values.length - 1);
    const points = values.map((value, index) => [index * step, height - ((value - min) / range) * (height - 10) - 5]);
    const path = points.map(([x, y], index) => `${index ? "L" : "M"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const area = `${path} L ${width} ${height} L 0 ${height} Z`;
    const color = up ? "var(--neon-green)" : "var(--neon-red)";
    return `<svg class="home-spark-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Mini graphique">
      <path class="home-spark-area" d="${area}" fill="${color}"></path>
      <path class="home-spark-line" d="${path}" style="color:${color};stroke:${color}"></path>
    </svg>`;
  }

  function makeSeries(price, change, seed) {
    const start = price / (1 + change / 100 || 1);
    return Array.from({ length: 14 }, (_, index) => {
      const progress = index / 13;
      const wave = Math.sin((index + seed) * 1.25) * price * 0.0008;
      return start + (price - start) * progress + wave;
    });
  }

  function tickClock() {
    if (clock) clock.textContent = new Intl.DateTimeFormat("fr-FR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
  }

  async function getJson(url, timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  function fallbackPrice(pair) {
    return ({ "EUR/USD": 1.0847, "XAU/USD": 2312.4, "GBP/JPY": 193.45, "BTC/USD": 67840 })[pair] || 1;
  }

  function formatPrice(pair, value) {
    if (/BTC/i.test(pair)) return Math.round(value).toLocaleString("fr-FR");
    if (/XAU/i.test(pair)) return Number(value).toFixed(2);
    if (/JPY/i.test(pair)) return Number(value).toFixed(3);
    return Number(value).toFixed(5);
  }

  function inferAsset(title) {
    const text = String(title).toUpperCase();
    if (/GOLD|XAU/.test(text)) return "XAU";
    if (/BITCOIN|BTC/.test(text)) return "BTC";
    if (/EURO|ECB|EUR/.test(text)) return "EUR";
    if (/YEN|JPY|BOJ/.test(text)) return "JPY";
    if (/POUND|GBP|BOE/.test(text)) return "GBP";
    return "USD";
  }

  function inferImpact(title) {
    return /FED|CPI|NFP|FOMC|RATE|INFLATION|JOBS/i.test(title) ? "HIGH" : /ECB|BOE|BOJ|GDP|PMI/i.test(title) ? "MED" : "LOW";
  }

  function formatNewsTime(value) {
    try {
      return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
    } catch {
      return nowShort();
    }
  }

  function nowShort() {
    return new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    }[char]));
  }
})();
