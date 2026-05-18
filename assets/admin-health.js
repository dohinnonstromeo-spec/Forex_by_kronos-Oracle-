(() => {
  document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#refreshHealth")?.addEventListener("click", render);
    render();
    setInterval(render, 60 * 1000);
  });

  async function render() {
    const output = document.querySelector("#healthOutput");
    if (!output) return;
    output.innerHTML = `<div class="analysis-signal-card">Chargement santé Kronos...</div>`;
    const health = await getJson("/api/health");
    if (!health) {
      output.innerHTML = `<div class="analysis-signal-card"><div class="signal-pair">API santé indisponible</div></div>`;
      return;
    }
    const providers = Object.entries(health.providers || {});
    const priceRows = Object.entries(health.cache?.prices || {});
    const historyRows = Object.entries(health.cache?.histories || {});
    output.innerHTML = `
      <article class="analysis-signal-card">
        <div class="signal-top">
          <div><div class="signal-pair">${escapeHtml(health.market?.forex?.label || "Marché inconnu")}</div></div>
          <span class="oracle-tech">${escapeHtml(health.market?.newYorkTime || "")}</span>
        </div>
      </article>
      <article class="analysis-signal-card">
        <div class="signal-pair">Providers</div>
        ${providers.length ? providers.map(([name, item]) => `
          <div class="signal-bottom"><span>${escapeHtml(name)}</span><strong>${escapeHtml(item.status || "n/a")} · OK ${item.ok || 0} / Fail ${item.fail || 0}</strong></div>
        `).join("") : `<p class="mt-2 text-sm text-muted-foreground">Aucun provider testé depuis le dernier redémarrage.</p>`}
      </article>
      <article class="analysis-signal-card">
        <div class="signal-pair">Cache prix</div>
        ${priceRows.map(([symbol, item]) => `<div class="signal-bottom"><span>${escapeHtml(symbol)}</span><strong>${item.cached ? escapeHtml(item.source || "cache") : "vide"}</strong></div>`).join("")}
      </article>
      <article class="analysis-signal-card">
        <div class="signal-pair">Cache historiques</div>
        ${historyRows.map(([symbol, item]) => `<div class="signal-bottom"><span>${escapeHtml(symbol)}</span><strong>${item.bars || 0} barres</strong></div>`).join("")}
      </article>
      <article class="analysis-signal-card">
        <div class="signal-pair">Apprentissage</div>
        <div class="signal-bottom"><span>Analyses</span><strong>${health.learning?.totalAnalyses || 0}</strong></div>
        <div class="signal-bottom"><span>Winrate</span><strong>${health.learning?.globalWinRate ?? "non mesuré"}</strong></div>
      </article>
      <article class="analysis-signal-card">
        <div class="signal-pair">Recommandations</div>
        ${(health.recommendations || []).map((item) => `<p class="mt-2 text-sm text-muted-foreground">${escapeHtml(item)}</p>`).join("")}
      </article>
    `;
  }

  async function getJson(url) {
    try {
      const response = await fetch(url);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
