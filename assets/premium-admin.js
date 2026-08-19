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
    const MEMBERS_VISIBLE = 5;
    const memberCards = items.map((user, index) => `
      <article ${index >= MEMBERS_VISIBLE ? "hidden data-member-extra" : ""}>
        <div>
          <strong>${escapeHtml(user.name || "Compte")} · ${escapeHtml(user.email)}</strong>
          <span>${escapeHtml(user.role || "user")} · ${user.premiumUntil ? `Premium jusqu'au ${formatDate(user.premiumUntil)}` : "Free"} · ${user.manualPremium ? "Manuel" : "Standard"}</span>
        </div>
        <div class="dashboard-history-levels">
          <button type="button" data-revoke-premium="${escapeHtml(user.email)}" ${user.plan === "premium" ? "" : "disabled"}>Révoquer</button>
        </div>
        <span class="${user.plan === "premium" ? "history-open" : "history-blocked"}">${escapeHtml(user.plan || "free")}</span>
      </article>
    `);
    const extraMembers = items.length - MEMBERS_VISIBLE;
    members.innerHTML = memberCards.join("") + (extraMembers > 0 ? `
      <button type="button" class="dashboard-history-more" data-members-more>Voir ${extraMembers} compte${extraMembers > 1 ? "s" : ""} de plus</button>
    ` : "");
    members.querySelector("[data-members-more]")?.addEventListener("click", function () {
      members.querySelectorAll("[data-member-extra]").forEach((card) => card.removeAttribute("hidden"));
      this.remove();
    });
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
  // Only pairs with a real, backtested mean-reversion edge (see
  // scripts/backtest-scalp-fx-meanrev.mjs) -- deliberately a much shorter list
  // than AUTOTRADE_PAIRS above, and the server rejects anything else anyway.
  const SCALP_VALIDATED_PAIRS = ["GBP/USD", "XAU/USD"];
  // JS Date#getUTCDay() values (0=dimanche..6=samedi), listed Monday-first for a
  // more natural reading order in French -- server.mjs's isWithinTradingWindow
  // reads the same values back regardless of display order.
  const AUTOTRADE_DAYS = [
    { value: 1, label: "Lun" }, { value: 2, label: "Mar" }, { value: 3, label: "Mer" }, { value: 4, label: "Jeu" },
    { value: 5, label: "Ven" }, { value: 6, label: "Sam" }, { value: 0, label: "Dim" },
  ];
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
    const REQUESTS_VISIBLE = 5;
    const requestCards = requests.map((request, index) => `
      <article data-autotrade-request-card="${escapeHtml(request.userId)}" ${index >= REQUESTS_VISIBLE ? "hidden data-request-extra" : ""}>
        <div>
          <strong>${escapeHtml(request.userName || "Compte")} · ${escapeHtml(request.userEmail)}</strong>
          <span class="${request.approvalStatus === "approved" ? "history-open" : request.approvalStatus === "requested" ? "" : "history-blocked"}">
            ${escapeHtml(AUTOTRADE_STATUS_LABELS[request.approvalStatus] || request.approvalStatus)}
            ${request.approvalStatus === "approved" ? `· jusqu'au ${formatDate(request.approvedUntil)}` : ""}
            · broker ${request.brokerConnected ? "connecté" : "non connecté"}
          </span>
        </div>
        <div class="dashboard-autotrade-pairs" data-trading-pairs>
          ${AUTOTRADE_PAIRS.map((pair) => `
            <label>
              <input type="checkbox" value="${escapeHtml(pair)}" ${request.approvedPairs.includes(pair) ? "checked" : ""}>
              ${escapeHtml(pair)}
            </label>
          `).join("")}
        </div>
        <div class="dashboard-autotrade-form">
          <label class="dashboard-autotrade-field">Durée (jours)
            <input type="number" min="1" max="90" step="1" value="7" data-field="days">
          </label>
          <label class="dashboard-autotrade-field">Risque % / trade
            <input type="number" min="0.1" max="3" step="0.1" value="${request.riskPercent ?? 0.5}" data-field="riskPercent">
          </label>
          <label class="dashboard-autotrade-field">Perte max / jour (%)
            <input type="number" min="1" max="10" step="0.5" value="${request.dailyLossLimitPercent ?? 3}" data-field="dailyLossLimitPercent">
          </label>
          <label class="dashboard-autotrade-field">Positions ouvertes max
            <input type="number" min="1" max="5" step="1" value="${request.maxConcurrentPositions ?? 2}" data-field="maxConcurrentPositions">
          </label>
          <label class="dashboard-autotrade-field">Confiance min (%)
            <input type="number" min="60" max="95" step="1" value="${request.minConfidenceFloor ?? 70}" data-field="minConfidenceFloor">
          </label>
        </div>
        <div class="dashboard-autotrade-form">
          <label class="dashboard-autotrade-field">Trades max / jour <span class="dashboard-autotrade-hint">(0 = illimité)</span>
            <input type="number" min="0" max="100" step="1" value="${request.maxTradesPerDay ?? 0}" data-field="maxTradesPerDay">
          </label>
          <label class="dashboard-autotrade-field">R:R minimum <span class="dashboard-autotrade-hint">(0 = pas de filtre)</span>
            <input type="number" min="0" max="10" step="0.1" value="${request.minRiskReward ?? 0}" data-field="minRiskReward">
          </label>
          <label class="dashboard-autotrade-field">Perte max / jour (montant) <span class="dashboard-autotrade-hint">(0 = pas de plafond, devise du broker)</span>
            <input type="number" min="0" step="1" value="${request.dailyLossLimitAmount ?? 0}" data-field="dailyLossLimitAmount">
          </label>
          <label class="dashboard-autotrade-field">Heure de début <span class="dashboard-autotrade-hint">(UTC)</span>
            <input type="time" value="${escapeHtml(request.tradingHoursStart || "")}" data-field="tradingHoursStart">
          </label>
          <label class="dashboard-autotrade-field">Heure de fin <span class="dashboard-autotrade-hint">(UTC)</span>
            <input type="time" value="${escapeHtml(request.tradingHoursEnd || "")}" data-field="tradingHoursEnd">
          </label>
        </div>
        <div class="dashboard-autotrade-pairs" data-trading-days>
          ${AUTOTRADE_DAYS.map(({ value, label }) => `
            <label>
              <input type="checkbox" value="${value}" ${!request.tradingDays || request.tradingDays.includes(value) ? "checked" : ""}>
              ${escapeHtml(label)}
            </label>
          `).join("")}
        </div>
        ${request.userMinConfidence != null && request.userMinConfidence > (request.minConfidenceFloor ?? 70) ? `
          <p class="dashboard-autotrade-warning">⚠ Ce compte a lui-même réglé sa confiance minimale à ${escapeHtml(request.userMinConfidence)}%, plus haut que le plancher admin ci-dessus (${escapeHtml(request.minConfidenceFloor ?? 70)}%) -- c'est la valeur la plus haute des deux qui s'applique réellement, donc c'est celle du compte, pas celle-ci, qui filtre les trades tant qu'elle reste au-dessus.</p>
        ` : ""}
        <div class="premium-admin-actions">
          <button type="button" data-autotrade-approve="${escapeHtml(request.userId)}">Approuver</button>
          <button type="button" data-autotrade-reject="${escapeHtml(request.userId)}">Refuser</button>
          <button type="button" data-autotrade-revoke="${escapeHtml(request.userId)}" ${request.approvalStatus === "approved" ? "" : "disabled"}>Révoquer</button>
        </div>

        <div class="dashboard-autotrade-section" style="margin-top:16px;padding-top:16px;border-top:1px solid var(--oracle-border)">
          <h3>Mode scalping -- mean-reversion, edge validé par backtest (GBP/USD, XAU/USD)</h3>
          <label class="dashboard-autotrade-field" style="flex:0 0 auto">
            <span style="display:flex;align-items:center;gap:6px;text-transform:none;font-size:13px;color:var(--foreground)">
              <input type="checkbox" ${request.scalpEnabled ? "checked" : ""} data-scalp-field="scalpEnabled" style="width:auto">
              Activer le mode scalping pour ce compte
            </span>
          </label>
          <div class="dashboard-autotrade-pairs" data-scalp-pairs>
            ${SCALP_VALIDATED_PAIRS.map((pair) => `
              <label>
                <input type="checkbox" value="${pair}" ${(request.scalpPairs || []).includes(pair) ? "checked" : ""}>
                ${escapeHtml(pair)}
              </label>
            `).join("")}
          </div>
          <div class="dashboard-autotrade-form">
            <label class="dashboard-autotrade-field">Mode de lot
              <select data-scalp-field="scalpLotMode">
                <option value="auto" ${request.scalpLotMode !== "fixed" ? "selected" : ""}>Automatique (calculé depuis la perte max)</option>
                <option value="fixed" ${request.scalpLotMode === "fixed" ? "selected" : ""}>Lot fixe imposé</option>
              </select>
            </label>
            <label class="dashboard-autotrade-field">Lot fixe <span class="dashboard-autotrade-hint">(si mode "fixe", ex: 0.01)</span>
              <input type="number" min="0.01" max="1" step="0.01" value="${request.scalpFixedLot ?? 0.01}" data-scalp-field="scalpFixedLot">
            </label>
            <label class="dashboard-autotrade-field">Perte max par trade (montant) <span class="dashboard-autotrade-hint">(sert au calcul du lot en mode auto)</span>
              <input type="number" min="0.3" max="200" step="0.1" value="${request.scalpLossLimitAmount ?? 2}" data-scalp-field="scalpLossLimitAmount">
            </label>
            <label class="dashboard-autotrade-field">Objectif de profit (montant) <span class="dashboard-autotrade-hint">(indicatif -- la vraie cible vient du signal)</span>
              <input type="number" min="0.3" max="100" step="0.1" value="${request.scalpProfitTargetAmount ?? 1}" data-scalp-field="scalpProfitTargetAmount">
            </label>
            <label class="dashboard-autotrade-field">Durée max de détention (secondes) <span class="dashboard-autotrade-hint">(plafond -- le signal vise 30min)</span>
              <input type="number" min="5" max="3600" step="5" value="${request.scalpMaxHoldSeconds ?? 120}" data-scalp-field="scalpMaxHoldSeconds">
            </label>
          </div>
          <div class="premium-admin-actions">
            <button type="button" data-autotrade-scalp-save="${escapeHtml(request.userId)}">Enregistrer le mode scalping</button>
          </div>
        </div>
      </article>
    `);
    const extraRequests = requests.length - REQUESTS_VISIBLE;
    autotradeRequests.innerHTML = requestCards.join("") + (extraRequests > 0 ? `
      <button type="button" class="dashboard-history-more" data-requests-more>Voir ${extraRequests} demande${extraRequests > 1 ? "s" : ""} de plus</button>
    ` : "");
    autotradeRequests.querySelector("[data-requests-more]")?.addEventListener("click", function () {
      autotradeRequests.querySelectorAll("[data-request-extra]").forEach((card) => card.removeAttribute("hidden"));
      this.remove();
    });

    autotradeRequests.querySelectorAll("[data-autotrade-approve]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.autotradeApprove;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant d'approuver.", true); return; }
        const card = button.closest("[data-autotrade-request-card]");
        const pairs = [...card.querySelectorAll('[data-trading-pairs] input:checked')].map((input) => input.value);
        if (!pairs.length) { setMessage("Coche au moins une paire avant d'approuver.", true); return; }
        const tradingDays = [...card.querySelectorAll('[data-trading-days] input:checked')].map((input) => Number(input.value));
        if (!tradingDays.length) { setMessage("Coche au moins un jour de trading avant d'approuver.", true); return; }
        const field = (name) => Number(card.querySelector(`[data-field="${name}"]`).value);
        const timeField = (name) => card.querySelector(`[data-field="${name}"]`).value || null;
        button.disabled = true;
        setMessage("Approbation en cours...", false);
        const data = await adminFetch("/api/admin/auto-trade/approve", {
          token, userId, pairs, tradingDays,
          days: field("days"), riskPercent: field("riskPercent"), dailyLossLimitPercent: field("dailyLossLimitPercent"),
          maxConcurrentPositions: field("maxConcurrentPositions"), minConfidenceFloor: field("minConfidenceFloor"),
          maxTradesPerDay: field("maxTradesPerDay"), minRiskReward: field("minRiskReward"), dailyLossLimitAmount: field("dailyLossLimitAmount"),
          tradingHoursStart: timeField("tradingHoursStart"), tradingHoursEnd: timeField("tradingHoursEnd"),
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

    autotradeRequests.querySelectorAll("[data-autotrade-scalp-save]").forEach((button) => {
      button.addEventListener("click", async () => {
        const userId = button.dataset.autotradeScalpSave;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant d'enregistrer.", true); return; }
        const card = button.closest("[data-autotrade-request-card]");
        const scalpField = (name) => card.querySelector(`[data-scalp-field="${name}"]`);
        const scalpEnabled = scalpField("scalpEnabled").checked;
        const scalpPairs = [...card.querySelectorAll("[data-scalp-pairs] input:checked")].map((input) => input.value);
        if (scalpEnabled && !scalpPairs.length) { setMessage("Coche au moins une paire scalping avant d'activer.", true); return; }
        button.disabled = true;
        setMessage("Enregistrement du mode scalping...", false);
        const data = await adminFetch("/api/admin/auto-trade/scalp-settings", {
          token, userId, scalpEnabled, scalpPairs,
          scalpLotMode: scalpField("scalpLotMode").value,
          scalpFixedLot: Number(scalpField("scalpFixedLot").value),
          scalpProfitTargetAmount: Number(scalpField("scalpProfitTargetAmount").value),
          scalpLossLimitAmount: Number(scalpField("scalpLossLimitAmount").value),
          scalpMaxHoldSeconds: Number(scalpField("scalpMaxHoldSeconds").value),
        });
        button.disabled = false;
        if (!data?.ok) { setMessage(data?.message || data?.error || "Enregistrement impossible.", true); return; }
        setMessage("Mode scalping enregistré.", false);
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
