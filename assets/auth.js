(() => {
  const form = document.querySelector("[data-auth-form]");
  const message = document.querySelector("[data-auth-message]");

  if (form) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const mode = form.dataset.authForm;
      const button = form.querySelector("button[type='submit']");
      button.disabled = true;
      setMessage("Connexion au serveur...", false);
      try {
        const body = Object.fromEntries(new FormData(form).entries());
        const response = await fetch(`/api/${mode}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || "Action impossible.");
        setMessage("Accès validé. Redirection...", false);
        window.location.href = "/dashboard";
      } catch (error) {
        setMessage(error.message || "Erreur de connexion.", true);
      } finally {
        button.disabled = false;
      }
    });
  }

  if (document.querySelector(".dashboard-main")) {
    loadDashboard();
  }

  document.querySelector("[data-logout]")?.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  });

  async function loadDashboard() {
    const me = await fetchJson("/api/me");
    if (!me?.ok) {
      window.location.href = "/login";
      return;
    }
    document.querySelector("[data-user-greeting]").textContent = `Bienvenue ${me.user.name}. Ton espace Kronos est prêt.`;
    document.querySelector("[data-user-plan]").textContent = String(me.user.plan || "free").toUpperCase();

    const performance = await fetchJson("/api/performance");
    const status = document.querySelector("[data-dashboard-status]");
    if (status) status.textContent = performance?.precisionLabel ? "Données chargées" : "En attente";
    const label = document.querySelector("[data-performance-label]");
    if (label) label.textContent = performance?.precisionLabel || "À auditer";
    const metrics = document.querySelector("[data-dashboard-metrics]");
    if (metrics) {
      metrics.innerHTML = [
        ["Précision", performance?.precisionLabel || "À auditer"],
        ["Analyses", performance?.totalAnalyses ?? 0],
        ["Signaux ouverts", performance?.openAnalyses ?? 0],
        ["Bloquées", performance?.blockedAnalyses ?? 0],
      ].map(([name, value]) => `<div><span>${escapeHtml(name)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    }

    const personal = await fetchJson("/api/my-analyses");
    renderPersonalHistory(personal);
  }

  function renderPersonalHistory(data) {
    const host = document.querySelector("[data-dashboard-history]");
    const status = document.querySelector("[data-personal-status]");
    if (!host) return;
    if (status) {
      const total = data?.summary?.total ?? 0;
      status.textContent = total ? `${total} analyse${total > 1 ? "s" : ""}` : "Aucune analyse";
    }
    if (!Array.isArray(data?.analyses) || !data.analyses.length) {
      host.innerHTML = `<div class="dashboard-empty">Aucune analyse personnelle enregistrée pour ce compte. Lance une analyse depuis la page Analyse IA.</div>`;
      return;
    }
    host.innerHTML = data.analyses.map((item) => `
      <article>
        <div>
          <strong>${escapeHtml(item.pair)} · ${escapeHtml(item.direction)}</strong>
          <span>${escapeHtml(item.timeframe)} · ${escapeHtml(item.style)} · ${formatDate(item.createdAt)}</span>
        </div>
        <div class="dashboard-history-levels">
          <button type="button" data-copy-level="${escapeHtml(item.sl)}">SL ${escapeHtml(item.sl)}</button>
          <button type="button" data-copy-level="${escapeHtml(item.tp1)}">TP1 ${escapeHtml(item.tp1)}</button>
          <button type="button" data-copy-level="${escapeHtml(item.tp2)}">TP2 ${escapeHtml(item.tp2)}</button>
        </div>
        <span class="${item.status === "OPEN" ? "history-open" : "history-blocked"}">${escapeHtml(item.status)}</span>
      </article>
    `).join("");
    host.querySelectorAll("[data-copy-level]").forEach((button) => {
      button.addEventListener("click", async () => {
        await navigator.clipboard?.writeText(button.dataset.copyLevel || "");
        button.textContent = "Copié";
      });
    });
  }

  async function fetchJson(url) {
    try {
      const response = await fetch(url);
      return response.json();
    } catch {
      return null;
    }
  }

  function setMessage(text, error) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("error", Boolean(error));
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

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
    } catch {
      return "date inconnue";
    }
  }
})();
