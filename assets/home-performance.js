(() => {
  document.addEventListener("DOMContentLoaded", refreshHomeMetrics);

  async function refreshHomeMetrics() {
    try {
      const response = await fetch("/api/performance");
      if (!response.ok) return;
      const data = await response.json();
      setMetric("precision", data.precisionAudited ? data.precisionLabel : "À auditer");
      setMetric("signals", String(data.activeSignals || data.totalAnalyses || 0));
      setMetric("members", data.membersLabel || "500+");
      setMetric("pairs", String(data.instrumentsTracked || 6));
      renderPerformance(data);
    } catch {
      setMetric("precision", "À auditer");
    }
  }

  function setMetric(name, value) {
    const node = document.querySelector(`[data-home-metric="${name}"]`);
    if (node) node.textContent = value;
  }

  function renderPerformance(data) {
    const panel = document.querySelector(".home-performance-panel");
    const grid = panel?.querySelector(".grid");
    if (!grid) return;
    if (!Array.isArray(data.recent) || !data.recent.length) {
      grid.innerHTML = `<div class="rounded border border-border bg-background/40 px-3 py-2 text-muted-foreground">Pas encore assez de signaux clôturés pour publier une performance réelle.</div>`;
      return;
    }
    grid.innerHTML = data.recent.slice(0, 8).map((item) => `
      <div class="flex items-center justify-between rounded border border-border bg-background/40 px-3 py-2">
        <span class="text-muted-foreground">${escapeHtml(item.pair)} · ${escapeHtml(item.style || "Style")}</span>
        <span class="${item.result === "win" ? "text-neon-green" : "text-neon-red"}">${item.result === "win" ? "TP1" : "SL"} · ${Number(item.score || 0)}%</span>
      </div>
    `).join("");
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
