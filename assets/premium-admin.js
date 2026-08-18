(() => {
  const form = document.querySelector("[data-premium-admin-form]");
  const message = document.querySelector("[data-premium-admin-message]");
  const members = document.querySelector("[data-premium-members]");
  const loadButton = document.querySelector("[data-load-members]");

  // The token used to have to be retyped on every page load/navigation -- painful
  // now that the admin token is shared across two pages (this one and
  // admin-contenu.html). sessionStorage: survives navigating within the tab,
  // cleared when the tab closes, never sent anywhere itself (only ever read back
  // into this same form field, which adminFetch already turns into a header).
  const tokenInput = form?.elements?.token;
  if (tokenInput) {
    const saved = sessionStorage.getItem("oracle_admin_token");
    if (saved) tokenInput.value = saved;
    tokenInput.addEventListener("input", () => {
      if (tokenInput.value) sessionStorage.setItem("oracle_admin_token", tokenInput.value);
      else sessionStorage.removeItem("oracle_admin_token");
    });
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    setMessage("Activation en cours...", false);
    const data = await adminFetch("/api/admin/grant-premium", body);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Activation impossible.", true);
      return;
    }
    setMessage(data.message || "Premium activé.", false);
    renderMembers([data.user]);
  });

  loadButton?.addEventListener("click", async () => {
    const token = form?.elements?.token?.value || "";
    setMessage("Chargement des comptes...", false);
    const data = await adminFetch("/api/admin/members", null, token);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Chargement impossible.", true);
      return;
    }
    setMessage(`${data.users.length} compte(s) chargé(s).`, false);
    renderMembers(data.users);
  });

  async function adminFetch(url, body = null, explicitToken = "") {
    const token = explicitToken || body?.token || "";
    const options = {
      method: body ? "POST" : "GET",
      headers: { "X-Admin-Token": token },
    };
    if (body) {
      const { token: _token, ...payload } = body;
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(payload);
    }
    try {
      const response = await fetch(url, options);
      try {
        return await response.json();
      } catch {
        // Reached the server but got a non-JSON body (a crash page, an empty
        // response...) -- distinct from never reaching it at all, see below.
        return { ok: false, error: "reponse_serveur_invalide", message: `Réponse inattendue du serveur (code ${response.status}).` };
      }
    } catch {
      // fetch() itself only throws for network-level failures (DNS, connection
      // refused, offline...), never for 4xx/5xx -- those come back as normal JSON
      // above with the server's real error message (e.g. "Accès admin requis").
      return { ok: false, error: "reseau_indisponible", message: "Impossible de contacter le serveur (connexion réseau ?)." };
    }
  }

  function renderMembers(items = []) {
    if (!members) return;
    if (!items.length) {
      members.innerHTML = `<div class="dashboard-empty">Aucun compte à afficher.</div>`;
      return;
    }
    members.innerHTML = items.map((user) => `
      <article>
        <div>
          <strong>${escapeHtml(user.name || "Compte")} · ${escapeHtml(user.email)}</strong>
          <span>${escapeHtml(user.role || "user")} · ${user.premiumUntil ? `Premium jusqu'au ${formatDate(user.premiumUntil)}` : "Free"} · ${user.manualPremium ? "Manuel" : "Standard"}</span>
        </div>
        <div class="dashboard-history-levels">
          <button type="button" data-revoke-premium="${escapeHtml(user.email)}" ${user.plan === "premium" ? "" : "disabled"}>Révoquer</button>
        </div>
        <span class="${user.plan === "premium" ? "history-open" : "history-blocked"}">${escapeHtml(user.plan || "free")}</span>
      </article>
    `).join("");
    members.querySelectorAll("[data-revoke-premium]").forEach((button) => {
      button.addEventListener("click", async () => {
        const email = button.dataset.revokePremium;
        const token = form?.elements?.token?.value || "";
        if (!token) {
          setMessage("Renseigne le token admin avant de révoquer.", true);
          return;
        }
        if (!window.confirm(`Retirer Premium à ${email} ?`)) return;
        button.disabled = true;
        setMessage(`Révocation de ${email}...`, false);
        const data = await adminFetch("/api/admin/revoke-premium", { token, email });
        if (!data?.ok) {
          setMessage(data?.message || data?.error || "Révocation impossible (voir détail ci-dessus).", true);
          button.disabled = false;
          return;
        }
        setMessage(data.message || "Premium retiré.", false);
        renderMembers(items.map((item) => (item.email === email ? { ...item, ...data.user } : item)));
      });
    });
  }

  const tradingStatus = document.querySelector("[data-trading-status]");
  const tradingRefresh = document.querySelector("[data-trading-refresh]");
  const tradingPause = document.querySelector("[data-trading-pause]");
  const tradingResume = document.querySelector("[data-trading-resume]");
  const tradingCapInput = document.querySelector("[data-trading-cap-input]");
  const tradingCapSave = document.querySelector("[data-trading-cap-save]");

  function requireToken() {
    const token = form?.elements?.token?.value || "";
    if (!token) setMessage("Renseigne le token admin en haut avant d'utiliser le coupe-circuit.", true);
    return token;
  }

  async function refreshTradingStatus() {
    const token = requireToken();
    if (!token) return;
    const data = await adminFetch("/api/admin/trading-status", null, token);
    if (!data?.ok) {
      if (tradingStatus) tradingStatus.textContent = data?.message || data?.error || "Statut indisponible.";
      return;
    }
    if (tradingStatus) {
      tradingStatus.textContent = `${data.paused ? "⏸ EN PAUSE" : "▶ Actif"} · ${data.ordersConfirmedToday} ordre(s) envoyé(s) aujourd'hui (plafond ${data.dailyCapPerUser}/compte/jour) · Broker ${data.brokerConfigured ? "connecté" : "non connecté"}.`;
    }
    if (tradingCapInput && document.activeElement !== tradingCapInput) tradingCapInput.value = data.dailyCapPerUser;
  }

  tradingRefresh?.addEventListener("click", refreshTradingStatus);

  tradingCapSave?.addEventListener("click", async () => {
    const token = requireToken();
    if (!token) return;
    const cap = Math.round(Number(tradingCapInput?.value));
    if (!Number.isFinite(cap) || cap < 1 || cap > 200) {
      setMessage("Plafond invalide (1 à 200).", true);
      return;
    }
    setMessage("Enregistrement du plafond...", false);
    const data = await adminFetch("/api/admin/trading-pause", { token, dailyOrderCap: cap });
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Action impossible.", true);
      return;
    }
    setMessage(`Plafond mis à jour : ${data.dailyCapPerUser} ordre(s)/compte/jour.`, false);
    refreshTradingStatus();
  });

  async function setTradingPause(paused) {
    const token = requireToken();
    if (!token) return;
    setMessage(paused ? "Mise en pause..." : "Reprise...", false);
    const data = await adminFetch("/api/admin/trading-pause", { token, paused });
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Action impossible.", true);
      return;
    }
    setMessage(paused ? "Trading en pause : plus aucun ordre ne partira au broker." : "Trading repris.", false);
    refreshTradingStatus();
  }

  tradingPause?.addEventListener("click", () => setTradingPause(true));
  tradingResume?.addEventListener("click", () => setTradingPause(false));

  function setMessage(text, error) {
    if (!message) return;
    message.textContent = text;
    message.classList.toggle("error", Boolean(error));
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value));
    } catch {
      return "date inconnue";
    }
  }

  // Same pair list the deterministic signal engine actually trades (server.mjs's
  // `symbols` const) -- offering any other pair here would let an admin "approve"
  // something the bot can never act on.
  const AUTOTRADE_PAIRS = ["EUR/USD", "XAU/USD", "BTC/USD", "GBP/JPY", "US500", "ETH/USD", "USD/JPY", "USD/CHF"];
  const AUTOTRADE_STATUS_LABELS = {
    none: "Aucune demande",
    requested: "En attente",
    approved: "Approuvé",
    rejected: "Refusé",
    revoked: "Révoqué",
  };

  const autotradeLoad = document.querySelector("[data-autotrade-load]");
  const autotradeRequests = document.querySelector("[data-autotrade-requests]");

  autotradeLoad?.addEventListener("click", async () => {
    const token = form?.elements?.token?.value || "";
    setMessage("Chargement des demandes...", false);
    const data = await adminFetch("/api/admin/auto-trade/requests", null, token);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Chargement impossible.", true);
      return;
    }
    setMessage(`${data.requests.length} demande(s) chargée(s).`, false);
    renderAutoTradeRequests(data.requests);
  });

  function renderAutoTradeRequests(requests = []) {
    if (!autotradeRequests) return;
    if (!requests.length) {
      autotradeRequests.innerHTML = `<div class="dashboard-empty">Aucune demande pour l'instant.</div>`;
      return;
    }
    autotradeRequests.innerHTML = requests.map((request) => `
      <article data-autotrade-request-card="${escapeHtml(request.userId)}">
        <div>
          <strong>${escapeHtml(request.userName || "Compte")} · ${escapeHtml(request.userEmail)}</strong>
          <span class="${request.approvalStatus === "approved" ? "history-open" : request.approvalStatus === "requested" ? "" : "history-blocked"}">
            ${escapeHtml(AUTOTRADE_STATUS_LABELS[request.approvalStatus] || request.approvalStatus)}
            ${request.approvalStatus === "approved" ? `· jusqu'au ${formatDate(request.approvedUntil)}` : ""}
            · broker ${request.brokerConnected ? "connecté" : "non connecté"}
          </span>
        </div>
        <div class="dashboard-autotrade-pairs">
          ${AUTOTRADE_PAIRS.map((pair) => `
            <label>
              <input type="checkbox" value="${escapeHtml(pair)}" ${request.approvedPairs.includes(pair) ? "checked" : ""}>
              ${escapeHtml(pair)}
            </label>
          `).join("")}
        </div>
        <div class="dashboard-autotrade-form">
          <input type="number" min="1" max="90" step="1" placeholder="Jours" value="7" data-field="days">
          <input type="number" min="0.1" max="3" step="0.1" placeholder="Risque % / trade" value="${request.riskPercent ?? 0.5}" data-field="riskPercent">
          <input type="number" min="1" max="10" step="0.5" placeholder="Perte max / jour %" value="${request.dailyLossLimitPercent ?? 3}" data-field="dailyLossLimitPercent">
          <input type="number" min="1" max="5" step="1" placeholder="Positions max" value="${request.maxConcurrentPositions ?? 2}" data-field="maxConcurrentPositions">
          <input type="number" min="60" max="95" step="1" placeholder="Confiance min %" value="${request.minConfidenceFloor ?? 70}" data-field="minConfidenceFloor">
        </div>
        <div class="premium-admin-actions">
          <button type="button" data-autotrade-approve="${escapeHtml(request.userId)}">Approuver</button>
          <button type="button" data-autotrade-reject="${escapeHtml(request.userId)}">Refuser</button>
          <button type="button" data-autotrade-revoke="${escapeHtml(request.userId)}" ${request.approvalStatus === "approved" ? "" : "disabled"}>Révoquer</button>
        </div>
      </article>
    `).join("");

    autotradeRequests.querySelectorAll("[data-autotrade-approve]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.autotradeApprove;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant d'approuver.", true); return; }
        const card = button.closest("[data-autotrade-request-card]");
        const pairs = [...card.querySelectorAll('.dashboard-autotrade-pairs input:checked')].map((input) => input.value);
        if (!pairs.length) { setMessage("Coche au moins une paire avant d'approuver.", true); return; }
        const field = (name) => Number(card.querySelector(`[data-field="${name}"]`).value);
        button.disabled = true;
        setMessage("Approbation en cours...", false);
        const data = await adminFetch("/api/admin/auto-trade/approve", {
          token, userId, pairs,
          days: field("days"), riskPercent: field("riskPercent"), dailyLossLimitPercent: field("dailyLossLimitPercent"),
          maxConcurrentPositions: field("maxConcurrentPositions"), minConfidenceFloor: field("minConfidenceFloor"),
        });
        button.disabled = false;
        if (!data?.ok) { setMessage(data?.message || data?.error || "Approbation impossible.", true); return; }
        setMessage(`Approuvé jusqu'au ${formatDate(data.approvedUntil)}.`, false);
        autotradeLoad?.click();
      });
    });

    autotradeRequests.querySelectorAll("[data-autotrade-reject]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.autotradeReject;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant de refuser.", true); return; }
        const reason = window.prompt("Raison du refus (optionnel) :") || "";
        button.disabled = true;
        const data = await adminFetch("/api/admin/auto-trade/reject", { token, userId, reason });
        button.disabled = false;
        if (!data?.ok) { setMessage(data?.message || data?.error || "Action impossible.", true); return; }
        setMessage("Demande refusée.", false);
        autotradeLoad?.click();
      });
    });

    autotradeRequests.querySelectorAll("[data-autotrade-revoke]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.autotradeRevoke;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant de révoquer.", true); return; }
        if (!window.confirm("Révoquer l'accès au trading automatique pour ce compte ?")) return;
        button.disabled = true;
        const data = await adminFetch("/api/admin/auto-trade/revoke", { token, userId });
        button.disabled = false;
        if (!data?.ok) { setMessage(data?.message || data?.error || "Action impossible.", true); return; }
        setMessage("Accès révoqué.", false);
        autotradeLoad?.click();
      });
    });
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
