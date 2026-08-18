(() => {
  document.addEventListener("DOMContentLoaded", refreshHomeMetrics);
  // Sole owner of /api/performance rendering on the home page -- kronos-live.js
  // used to also fetch and render this same panel (via fragile h3-text matching)
  // every 5 minutes, racing this file to overwrite the same DOM node with a
  // different, less complete template. Removed there; the periodic refresh moved
  // here instead so the panel still stays fresh on a long-open tab.
  setInterval(refreshHomeMetrics, 5 * 60 * 1000);

  async function refreshHomeMetrics() {
    try {
      const response = await fetch("/api/performance", { signal: AbortSignal.timeout(3500) });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const data = await response.json();
      const publishablePrecision = data.precisionAudited && Number(data.precision) >= 55;
      setMetric("precision", publishablePrecision ? data.precisionLabel : "En audit");
      setMetric("signals", String(data.activeSignals || data.totalAnalyses || 0));
      setMetric("members", data.membersLabel || "0");
      setMetric("pairs", String(data.instrumentsTracked || 6));
      renderPerformance(data);
    } catch {
      // The static HTML fallback values were a fabricated-looking "500+ comptes
      // membres" -- fine as a loading placeholder for the ~1s until this resolves,
      // but if the fetch itself fails (network issue, slow connection, blocked
      // request) that fake number stayed on screen indefinitely instead of getting
      // corrected. Now the markup starts at "—" and only this catch path runs on
      // failure, so a failed fetch shows an honest "unavailable" state instead of a
      // stale fabricated one.
      // Same label as the "not yet publishable" success path above -- two different
      // phrasings for what reads to a visitor as the same "why is this blank"
      // question looked like a leaked internal dev note, confirmed by this
      // session's design audit.
      setMetric("precision", "En audit");
      setMetric("signals", "—");
      setMetric("members", "—");
      setMetric("pairs", "—");
      // The small metrics above were the only thing this catch ever touched -- the
      // full stats/chart/recent panel (renderPerformance) was left showing its
      // static "Chargement..." placeholder forever on a failed fetch, with no
      // retry and no visible failure state, confirmed live this session's audit.
      showPanelError();
    }
  }

  function showPanelError() {
    const panel = document.querySelector(".home-performance-panel");
    if (!panel) return;
    const message = `<div class="rounded border border-border bg-background/40 px-3 py-2 text-muted-foreground">Performance indisponible pour l'instant -- nouvelle tentative dans quelques minutes.</div>`;
    const stats = panel.querySelector(".home-performance-stats");
    const chart = panel.querySelector(".home-performance-chart");
    if (stats && !stats.children.length) stats.innerHTML = message;
    if (chart && !chart.children.length) chart.innerHTML = message;
  }

  function setMetric(name, value) {
    const node = document.querySelector(`[data-home-metric="${name}"]`);
    if (node) node.textContent = value;
  }

  function renderPerformance(data) {
    const panel = document.querySelector(".home-performance-panel");
    if (!panel) return;
    renderStats(panel, data);
    renderEquityChart(panel, data);
    renderRecent(panel, data);
  }

  // Winrate is not the number that determines whether Kronos is profitable
  // (see scripts/backtest.mjs: 38.6% winrate, +0.048R expectancy, still
  // net positive) -- expectancy (R moyen) leads here, winrate is secondary.
  function renderStats(panel, data) {
    const grid = panel.querySelector(".home-performance-stats");
    if (!grid) return;
    const n = Number(data.closedAnalyses || 0);
    const confidenceLabel = data.precisionConfidenceLabel || "aucune donnée";
    if (!n) {
      grid.innerHTML = statCell("Aucune donnée pour l'instant: Kronos n'a pas encore de signal clôturé à mesurer.");
      return;
    }
    const avgR = Number.isFinite(data.avgR) ? data.avgR : null;
    grid.innerHTML = [
      stat("Winrate", data.precision !== null ? `${data.precision}%` : "—", confidenceLabel),
      stat("R moyen / trade", avgR !== null ? `${avgR >= 0 ? "+" : ""}${avgR}R` : "—", "expectancy réelle"),
      stat("Échantillon", `n=${n}`, confidenceLabel),
      stat("Signaux actifs", String(data.activeSignals || 0), "en cours de suivi"),
    ].join("");
  }

  function stat(label, value, sub) {
    return `<div class="home-stat-cell">
      <div class="text-muted-foreground">${escapeHtml(label)}</div>
      <div class="text-base text-foreground">${escapeHtml(value)}</div>
      <div class="text-muted-foreground">${escapeHtml(sub)}</div>
    </div>`;
  }

  function statCell(text) {
    return `<div class="rounded border border-border bg-background/40 px-3 py-2 text-muted-foreground">${escapeHtml(text)}</div>`;
  }

  function renderEquityChart(panel, data) {
    const host = panel.querySelector(".home-performance-chart");
    if (!host) return;
    const points = Array.isArray(data.equityCurve) ? data.equityCurve : [];
    if (points.length < 2) {
      host.innerHTML = `<div class="rounded border border-border bg-background/40 px-3 py-2 text-muted-foreground">Courbe de performance en construction: il faut au moins 2 signaux clôturés pour tracer une tendance. Actuellement: ${points.length}.</div>`;
      return;
    }
    const last = points.at(-1).cumulativeR;
    host.innerHTML = `
      <div class="flex items-center justify-between text-xs text-muted-foreground mb-1">
        <span>Courbe R cumulé (${points.length} trades clôturés, mesurés — pas une projection)</span>
        <span class="${last >= 0 ? "text-neon-green" : "text-neon-red"}">${last >= 0 ? "+" : ""}${last}R au total</span>
      </div>
      ${equityCurveSvg(points)}
    `;
  }

  function equityCurveSvg(points) {
    const width = 640;
    const height = 140;
    const pad = 8;
    const values = points.map((p) => p.cumulativeR);
    const min = Math.min(0, ...values);
    const max = Math.max(0, ...values);
    const range = max - min || 1;
    const step = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
    const y = (value) => height - pad - ((value - min) / range) * (height - pad * 2);
    const coords = values.map((value, index) => [pad + index * step, y(value)]);
    const path = coords.map(([x, cy], index) => `${index ? "L" : "M"} ${x.toFixed(1)} ${cy.toFixed(1)}`).join(" ");
    const area = `${path} L ${(pad + (values.length - 1) * step).toFixed(1)} ${height - pad} L ${pad} ${height - pad} Z`;
    const zeroY = y(0);
    const up = values.at(-1) >= 0;
    const color = up ? "var(--neon-green)" : "var(--neon-red)";
    return `<svg viewBox="0 0 ${width} ${height}" class="home-equity-chart" role="img" aria-label="Courbe de performance cumulée en unités de risque R">
      <line x1="${pad}" y1="${zeroY.toFixed(1)}" x2="${width - pad}" y2="${zeroY.toFixed(1)}" stroke="rgba(255,255,255,.18)" stroke-dasharray="4 4"></line>
      <path d="${area}" fill="${color}" opacity="0.14"></path>
      <path d="${path}" fill="none" stroke="${color}" stroke-width="2"></path>
    </svg>`;
  }

  function renderRecent(panel, data) {
    const host = panel.querySelector(".home-performance-recent");
    if (!host) return;
    if (!Array.isArray(data.recent) || !data.recent.length) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = data.recent.slice(0, 8).map((item) => {
      const win = item.result === "win";
      const r = Number.isFinite(item.rMultiple) ? `${item.rMultiple >= 0 ? "+" : ""}${item.rMultiple}R` : (win ? "TP" : "SL");
      return `
      <div class="flex items-center justify-between rounded border border-border bg-background/40 px-3 py-2 text-xs">
        <span class="text-muted-foreground">${escapeHtml(item.pair)} · ${escapeHtml(item.style || "Style")}</span>
        <span class="${win ? "text-neon-green" : "text-neon-red"}">${escapeHtml(r)} · score ${Number(item.score || 0)}%</span>
      </div>`;
    }).join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
