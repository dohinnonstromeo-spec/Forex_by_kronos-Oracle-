(() => {
  const host = document.querySelector("[data-site-content-sections]");
  const loadButton = document.querySelector("[data-site-content-load]");
  const summary = document.querySelector("[data-site-content-summary]");
  const searchInput = document.querySelector("[data-site-content-search]");
  if (!host) return;

  function getToken() {
    const tokenInput = document.querySelector('[data-premium-admin-form] [name="token"]');
    return tokenInput?.value || "";
  }

  async function adminFetch(url, body = null) {
    const token = getToken();
    const options = { method: body ? "POST" : "GET", headers: { "X-Admin-Token": token } };
    if (body) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    try {
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
      return await response.json();
    } catch {
      return { ok: false, error: "network_error" };
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }

  loadButton?.addEventListener("click", load);
  searchInput?.addEventListener("input", filterContent);

  async function load() {
    if (loadButton?.disabled) return;
    if (!getToken()) {
      if (summary) summary.textContent = 'Renseigne le token admin avant de charger le contenu.';
      return;
    }
    if (loadButton) loadButton.disabled = true;
    if (summary) summary.textContent = 'Chargement du registre de contenu...';
    try {
      const [registryData, contentData] = await Promise.all([
        adminFetch('/api/admin/site-content/registry'),
        fetch('/api/site-content', { signal: AbortSignal.timeout(5000) }).then((r) => r.json()).catch(() => ({ ok: false })),
      ]);
      if (!registryData?.ok) {
        if (summary) summary.textContent = registryData?.message || registryData?.error || 'Chargement impossible -- verifie le token.';
        return;
      }
      const registry = Array.isArray(registryData.registry) ? registryData.registry : [];
      const overrides = contentData?.ok ? contentData.overrides : {};
      render(registry, overrides);
      if (searchInput) searchInput.disabled = false;
      if (summary) summary.textContent = registry.length + ' champ(s) de contenu, groupes par page.';
    } finally {
      if (loadButton) loadButton.disabled = false;
    }
  }

  function render(registry, overrides) {
    const byPage = new Map();
    for (const entry of registry) {
      if (!byPage.has(entry.page)) byPage.set(entry.page, []);
      byPage.get(entry.page).push(entry);
    }
    host.innerHTML = [...byPage.entries()].map(([page, entries]) => `
      <details class="site-content-page-group">
        <summary>${escapeHtml(page)} <span class="site-content-count">${entries.length} champ(s)</span></summary>
        <div class="site-content-fields">
          ${entries.map((entry) => `
            <div class="site-content-field" data-field-key="${escapeHtml(entry.key)}">
              <label>${escapeHtml(entry.label)}${entry.richText ? ` <span class="site-content-rich-badge">HTML autorisé</span>` : ""}</label>
              <textarea rows="2" data-field-input placeholder="(valeur par défaut du site -- non modifiée)">${escapeHtml(overrides[entry.key] || "")}</textarea>
              <div class="site-content-field-actions">
                <span class="site-content-field-status" data-field-status></span>
                <button type="button" data-field-reset ${overrides[entry.key] ? "" : "disabled"}>Réinitialiser</button>
              </div>
            </div>
          `).join("")}
        </div>
      </details>
    `).join("");

    filterContent();
    host.querySelectorAll("[data-field-key]").forEach((field) => {
      const key = field.dataset.fieldKey;
      const textarea = field.querySelector("[data-field-input]");
      const status = field.querySelector("[data-field-status]");
      const resetButton = field.querySelector("[data-field-reset]");

      let saveQueue = Promise.resolve();
      textarea.addEventListener("input", () => { status.textContent = "Modification en attente..."; });
      textarea.addEventListener("blur", () => {
        saveQueue = saveQueue.then(async () => {
          const value = textarea.value;
        status.textContent = "Enregistrement...";
        const data = await adminFetch("/api/admin/site-content/set", { key, value });
        if (!data?.ok) {
          status.textContent = data?.message || data?.error || "Échec.";
          return;
        }
        status.textContent = "✓ Enregistré";
        resetButton.disabled = !value;
        setTimeout(() => { if (status.textContent === "✓ Enregistré") status.textContent = ""; }, 3000);
        });
      });

      resetButton.addEventListener("click", async () => {
        resetButton.disabled = true;
        const data = await adminFetch("/api/admin/site-content/reset", { key });
        if (!data?.ok) {
          status.textContent = data?.message || data?.error || "Échec.";
          resetButton.disabled = false;
          return;
        }
        textarea.value = "";
        status.textContent = "✓ Réinitialisé (texte par défaut restauré)";
        setTimeout(() => { if (status.textContent.startsWith("✓")) status.textContent = ""; }, 3000);
      });
    });
  function filterContent() {
    if (!host) return;
    const query = String(searchInput?.value || '').trim().toLowerCase();
    let visibleFields = 0;
    host.querySelectorAll('.site-content-page-group').forEach((group) => {
      let groupVisible = false;
      group.querySelectorAll('[data-field-key]').forEach((field) => {
        const matches = !query || field.textContent.toLowerCase().includes(query) || String(field.dataset.fieldKey || '').toLowerCase().includes(query);
        field.hidden = !matches;
        if (matches) { groupVisible = true; visibleFields += 1; }
      });
      group.hidden = !groupVisible;
    });
    let empty = host.querySelector('[data-content-search-empty]');
    if (query && !visibleFields) {
      if (!empty) { empty = document.createElement('p'); empty.className = 'site-content-search-empty'; empty.dataset.contentSearchEmpty = 'true'; host.append(empty); }
      empty.textContent = 'Aucun champ ne correspond a cette recherche.';
    } else if (empty) empty.remove();
  }
  }
})();
