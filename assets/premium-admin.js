(() => {
  const form = document.querySelector("[data-premium-admin-form]");
  const message = document.querySelector("[data-premium-admin-message]");
  const members = document.querySelector("[data-premium-members]");
  const loadButton = document.querySelector("[data-load-members]");
  const memberDrawer = document.querySelector("[data-member-drawer]");
  const memberDetail = document.querySelector("[data-member-detail]");
  const memberClose = document.querySelector("[data-member-close]");
  const memberDrawerTitle = document.querySelector("[data-member-drawer-title]");
  let lastMemberTrigger = null;
  const memberSearch = document.querySelector("[data-member-search]");
  const memberPlanFilter = document.querySelector("[data-member-plan-filter]");
  let memberItems = [];

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
    const submitButton = form.querySelector("button[type=\"submit\"]");
    if (submitButton?.disabled) return;
    submitButton.disabled = true;
    const body = Object.fromEntries(new FormData(form).entries());
    setMessage("Activation en cours...", false);
    const data = await adminFetch("/api/admin/grant-premium", body);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Activation impossible.", true);
      submitButton.disabled = false;
      return;
    }
    setMessage(data.message || "Premium activé.", false);
    memberItems = [data.user, ...memberItems.filter((item) => item.email !== data.user.email)];
    renderMemberDirectory();
    submitButton.disabled = false;
  });

  loadButton?.addEventListener("click", async () => {
    if (loadButton.disabled) return;
    loadButton.disabled = true;
    const token = form?.elements?.token?.value || "";
    setMessage("Chargement des comptes...", false);
    const data = await adminFetch("/api/admin/members", null, token);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Chargement impossible.", true);
      loadButton.disabled = false;
      return;
    }
    setMessage(`${data.users.length} compte(s) chargé(s).`, false);
    memberItems = Array.isArray(data.users) ? data.users : [];
    renderMemberDirectory();
    loadButton.disabled = false;
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
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
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

  function currentMemberItems() {
    const query = String(memberSearch?.value || "").trim().toLocaleLowerCase();
    const plan = memberPlanFilter?.value || "all";
    return memberItems.filter((user) => {
      const haystack = [user.name, user.email, user.role].map((value) => String(value || "").toLocaleLowerCase()).join(" ");
      return (!query || haystack.includes(query)) && (plan === "all" || user.plan === plan);
    });
  }
  function renderMemberDirectory() { renderMembers(currentMemberItems()); }
  memberSearch?.addEventListener("input", renderMemberDirectory);
  memberPlanFilter?.addEventListener("change", renderMemberDirectory);
  function renderMembers(items = []) {
    if (!members) return;
    if (!items.length) {
      members.innerHTML = memberItems.length ? `<div class="dashboard-empty">Aucun compte ne correspond aux filtres.</div>` : `<div class="dashboard-empty">Aucun compte à afficher.</div>`;
      return;
    }
    const MEMBERS_VISIBLE = 5;
    const memberCards = items.map((user, index) => `
      <article ${index >= MEMBERS_VISIBLE ? "hidden data-member-extra" : ""}>
        <div>
          <strong>${escapeHtml(user.name || "Compte")} · ${escapeHtml(user.email)}</strong>
          <span>${escapeHtml(user.role || "user")} · ${user.premiumUntil ? `Premium jusqu'au ${formatDate(user.premiumUntil)}` : "Free"} · ${user.manualPremium ? "Manuel" : "Standard"}</span>
        </div>
        <div class="dashboard-history-levels"><button type="button" data-member-details="${escapeHtml(user.id)}">Voir le dossier</button>
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
    members.querySelectorAll("[data-member-details]").forEach((button) => { const userId = button.dataset.memberDetails; button.addEventListener("click", () => { lastMemberTrigger = button; loadMemberDetails(userId); }); });
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
        memberItems = memberItems.map((item) => (item.email === email ? { ...item, ...data.user } : item));
        renderMemberDirectory();
      });
    });
  }

  memberClose?.addEventListener("click", closeMemberDetails);
  memberDrawer?.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.preventDefault(); closeMemberDetails(); } });
  memberDrawer?.addEventListener("click", (event) => { if (event.target === memberDrawer) closeMemberDetails(); });
  function closeMemberDetails() { if (memberDrawer) memberDrawer.hidden = true; if (lastMemberTrigger) lastMemberTrigger.focus(); }
  async function loadMemberDetails(userId) {
    const token = form?.elements?.token?.value || "";
    if (!token || !userId || !memberDrawer || !memberDetail) { setMessage("Renseigne le token admin avant d ouvrir un dossier.", true); return; }
    memberDrawer.hidden = false;
    memberDrawer.focus();
    if (memberDrawerTitle) memberDrawerTitle.textContent = "Chargement du dossier";
    memberDetail.innerHTML = "<p class=\"health-empty\">Chargement du dossier client...</p>";
    const data = await adminFetch("/api/admin/members/" + encodeURIComponent(userId), null, token);
    if (!data?.ok) { memberDetail.innerHTML = "<p class=\"health-empty\">" + escapeHtml(data?.message || data?.error || "Dossier indisponible.") + "</p>"; return; }
    renderMemberDetail(data);
  }
  function renderMemberDetail(data) {
    const user = data.user || {}, account = data.account || {}, performance = data.performance || {}, trading = data.trading || {}, bot = data.autoTrade;
    const analyses = Array.isArray(data.analyses) ? data.analyses : [], orders = Array.isArray(data.orders) ? data.orders : [];
    if (memberDrawerTitle) memberDrawerTitle.textContent = "Dossier de " + (user.name || user.email || "ce compte");
    const byPair = Array.isArray(data.byPair) ? data.byPair : [];
    const pairRows = byPair.length ? byPair.map((item) => "<tr><td>" + escapeHtml(item.pair || "--") + "</td><td>" + Number(item.total || 0) + "</td><td>" + Number(item.wins || 0) + "</td><td>" + Number(item.losses || 0) + "</td><td>" + escapeHtml(formatNumber(item.net_r, "R")) + "</td></tr>").join("") : "<tr><td colspan=\"5\">Aucune donnee par paire.</td></tr>";
    const winRate = performance.wins + performance.losses ? Math.round((performance.wins / (performance.wins + performance.losses)) * 100) : 0;
    const analysisRows = analyses.length ? analyses.map((item) => "<tr><td>" + escapeHtml(item.pair || "--") + "</td><td>" + escapeHtml(item.direction || "--") + "</td><td>" + escapeHtml(item.outcome || item.status || "--") + "</td><td>" + escapeHtml(formatNumber(item.r_multiple, "R")) + "</td><td>" + escapeHtml(formatDateTime(item.created_at)) + "</td></tr>").join("") : "<tr><td colspan=\"5\">Aucune analyse enregistree.</td></tr>";
    const orderRows = orders.length ? orders.map((item) => "<tr><td>" + escapeHtml(item.pair || "--") + "</td><td>" + escapeHtml(item.direction || "--") + "</td><td>" + escapeHtml(item.status || "--") + "</td><td>" + escapeHtml(item.broker_slot || "--") + "</td><td>" + escapeHtml(formatDateTime(item.created_at)) + "</td></tr>").join("") : "<tr><td colspan=\"5\">Aucun ordre enregistre.</td></tr>";
    const activity = [...analyses.map((item) => ({ kind: "Analyse", title: (item.pair || "--") + " � " + (item.direction || "--"), status: item.outcome || item.status || "--", at: item.created_at })), ...orders.map((item) => ({ kind: "Ordre", title: (item.pair || "--") + " � " + (item.direction || "--"), status: item.status || "--", at: item.created_at }))].sort((left, right) => new Date(right.at || 0) - new Date(left.at || 0)).slice(0, 12);
    const activityRows = activity.length ? activity.map((item) => "<div class=\"member-timeline-item\"><span class=\"member-timeline-dot\" aria-hidden=\"true\"></span><div><strong>" + escapeHtml(item.kind + " � " + item.title) + "</strong><span>" + escapeHtml(item.status) + " � " + escapeHtml(formatDateTime(item.at)) + "</span></div></div>").join("") : "<p class=\"health-empty\">Aucune activite recente.</p>";
    memberDetail.innerHTML = "<section class=\"member-profile-grid\"><div><span class=\"admin-stat-label\">Identite</span><strong>" + escapeHtml(user.name || "Compte") + "</strong><span>" + escapeHtml(user.email || "--") + "</span></div><div><span class=\"admin-stat-label\">Plan</span><strong>" + escapeHtml(user.plan || "free") + "</strong><span>Depuis " + escapeHtml(formatDateTime(account.createdAt)) + "</span></div><div><span class=\"admin-stat-label\">Derniere connexion</span><strong>" + escapeHtml(formatDateTime(account.lastLoginAt)) + "</strong><span>" + account.activeSessions + " session(s) active(s)</span></div></section>"
      + "<section class=\"member-metric-grid\"><div><span>Winrate</span><strong>" + winRate + "%</strong></div><div><span>Gains cumules</span><strong>" + escapeHtml(formatNumber(performance.grossWinR, "R")) + "</strong></div><div><span>Pertes cumulees</span><strong>" + escapeHtml(formatNumber(performance.grossLossR, "R")) + "</strong></div><div><span>Net performance</span><strong>" + escapeHtml(formatNumber(performance.netR, "R")) + "</strong></div><div><span>Profit broker</span><strong>" + escapeHtml(formatNumber(performance.brokerProfit, "$")) + "</strong></div><div><span>Analyses ouvertes</span><strong>" + performance.open + "</strong></div><div><span>Ordres envoyes</span><strong>" + trading.sent + "</strong></div><div><span>Livraisons incertaines</span><strong class=\"" + (trading.uncertain ? "member-danger" : "") + "\">" + trading.uncertain + "</strong></div></section>"
      + "<section class=\"member-detail-section\"><div class=\"admin-section-heading\"><h4>Robot Kronos</h4><span class=\"health-state\" data-state=\"" + (bot?.approvalStatus === "approved" ? "ok" : "warning") + "\">" + escapeHtml(bot?.approvalStatus || "Non configure") + "</span></div><p class=\"health-empty\">" + (bot ? "Paires : " + escapeHtml(bot.approvedPairs || "non precisees") + " � Risque : " + escapeHtml(formatNumber(bot.riskPercent, "%")) + " � Broker : " + escapeHtml(bot.brokerLastCheckStatus || "non verifie") : "Aucun compte robot configure.") + "</p></section>"
      + "<section class=\"member-detail-section\"><h4>Dernieres analyses</h4><div class=\"member-table-wrap\"><table class=\"member-detail-table\"><thead><tr><th>Paire</th><th>Direction</th><th>Resultat</th><th>R</th><th>Date</th></tr></thead><tbody>" + analysisRows + "</tbody></table></div></section>"
      + "<section class=\"member-detail-section\"><h4>Performance par paire</h4><div class=\"member-table-wrap\"><table class=\"member-detail-table\"><thead><tr><th>Paire</th><th>Analyses</th><th>Gains</th><th>Pertes</th><th>Net R</th></tr></thead><tbody>" + pairRows + "</tbody></table></div></section>"
      + "<section class=\"member-detail-section\"><h4>Derniers ordres</h4><div class=\"member-table-wrap\"><table class=\"member-detail-table\"><thead><tr><th>Paire</th><th>Direction</th><th>Statut</th><th>Broker</th><th>Date</th></tr></thead><tbody>" + orderRows + "</tbody></table></div></section>" + "<section class=\"member-detail-section\"><h4>Fil d activite recent</h4><div class=\"member-timeline\">" + activityRows + "</div></section>";
  }
  function formatDateTime(value) { if (!value) return "Jamais"; try { return new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); } catch { return "Date inconnue"; } }
  function formatNumber(value, suffix = "") { const number = Number(value); return Number.isFinite(number) ? number.toFixed(2) + suffix : "--"; }
  const tradingStatus = document.querySelector("[data-trading-status]");
  const tradingRefresh = document.querySelector("[data-trading-refresh]");
  const tradingPause = document.querySelector("[data-trading-pause]");
  const tradingResume = document.querySelector("[data-trading-resume]");
  const tradingCapInput = document.querySelector("[data-trading-cap-input]");
  const tradingCapSave = document.querySelector("[data-trading-cap-save]");
  const tradingUncertain = document.querySelector("[data-trading-uncertain]");

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
      tradingStatus.textContent = `${data.paused ? "⏸ EN PAUSE" : "▶ Actif"} · ${data.ordersConfirmedToday} ordre(s) confirmé(s) aujourd'hui (plafond ${data.dailyCapPerUser}/compte/jour) · Broker ${data.brokerConfigured ? "connecté" : "non connecté"}.`;
    }
    if (tradingCapInput && document.activeElement !== tradingCapInput) tradingCapInput.value = data.dailyCapPerUser;
    if (tradingUncertain) {
      const orders = Array.isArray(data.deliveryUnknownOrders) ? data.deliveryUnknownOrders : [];
      tradingUncertain.hidden = orders.length === 0;
      tradingUncertain.innerHTML = orders.length
        ? "<strong>Attention : " + orders.length + " ordre(s) à vérifier manuellement.</strong><br>Ne jamais renvoyer ces ordres avant vérification côté broker.<ul>"
          + orders.map((order) => "<li>" + escapeHtml(order.userEmail || "Compte inconnu") + " · " + escapeHtml(order.pair) + " · " + escapeHtml(order.direction) + " · volume " + escapeHtml(order.volume ?? "—") + " · " + escapeHtml(order.brokerSlot || "slot inconnu") + " · confirmé le " + escapeHtml(formatDate(order.confirmedAt)) + "</li>").join("")
          + "</ul>"
        : "";
    }
  }

  tradingRefresh?.addEventListener("click", async () => {
    if (tradingRefresh.disabled) return;
    tradingRefresh.disabled = true;
    await refreshTradingStatus();
    tradingRefresh.disabled = false;
  });

  tradingCapSave?.addEventListener("click", async () => {
    const token = requireToken();
    if (!token) return;
    const cap = Math.round(Number(tradingCapInput?.value));
    if (!Number.isFinite(cap) || cap < 1 || cap > 200) {
      setMessage("Plafond invalide (1 à 200).", true);
      return;
    }
    tradingCapSave.disabled = true;
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

  async function runTradingToggle(button, paused) {
    if (!button || button.disabled) return;
    button.disabled = true;
    await setTradingPause(paused);
    button.disabled = false;
  }

  tradingPause?.addEventListener("click", () => runTradingToggle(tradingPause, true));
  tradingResume?.addEventListener("click", () => runTradingToggle(tradingResume, false));

  const adminOverviewRefresh = document.querySelector('[data-admin-overview-refresh]');
  async function refreshAdminOverview() {
    const token = form?.elements?.token?.value || '';
    if (!token) { setMessage('Renseigne le token admin avant de charger la synthese.', true); return; }
    if (adminOverviewRefresh) adminOverviewRefresh.disabled = true;
    try {
      const results = await Promise.all([
        adminFetch('/api/admin/members', null, token),
        adminFetch('/api/admin/trading-status', null, token),
        adminFetch('/api/admin/auto-trade/requests', null, token),
      ]);
      const membersData = results[0], tradingData = results[1], requestsData = results[2];
      if (!membersData?.ok || !tradingData?.ok || !requestsData?.ok) {
        setAdminOverviewState('critical', 'Acces admin incomplet', 'Une ou plusieurs sources n ont pas repondu.');
        setMessage('Synthese indisponible : verifie le token et les droits.', true);
        return;
      }
      const users = Array.isArray(membersData.users) ? membersData.users : [];
      const requests = Array.isArray(requestsData.requests) ? requestsData.requests : [];
      const premium = users.filter((user) => user.plan === 'premium').length;
      const pending = requests.filter((request) => request.approvalStatus === 'requested').length;
      setAdminStat('members', users.length, 'Comptes charges');
      setAdminStat('premium', premium, 'Acces Premium actifs');
      setAdminStat('trading', tradingData.paused ? 'Pause' : 'Actif', tradingData.brokerConfigured ? 'Broker connecte' : 'Broker non connecte');
      setAdminStat('requests', pending, pending ? 'A traiter en priorite' : 'Aucune demande en attente');
      const uncertain = Array.isArray(tradingData.deliveryUnknownOrders) ? tradingData.deliveryUnknownOrders.length : 0;
      const state = uncertain ? 'critical' : tradingData.paused || !tradingData.brokerConfigured ? 'warning' : 'ok';
      const title = uncertain ? uncertain + ' ordre(s) a verifier' : tradingData.paused ? 'Trading en pause' : tradingData.brokerConfigured ? 'Systeme operationnel' : 'Broker non connecte';
      const detail = uncertain ? 'Ne jamais renvoyer un ordre ambigu avant verification broker.' : pending ? pending + ' demande(s) robot attendent une revue.' : 'Les controles principaux sont a jour.';
      setAdminOverviewState(state, title, detail);
      setMessage('Synthese admin actualisee.', false);
    } finally {
      if (adminOverviewRefresh) adminOverviewRefresh.disabled = false;
    }
  }
  function setAdminStat(key, value, meta) { const valueNode = document.querySelector('[data-admin-stat="' + key + '"]'); const metaNode = document.querySelector('[data-admin-stat-meta="' + key + '"]'); if (valueNode) valueNode.textContent = String(value); if (metaNode) metaNode.textContent = meta; }
  function setAdminOverviewState(state, title, detail) { const chip = document.querySelector('[data-admin-overall-status]'); const alert = document.querySelector('[data-admin-alerts]'); if (chip) { chip.dataset.state = state; chip.textContent = title; } if (alert) { alert.dataset.state = state; const strong = alert.querySelector('strong'); const text = alert.querySelector('div span'); if (strong) strong.textContent = title; if (text) text.textContent = detail; } const sync = document.querySelector('[data-admin-last-sync]'); if (sync) sync.textContent = 'Derniere mise a jour : ' + new Date().toLocaleTimeString('fr-FR'); }
  adminOverviewRefresh?.addEventListener('click', refreshAdminOverview);
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

  // Mirrors server.mjs's recordAutoTradeStatus reason codes -- lets the admin see
  // directly, per account, why the bot did or didn't trade on its last pass instead
  // of guessing between "a limit is bugged" and "it's correctly waiting" (the two
  // reports -- limits looking ignored, 8h+ of silence -- that motivated this).
  const AUTOTRADE_TICK_REASON_LABELS = {
    outside_admin_trading_hours: "Hors horaires admin",
    outside_admin_trading_days: "Jour non autorisé (admin)",
    outside_user_trading_hours: "Hors horaires utilisateur",
    outside_user_trading_days: "Jour non autorisé (utilisateur)",
    no_approved_pairs: "Aucune paire approuvée",
    no_signal_meets_confidence_or_rr: "Aucun signal n'atteint le seuil confiance/R:R",
    daily_loss_limit_percent_reached: "Limite de perte quotidienne (%) atteinte",
    daily_loss_limit_amount_reached: "Limite de perte quotidienne ($) atteinte",
    weekly_loss_limit_percent_reached: "Limite de perte hebdomadaire (%) atteinte",
    weekly_loss_limit_amount_reached: "Limite de perte hebdomadaire ($) atteinte",
    monthly_loss_limit_percent_reached: "Limite de perte mensuelle (%) atteinte",
    monthly_loss_limit_amount_reached: "Limite de perte mensuelle ($) atteinte",
    max_concurrent_positions_reached: "Max positions ouvertes atteint",
    max_trades_per_day_reached: "Max trades/jour atteint",
    broker_unreachable: "Broker injoignable au dernier passage",
    opened_trade: "Position ouverte au dernier passage",
    no_valid_setup_this_tick: "Signal(s) repéré(s), aucun n'a passé les vérifications finales",
    globally_paused_by_admin: "Trading suspendu globalement",
    no_tradable_market_signals_this_tick: "Aucun signal exploitable sur le marché (normal)",
  };
  const TICK_DAY_NAMES = ["Dim", "Lun", "Mar", "Mer", "Jeu", "Ven", "Sam"]; // matches JS getUTCDay()

  // Mirrors auth.js's formatTickDetail -- confirmed live this session that the
  // reason label alone ("no_valid_setup_this_tick") gave the admin no way to
  // tell dedup/correlation/broker-spec/sizing/broker-rejection apart.
  function formatTickDetail(reason, detail) {
    if (!detail) return "";
    const parts = [];
    if (reason === "no_valid_setup_this_tick") {
      if (detail.candidateCount) parts.push(`${detail.candidateCount} signal(s) évalué(s)`);
      if (detail.alreadyOpen) parts.push(`${detail.alreadyOpen} déjà ouvert(s)`);
      if (detail.correlation) parts.push(`${detail.correlation} bloqué(s) par corrélation`);
      if (detail.noSpec) parts.push(`${detail.noSpec} specs broker indisponibles`);
      if (detail.noVolume) parts.push(`${detail.noVolume} taille de position trop petite`);
      if (detail.rejected) parts.push(`${detail.rejected} rejeté(s) par le broker`);
    } else if (reason === "no_signal_meets_confidence_or_rr") {
      if (detail.minConfidence != null) parts.push(`seuil confiance ${detail.minConfidence}%`);
      if (detail.minRiskReward) parts.push(`R:R min ${detail.minRiskReward}`);
      if (detail.approvedPairs?.length) parts.push(`paires : ${detail.approvedPairs.join(", ")}`);
    } else if (reason === "max_concurrent_positions_reached") {
      parts.push(`${detail.openCount}/${detail.maxConcurrent}`);
    } else if (reason === "max_trades_per_day_reached") {
      parts.push(`${detail.tradesOpenedToday}/${detail.maxTradesPerDay}`);
    } else if (reason === "daily_loss_limit_percent_reached") {
      parts.push(`limite ${detail.dailyLossLimitPercent}%`);
    } else if (reason === "daily_loss_limit_amount_reached") {
      parts.push(`limite ${detail.dailyLossLimitAmount}`);
    } else if (reason === "weekly_loss_limit_percent_reached") {
      parts.push(`limite ${detail.weeklyLossLimitPercent}%`);
    } else if (reason === "weekly_loss_limit_amount_reached") {
      parts.push(`limite ${detail.weeklyLossLimitAmount}`);
    } else if (reason === "monthly_loss_limit_percent_reached") {
      parts.push(`limite ${detail.monthlyLossLimitPercent}%`);
    } else if (reason === "monthly_loss_limit_amount_reached") {
      parts.push(`limite ${detail.monthlyLossLimitAmount}`);
    } else if (reason === "outside_admin_trading_hours" || reason === "outside_user_trading_hours") {
      if (detail.tradingHoursStart && detail.tradingHoursEnd) parts.push(`${detail.tradingHoursStart}-${detail.tradingHoursEnd} UTC`);
    } else if (reason === "outside_admin_trading_days" || reason === "outside_user_trading_days") {
      if (detail.tradingDays) parts.push(`jours autorisés : ${String(detail.tradingDays).split(",").map((d) => TICK_DAY_NAMES[Number(d)]).join(", ")}`);
    }
    return parts.length ? ` [${parts.join(", ")}]` : "";
  }

  function autoTradeTickSummary(lastTick) {
    if (!lastTick) return "Pas encore évalué depuis le dernier démarrage serveur";
    const label = AUTOTRADE_TICK_REASON_LABELS[lastTick.reason] || lastTick.reason;
    return `${label}${formatTickDetail(lastTick.reason, lastTick.detail)} (${formatDate(lastTick.at)})`;
  }

  const autotradeLoad = document.querySelector("[data-autotrade-load]");
  const autotradeRequests = document.querySelector("[data-autotrade-requests]");

  autotradeLoad?.addEventListener("click", async () => {
    if (autotradeLoad.disabled) return;
    autotradeLoad.disabled = true;
    const token = form?.elements?.token?.value || "";
    setMessage("Chargement des demandes...", false);
    const data = await adminFetch("/api/admin/auto-trade/requests", null, token);
    if (!data?.ok) {
      setMessage(data?.message || data?.error || "Chargement impossible.", true);
      autotradeLoad.disabled = false;
      return;
    }
    setMessage(`${data.requests.length} demande(s) chargée(s).`, false);
    renderAutoTradeRequests(data.requests);
    autotradeLoad.disabled = false;
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
            · démo ${request.demo?.brokerConnected ? "connecté" : "non connecté"} · réel ${request.live?.brokerConnected ? "connecté" : "non connecté"}
          </span>
          ${request.approvalStatus === "approved" ? `
            <span class="dashboard-autotrade-hint">Démo -- dernier passage : ${escapeHtml(autoTradeTickSummary(request.demo?.lastTick))}</span>
            <span class="dashboard-autotrade-hint">Réel -- dernier passage : ${escapeHtml(autoTradeTickSummary(request.live?.lastTick))}</span>
          ` : ""}
          <div class="dashboard-live-authorize">
            <label class="dashboard-slot-switch">
              <input type="checkbox" data-authorize-live ${request.live?.authorized ? "checked" : ""}>
              Autoriser le réel${request.live?.authorized ? ` (accordé le ${formatDate(request.live.authorizedAt)}${request.live.authorizedBy ? ` par ${escapeHtml(request.live.authorizedBy)}` : ""})` : ""}
            </label>
          </div>
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
            <input type="number" min="1" max="20" step="1" value="${request.maxConcurrentPositions ?? 2}" data-field="maxConcurrentPositions">
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
          <label class="dashboard-autotrade-field">Perte max / semaine (%) <span class="dashboard-autotrade-hint">(0 = pas de plafond)</span>
            <input type="number" min="0" max="50" step="0.5" value="${request.weeklyLossLimitPercent ?? 0}" data-field="weeklyLossLimitPercent">
          </label>
          <label class="dashboard-autotrade-field">Perte max / semaine (montant) <span class="dashboard-autotrade-hint">(0 = pas de plafond)</span>
            <input type="number" min="0" step="1" value="${request.weeklyLossLimitAmount ?? 0}" data-field="weeklyLossLimitAmount">
          </label>
          <label class="dashboard-autotrade-field">Perte max / mois (%) <span class="dashboard-autotrade-hint">(0 = pas de plafond)</span>
            <input type="number" min="0" max="90" step="0.5" value="${request.monthlyLossLimitPercent ?? 0}" data-field="monthlyLossLimitPercent">
          </label>
          <label class="dashboard-autotrade-field">Perte max / mois (montant) <span class="dashboard-autotrade-hint">(0 = pas de plafond)</span>
            <input type="number" min="0" step="1" value="${request.monthlyLossLimitAmount ?? 0}" data-field="monthlyLossLimitAmount">
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
          weeklyLossLimitPercent: field("weeklyLossLimitPercent"), weeklyLossLimitAmount: field("weeklyLossLimitAmount"),
          monthlyLossLimitPercent: field("monthlyLossLimitPercent"), monthlyLossLimitAmount: field("monthlyLossLimitAmount"),
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

    // One-time, durable grant -- unlike everything else in this card, this
    // doesn't wait for "Approuver" to save. Checking it authorizes real money
    // on this account immediately; unchecking it revokes immediately, live
    // and demo bookkeeping otherwise untouched (see server.mjs activeBrokerSlots).
    autotradeRequests.querySelectorAll("[data-authorize-live]").forEach((checkbox) => {
      checkbox.addEventListener("change", async () => {
        const card = checkbox.closest("[data-autotrade-request-card]");
        const userId = card?.dataset.autotradeRequestCard;
        const token = form?.elements?.token?.value || "";
        if (!token) { setMessage("Renseigne le token admin avant d'autoriser le réel.", true); checkbox.checked = !checkbox.checked; return; }
        const authorized = checkbox.checked;
        if (authorized && !window.confirm("Autoriser ce compte à trader avec de l'ARGENT RÉEL ? Le propriétaire du compte pourra ensuite activer/désactiver le réel librement, sans repasser par toi à chaque fois.")) {
          checkbox.checked = false;
          return;
        }
        checkbox.disabled = true;
        const data = await adminFetch("/api/admin/auto-trade/authorize-live", { token, userId, authorized });
        checkbox.disabled = false;
        if (!data?.ok) { setMessage(data?.message || data?.error || "Action impossible.", true); checkbox.checked = !authorized; return; }
        setMessage(authorized ? "Réel autorisé pour ce compte." : "Autorisation du réel révoquée.", false);
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
