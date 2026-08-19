(() => {
  document.querySelectorAll("[data-password-strength]").forEach((meter) => {
    const input = meter.closest("form")?.querySelector('input[type="password"][autocomplete="new-password"]');
    const fill = meter.querySelector("[data-password-strength-fill]");
    const label = meter.querySelector("[data-password-strength-label]");
    if (!input || !fill || !label) return;

    const LEVELS = [
      { min: 0, key: "weak", text: "Faible" },
      { min: 2, key: "fair", text: "Moyen" },
      { min: 3, key: "good", text: "Bon" },
      { min: 4, key: "strong", text: "Excellent" },
    ];

    function scorePassword(value) {
      let score = 0;
      if (value.length >= 8) score += 1;
      if (value.length >= 12) score += 1;
      if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
      if (/[0-9]/.test(value)) score += 1;
      if (/[^a-zA-Z0-9]/.test(value)) score += 1;
      return score;
    }

    input.addEventListener("input", () => {
      const value = input.value;
      if (!value) {
        meter.hidden = true;
        return;
      }
      meter.hidden = false;
      const score = scorePassword(value);
      const level = [...LEVELS].reverse().find((l) => score >= l.min) || LEVELS[0];
      fill.style.width = `${Math.min(100, (score / 5) * 100)}%`;
      fill.dataset.level = level.key;
      label.textContent = `Force du mot de passe : ${level.text}`;
    });
  });

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

    // Without this, a failed login left its red error message on screen
    // indefinitely while the user retyped -- looked like the new attempt was
    // still wrong even before they'd resubmitted anything.
    form.addEventListener("input", () => {
      if (message?.classList.contains("error")) setMessage("", false);
    });
  }

  const forgotForm = document.querySelector("[data-forgot-password-form]");
  if (forgotForm) {
    forgotForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = forgotForm.querySelector("button[type='submit']");
      button.disabled = true;
      setMessage("Envoi en cours...", false);
      try {
        const body = Object.fromEntries(new FormData(forgotForm).entries());
        const response = await fetch("/api/forgot-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.message || data.error || "Action impossible.");
        setMessage(data.message || "Si un compte existe pour cet email, un lien a été envoyé.", false);
        forgotForm.reset();
      } catch (error) {
        setMessage(error.message || "Erreur de connexion.", true);
      } finally {
        button.disabled = false;
      }
    });
  }

  const resetForm = document.querySelector("[data-reset-password-form]");
  if (resetForm) {
    resetForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = resetForm.querySelector("button[type='submit']");
      const token = new URLSearchParams(window.location.search).get("token") || "";
      if (!token) {
        setMessage("Lien invalide : ouvre le lien reçu par email.", true);
        return;
      }
      button.disabled = true;
      setMessage("Mise à jour...", false);
      try {
        const body = { ...Object.fromEntries(new FormData(resetForm).entries()), token };
        const response = await fetch("/api/reset-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || "Action impossible.");
        setMessage("Mot de passe mis à jour. Redirection...", false);
        setTimeout(() => { window.location.href = "/login"; }, 1500);
      } catch (error) {
        setMessage(error.message || "Erreur de connexion.", true);
        button.disabled = false;
      }
    });
  }

  if (document.querySelector(".dashboard-main")) {
    loadDashboard();
  }

  syncAuthNav();

  // Nav/CTA links used to be static HTML that never reflected who was actually
  // looking at the page -- "Connexion" and the "Dashboard" button shown together
  // regardless of session, "Tester gratuitement" offered to people who already pay,
  // "S'abonner maintenant" offered to people who already have premium. One /api/me
  // call updates every page that opts in via these data attributes; pages with none
  // of them (nothing matched below) skip the network call entirely.
  async function syncAuthNav() {
    const loginLinks = document.querySelectorAll("[data-nav-login]");
    const dashboardLinks = document.querySelectorAll("[data-nav-dashboard]");
    const trialLinks = document.querySelectorAll("[data-cta-trial]");
    const paymentStatus = document.querySelectorAll("[data-payment-status]");
    const paymentForms = document.querySelectorAll("[data-payment-form]");
    const pricingLinks = document.querySelectorAll("[data-nav-pricing]");
    if (!loginLinks.length && !dashboardLinks.length && !trialLinks.length && !paymentStatus.length && !paymentForms.length && !pricingLinks.length) return;

    const me = await fetchJson("/api/me");
    const loggedIn = Boolean(me?.ok);
    const premium = loggedIn && String(me.user?.plan || "").toLowerCase() === "premium";

    loginLinks.forEach((el) => { el.hidden = loggedIn; });
    dashboardLinks.forEach((el) => { el.hidden = !loggedIn; });
    trialLinks.forEach((el) => {
      if (premium) el.textContent = "Nouvelle analyse";
      else if (loggedIn) el.textContent = "Lancer une analyse";
    });
    paymentStatus.forEach((el) => { el.hidden = !premium; });
    paymentForms.forEach((el) => { el.hidden = premium; });
    // Already premium: seeing "Abonnement"/"S'abonner" in the nav next to your own
    // account is confusing, not just redundant -- it reads as "you haven't paid yet".
    pricingLinks.forEach((el) => { el.hidden = premium; });
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
    const planLabel = String(me.user.plan || "free").toLowerCase() === "premium" ? "PREMIUM" : "GRATUIT";
    document.querySelector("[data-user-plan]").textContent = planLabel;

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

    const isPremium = String(me.user.plan || "").toLowerCase() === "premium";
    const personal = await fetchJson("/api/my-analyses");
    renderPersonalHistory(personal, isPremium);
    initPush(isPremium);
    loadBrokerPanel(isPremium);
    loadTradeOrders(isPremium);
    loadAutoTrade(isPremium);
    startLivePositionsPolling();
    startNotificationsFallback();
  }

  // Real floating P&L for whichever open positions are currently rendered on the
  // page, refreshed every 10s -- not a websocket/true push, but close enough that
  // the dashboard stops looking frozen between the 90s server-side outcome-
  // scheduler ticks. Purely additive: matches cards by data-broker-order-id (set
  // by renderTradeOrders/loadAutoTradeHistory) and only touches the ones it finds
  // a live position for -- a card with no match (position already closed, or the
  // user has no broker connected at all) is left exactly as the order-list
  // rendering already drew it.
  let livePositionsPollStarted = false;
  function startLivePositionsPolling() {
    if (livePositionsPollStarted) return;
    if (!document.querySelector("[data-trade-panel], [data-autotrade-panel]")) return;
    livePositionsPollStarted = true;
    refreshLivePositions();
    setInterval(refreshLivePositions, 10000);
  }

  async function refreshLivePositions() {
    const slots = document.querySelectorAll("[data-broker-order-id]:not([data-broker-order-id=''])");
    if (!slots.length) return;
    const data = await fetchJson("/api/trade/live-positions");
    const positions = new Map((data?.positions || []).map((p) => [p.id, p]));
    slots.forEach((card) => {
      const pnlEl = card.querySelector("[data-live-pnl]");
      if (!pnlEl) return;
      const position = positions.get(card.dataset.brokerOrderId);
      if (!position) {
        pnlEl.hidden = true; // no longer an open position at the broker -- next full refresh will show its real outcome
        return;
      }
      pnlEl.hidden = false;
      pnlEl.textContent = `${position.profit >= 0 ? "+" : ""}${position.profit.toFixed(2)}`;
      pnlEl.classList.toggle("is-negative", position.profit < 0);
    });
  }

  // Fallback for a user who never granted push permission (dismissed the prompt,
  // a mobile browser quirk, whatever the reason) -- without this they get zero
  // real-time signal a trade opened or closed, silently, forever. Polls the same
  // event set the push notifications cover (see /api/notifications/summary), so
  // it can never show something push wouldn't have also said.
  let notificationsFallbackStarted = false;
  function startNotificationsFallback() {
    if (notificationsFallbackStarted) return;
    const wrap = document.querySelector("[data-notif-wrap]");
    if (!wrap) return;
    notificationsFallbackStarted = true;
    wrap.hidden = false;
    const bell = wrap.querySelector("[data-notif-bell]");
    const panel = wrap.querySelector("[data-notif-panel]");
    bell.addEventListener("click", () => {
      const opening = panel.hidden;
      panel.hidden = !panel.hidden;
      if (opening) markNotificationsSeen();
    });
    document.addEventListener("click", (event) => {
      if (!panel.hidden && !wrap.contains(event.target)) panel.hidden = true;
    });
    refreshNotifications();
    setInterval(refreshNotifications, 20000);
  }

  async function refreshNotifications() {
    const wrap = document.querySelector("[data-notif-wrap]");
    if (!wrap) return;
    const data = await fetchJson("/api/notifications/summary");
    if (!data?.ok) return;
    const badge = wrap.querySelector("[data-notif-badge]");
    badge.hidden = !data.count;
    badge.textContent = data.count > 9 ? "9+" : String(data.count);
    const list = wrap.querySelector("[data-notif-list]");
    const empty = wrap.querySelector("[data-notif-empty]");
    const items = data.items || [];
    empty.hidden = items.length > 0;
    const NOTIF_VISIBLE = 5;
    const cards = items.map((item) => {
      const label = item.type === "opened" ? "Position ouverte" : `${historyStatusIcon(item)}${historyStatusLabel(item)}`;
      return `<div class="auth-notif-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(item.pair)} · ${escapeHtml(item.direction)}</strong><small>${formatDate(item.at)}</small></div>`;
    });
    const rest = cards.slice(NOTIF_VISIBLE);
    list.innerHTML = cards.slice(0, NOTIF_VISIBLE).join("")
      + (rest.length ? `<button type="button" class="dashboard-history-more" data-notif-more>Voir ${rest.length} de plus</button>` : "");
    list.querySelector("[data-notif-more]")?.addEventListener("click", function () {
      this.insertAdjacentHTML("beforebegin", rest.join(""));
      this.remove();
    });
  }

  async function markNotificationsSeen() {
    await fetch("/api/notifications/mark-seen", { method: "POST" }).catch(() => {});
    const badge = document.querySelector("[data-notif-badge]");
    if (badge) badge.hidden = true;
  }

  // Shared by both the semi-automatic flow and the autonomous bot -- a user
  // connects their broker exactly once here, instead of the connect form being
  // buried inside the bot panel like it used to be (which made it look like
  // semi-automatic trades needed a second, separate connection).
  function loadBrokerPanel(isPremium) {
    const panel = document.querySelector("[data-broker-panel]");
    if (!panel) return;
    panel.hidden = !isPremium;
    if (isPremium) bindAutoTradeBrokerForm();
  }

  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64Safe);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  const PUSH_TOPIC_LABELS = {
    tp_sl: { on: "Désactiver les notifications de trades", off: "Activer les notifications de trades", active: "Notifications d'ouverture/clôture de trades actives sur cet appareil." },
    new_signal: { on: "Désactiver les alertes nouveaux signaux", off: "Activer les alertes nouveaux signaux", active: "Alertes nouveaux signaux actives sur cet appareil." },
  };

  // One browser only ever exposes one PushManager subscription per device, but it
  // carries several independently-toggled topics server-side (see
  // /api/push/subscribe's topic param) -- "new_signal" (alerts the moment Kronos
  // detects a fresh high-confidence setup, not tied to a personal analysis) is
  // premium-only, "tp_sl" (one of your trades opened or closed) is open to everyone.
  async function initPush(isPremium) {
    const buttons = [...document.querySelectorAll("[data-push-toggle]")].filter((button) => {
      return button.dataset.pushToggle !== "new_signal" || isPremium;
    });
    const upsell = document.querySelector("[data-push-upsell]");
    if (!buttons.length) return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    const vapid = await fetchJson("/api/push/vapid-public-key");
    if (!vapid?.configured) return;
    if (upsell && !isPremium) upsell.hidden = false;

    const registration = await navigator.serviceWorker.register("/sw.js");
    const existing = await registration.pushManager.getSubscription();
    const activeTopics = new Set(
      existing ? (await fetchJson(`/api/push/subscription-topics?endpoint=${encodeURIComponent(existing.endpoint)}`))?.topics || [] : [],
    );

    buttons.forEach((button) => {
      const topic = button.dataset.pushToggle;
      const status = document.querySelector(`[data-push-status="${topic}"]`);
      setPushButtonState(button, status, topic, activeTopics.has(topic));

      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const current = await registration.pushManager.getSubscription();
          if (activeTopics.has(topic)) {
            if (current) {
              if (activeTopics.size > 1) {
                await fetch("/api/push/unsubscribe-topic", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ endpoint: current.endpoint, topic }),
                });
              } else {
                await fetch("/api/push/unsubscribe", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ endpoint: current.endpoint }),
                });
                await current.unsubscribe();
              }
            }
            activeTopics.delete(topic);
            setPushButtonState(button, status, topic, false);
            return;
          }
          let subscription = current;
          if (!subscription) {
            const permission = await Notification.requestPermission();
            if (permission !== "granted") {
              if (status) status.textContent = "Notifications refusées dans le navigateur.";
              return;
            }
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(vapid.publicKey),
            });
          }
          await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...subscription.toJSON(), topic }),
          });
          activeTopics.add(topic);
          setPushButtonState(button, status, topic, true);
        } catch (error) {
          if (status) status.textContent = "Notifications indisponibles sur cet appareil.";
        } finally {
          button.disabled = false;
        }
      });

      // Only reveal the button once the click handler above is actually wired up --
      // showing it earlier (right after the VAPID check) meant a fast click during
      // service-worker registration silently did nothing, no listener attached yet.
      button.hidden = false;
    });
  }

  function setPushButtonState(button, status, topic, active) {
    const labels = PUSH_TOPIC_LABELS[topic] || PUSH_TOPIC_LABELS.tp_sl;
    button.textContent = active ? labels.on : labels.off;
    if (status) status.textContent = active ? labels.active : "";
  }

  function renderPersonalHistory(data, isPremium) {
    const host = document.querySelector("[data-dashboard-history]");
    const status = document.querySelector("[data-personal-status]");
    if (!host) return;
    if (status) {
      const total = data?.summary?.total ?? 0;
      const winRate = data?.summary?.winRate;
      const winRateText = Number.isFinite(winRate) ? ` · ${winRate}% de réussite` : "";
      status.textContent = total ? `${total} analyse${total > 1 ? "s" : ""}${winRateText}` : "Aucune analyse";
    }
    if (!Array.isArray(data?.analyses) || !data.analyses.length) {
      host.innerHTML = `<div class="dashboard-empty">Aucune analyse personnelle enregistrée pour ce compte. Lance une analyse depuis la page Analyse IA.</div>`;
      return;
    }
    // <details>/<summary> instead of always-expanded cards: with real history, 20
    // fully-expanded cards made the dashboard extremely long for no reason -- only
    // the pair/direction/status/date need to be visible to scan the list, the
    // levels/reason/duration only matter once you actually want that one trade.
    const cards = data.analyses.map((item) => `
      <details class="dashboard-history-item">
        <summary>
          <span class="dashboard-history-summary-main">
            <strong>${escapeHtml(item.pair)} · ${escapeHtml(item.direction)}</strong>
            <span class="${historyStatusClass(item)}">${historyStatusIcon(item)}${escapeHtml(historyStatusLabel(item))}</span>
          </span>
          <span class="dashboard-history-summary-date">${formatDate(item.createdAt)}</span>
        </summary>
        <div class="dashboard-history-detail">
          <span class="dashboard-history-meta">${escapeHtml(item.timeframe)} · ${escapeHtml(item.style)}</span>
          <div class="dashboard-history-levels">
            <button type="button" data-copy-level="${escapeHtml(item.entry)}">Entrée ${escapeHtml(item.entry)}</button>
            <button type="button" data-copy-level="${escapeHtml(item.sl)}">SL ${escapeHtml(item.sl)}</button>
            <button type="button" data-copy-level="${escapeHtml(item.tp1)}">TP1 ${escapeHtml(item.tp1)}</button>
            <button type="button" data-copy-level="${escapeHtml(item.tp2)}">TP2 ${escapeHtml(item.tp2)}</button>
          </div>
          ${historyDuration(item) ? `<p class="dashboard-history-note">Durée jusqu'à clôture : ${historyDuration(item)}</p>` : ""}
          ${historyDetailNote(item) ? `<p class="dashboard-history-note">${escapeHtml(historyDetailNote(item))}</p>` : ""}
          ${item.status === "OPEN" && isPremium ? `
            <button type="button" class="dashboard-trade-prepare" data-prepare-order="${escapeHtml(item.id)}">Préparer un ordre</button>
            <p class="dashboard-history-note dashboard-prepare-error" data-prepare-error hidden></p>
          ` : ""}
        </div>
      </details>
    `);
    // Rendering all of it at once (sometimes 20+ cards) made the dashboard scroll
    // forever for no reason -- only the first page needs to be in the DOM up front,
    // the rest reveals on demand instead of forcing everyone to scroll past history
    // they didn't ask to see yet.
    const PAGE_SIZE = 6;
    const rest = cards.slice(PAGE_SIZE);
    host.innerHTML = cards.slice(0, PAGE_SIZE).join("")
      + (rest.length ? `<button type="button" class="dashboard-history-more" data-history-more>Voir ${rest.length} analyse${rest.length > 1 ? "s" : ""} de plus</button>` : "");

    bindHistoryItemHandlers(host, isPremium);
    host.querySelector("[data-history-more]")?.addEventListener("click", function () {
      this.insertAdjacentHTML("beforebegin", rest.join(""));
      this.remove();
      bindHistoryItemHandlers(host, isPremium);
    });
  }

  const PREPARE_ERROR_LABELS = {
    premium_required: "Réservé aux comptes Premium.",
    analysis_not_found: "Analyse introuvable (peut-être déjà supprimée).",
    analysis_not_open: "Cette analyse n'est plus ouverte (déjà clôturée ou bloquée) -- il faut une analyse encore active.",
    invalid_request: "Requête invalide.",
    auth_required: "Session expirée -- reconnecte-toi.",
  };

  // Re-run after every reveal (initial page + each "Voir plus" click) so newly
  // inserted cards get working copy/prepare buttons too, not just the first batch.
  function bindHistoryItemHandlers(host, isPremium) {
    host.querySelectorAll("[data-copy-level]").forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = "1";
      button.addEventListener("click", async () => {
        await navigator.clipboard?.writeText(button.dataset.copyLevel || "");
        const original = button.textContent;
        button.textContent = "Copié";
        setTimeout(() => { button.textContent = original; }, 1400);
      });
    });
    host.querySelectorAll("[data-prepare-order]").forEach((button) => {
      if (button.dataset.bound) return;
      button.dataset.bound = "1";
      const errorEl = button.nextElementSibling?.hasAttribute("data-prepare-error") ? button.nextElementSibling : null;
      button.addEventListener("click", async () => {
        button.disabled = true;
        if (errorEl) errorEl.hidden = true;
        try {
          const response = await fetch("/api/trade/prepare", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ analysisId: button.dataset.prepareOrder }),
          });
          const result = await response.json();
          if (result.ok) {
            button.textContent = "Ordre préparé ✓";
            await loadTradeOrders(true);
          } else {
            button.disabled = false;
            if (errorEl) {
              errorEl.textContent = PREPARE_ERROR_LABELS[result.error] || `Échec (${result.error || "erreur inconnue"}).`;
              errorEl.hidden = false;
            }
          }
        } catch {
          button.disabled = false;
          if (errorEl) {
            errorEl.textContent = "Impossible de contacter le serveur -- vérifie ta connexion.";
            errorEl.hidden = false;
          }
        }
      });
    });
  }

  // Semi-automatic execution: Kronos only ever prepares an order ticket
  // (PENDING_CONFIRMATION) from an already-open analysis -- nothing reaches the
  // broker until the user picks a size and clicks "Confirmer et envoyer" below,
  // a separate explicit call to /api/trade/confirm. Premium-only.
  const TRADE_ORDER_LABELS = {
    PENDING_CONFIRMATION: "À valider",
    SENT: "Envoyé au broker",
    FAILED: "Échec d'envoi",
    CANCELLED: "Annulé",
  };

  async function loadTradeOrders(isPremium) {
    const panel = document.querySelector("[data-trade-panel]");
    const upsell = document.querySelector("[data-trade-upsell]");
    if (!panel) return;
    if (!isPremium) {
      if (upsell) upsell.hidden = false;
      return;
    }
    panel.hidden = false;
    const data = await fetchJson("/api/trade/orders");
    renderTradeOrders(data?.orders || [], Boolean(data?.brokerConfigured));
  }

  function renderTradeOrders(orders, brokerConfigured) {
    const statusEl = document.querySelector("[data-trade-broker-status]");
    if (statusEl) statusEl.textContent = brokerConfigured ? "Broker connecté" : "Broker non connecté";
    const prompt = document.querySelector("[data-trade-broker-prompt]");
    if (prompt) prompt.hidden = brokerConfigured;
    renderBrokerConnectStatus(brokerConfigured);
    const host = document.querySelector("[data-trade-orders]");
    if (!host) return;
    if (!orders.length) {
      host.innerHTML = `<div class="dashboard-empty">Aucun ordre préparé. Depuis une analyse ouverte ci-dessus, clique sur "Préparer un ordre".</div>`;
      return;
    }
    const clearableCount = orders.filter((order) => order.status === "CANCELLED" || order.status === "FAILED").length;
    // Cards beyond the 5th stay in the DOM (so their action handlers below still bind
    // normally) but start hidden -- "voir plus" just removes the attribute, no re-render.
    const VISIBLE_COUNT = 5;
    const orderCards = orders.map((order, index) => `
      <article class="dashboard-trade-order" data-order-id="${escapeHtml(order.id)}" data-broker-order-id="${escapeHtml(order.brokerOrderId || "")}" ${index >= VISIBLE_COUNT ? "hidden data-order-extra" : ""}>

        <div>
          <strong>${escapeHtml(order.pair)} · ${escapeHtml(order.direction)}</strong>
          <span>${formatDate(order.createdAt)} · ${escapeHtml(TRADE_ORDER_LABELS[order.status] || order.status)}${order.brokerOrderId ? ` · <span class="dashboard-live-pnl" data-live-pnl hidden></span>` : ""}</span>
        </div>
        <div class="dashboard-history-levels">
          <span>Entrée ${escapeHtml(order.entry)}</span>
          <span>SL ${escapeHtml(order.sl)}</span>
          <span>TP1 ${escapeHtml(order.tp1 ?? "—")}</span>
        </div>
        ${order.correlationWarning ? `<p class="dashboard-history-note dashboard-correlation-warning">⚠ ${escapeHtml(order.correlationWarning)}</p>` : ""}
        ${order.status === "PENDING_CONFIRMATION" ? `
          <div class="dashboard-trade-confirm">
            <input type="number" step="0.01" min="0.01" placeholder="Taille (lots)" data-order-volume>
            <button type="button" class="payment-method-button" data-order-confirm>Confirmer et envoyer</button>
            <button type="button" class="dashboard-trade-cancel" data-order-cancel>Annuler</button>
          </div>
          <p class="dashboard-history-note dashboard-prepare-error" data-confirm-error hidden></p>
        ` : ""}
        ${order.status === "FAILED" && order.errorMessage ? `<p class="dashboard-history-note">${escapeHtml(order.errorMessage)}</p>` : ""}
        ${order.status === "CANCELLED" || order.status === "FAILED" ? `
          <button type="button" class="dashboard-trade-cancel" data-order-clear>Retirer de la liste</button>
        ` : ""}
      </article>
    `).join("");
    const extraCount = orders.length - VISIBLE_COUNT;

    host.innerHTML = (clearableCount ? `
      <button type="button" class="dashboard-history-more" data-orders-clear-all>Vider les ${clearableCount} ordre${clearableCount > 1 ? "s" : ""} annulé${clearableCount > 1 ? "s" : ""}/échoué${clearableCount > 1 ? "s" : ""}</button>
    ` : "") + orderCards + (extraCount > 0 ? `
      <button type="button" class="dashboard-history-more" data-orders-more>Voir ${extraCount} ordre${extraCount > 1 ? "s" : ""} de plus</button>
    ` : "");

    host.querySelector("[data-orders-more]")?.addEventListener("click", function () {
      host.querySelectorAll("[data-order-extra]").forEach((card) => card.removeAttribute("hidden"));
      this.remove();
    });

    host.querySelector("[data-orders-clear-all]")?.addEventListener("click", async function () {
      this.disabled = true;
      try {
        await fetch("/api/trade/clear-all", { method: "POST" });
      } finally {
        await loadTradeOrders(true);
      }
    });
    host.querySelectorAll("[data-order-clear]").forEach((button) => {
      button.addEventListener("click", async () => {
        const orderId = button.closest("[data-order-id]").dataset.orderId;
        button.disabled = true;
        try {
          await fetch("/api/trade/clear", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId }),
          });
        } finally {
          await loadTradeOrders(true);
        }
      });
    });

    const CONFIRM_ERROR_LABELS = {
      price_unavailable: "Prix live indisponible -- impossible de vérifier que le setup tient toujours. Réessaie dans un instant.",
      order_expired: "Cet ordre a expiré (trop de temps écoulé depuis la préparation) et a été annulé automatiquement -- relance une analyse pour un ordre à jour.",
      levels_crossed_by_price: "Le prix a déjà dépassé le TP ou le SL depuis l'analyse -- ce setup n'a plus de sens au prix actuel. Relance une analyse.",
      levels_too_close_to_price: "Le SL ou le TP est trop proche du prix actuel pour être accepté par le broker maintenant. Relance une analyse.",
      trading_paused: "Trading suspendu temporairement par l'administrateur.",
      daily_order_cap_reached: "Limite quotidienne d'ordres atteinte.",
      broker_not_connected: "Tu dois d'abord connecter ton broker (section \"Connexion broker\" ci-dessus) avant d'envoyer un ordre réel.",
    };

    host.querySelectorAll("[data-order-confirm]").forEach((button) => {
      button.addEventListener("click", async () => {
        const article = button.closest("[data-order-id]");
        const orderId = article.dataset.orderId;
        const volumeInput = article.querySelector("[data-order-volume]");
        const volume = Number(volumeInput.value);
        const errorEl = article.querySelector("[data-confirm-error]");
        if (!Number.isFinite(volume) || volume <= 0) {
          volumeInput.focus();
          return;
        }
        button.disabled = true;
        if (errorEl) errorEl.hidden = true;
        // price_moved/price_unavailable/trading_paused/daily_order_cap_reached all
        // reject the confirm attempt without touching the order (still
        // PENDING_CONFIRMATION server-side) -- reloading the list would wipe this
        // message off the screen the instant it appears, for no reason, since
        // nothing about the order actually changed. Only reload when the order's
        // real status did (sent/failed/expired).
        const ORDER_UNCHANGED_ERRORS = new Set(["price_moved", "price_unavailable", "levels_crossed_by_price", "levels_too_close_to_price", "trading_paused", "daily_order_cap_reached", "broker_not_connected"]);
        try {
          const response = await fetch("/api/trade/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId, volume }),
          });
          const result = await response.json().catch(() => ({}));
          if (result.ok) {
            await loadTradeOrders(true);
            return;
          }
          if (errorEl) {
            errorEl.textContent = result.error === "price_moved"
              ? `Le prix a bougé de ${result.distancePercent}% depuis l'analyse (tolérance ${result.tolerancePercent}%) -- confirmation refusée pour ta sécurité. Relance une analyse pour un prix à jour, ou annule cet ordre.`
              : CONFIRM_ERROR_LABELS[result.error] || `Échec (${result.error || "erreur inconnue"}).`;
            errorEl.hidden = false;
          }
          if (!ORDER_UNCHANGED_ERRORS.has(result.error)) {
            await loadTradeOrders(true);
          } else {
            button.disabled = false;
          }
        } catch {
          if (errorEl) {
            errorEl.textContent = "Impossible de contacter le serveur -- vérifie ta connexion.";
            errorEl.hidden = false;
          }
          button.disabled = false;
        }
      });
    });

    host.querySelectorAll("[data-order-cancel]").forEach((button) => {
      button.addEventListener("click", async () => {
        const orderId = button.closest("[data-order-id]").dataset.orderId;
        button.disabled = true;
        try {
          await fetch("/api/trade/cancel", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId }),
          });
        } finally {
          await loadTradeOrders(true);
        }
      });
    });
  }

  // Fully autonomous execution: separate from the semi-automatic panel above.
  // Requires premium AND a connected broker AND a separate admin approval -- this
  // function only ever reads/reflects state, the approval decision itself happens
  // in the admin panel (assets/premium-admin.js).
  const AUTOTRADE_STATUS_LABELS = {
    none: "Pas encore demandée",
    requested: "Demande envoyée -- en attente d'approbation",
    approved: "Actif",
    rejected: "Demande refusée",
    revoked: "Accès révoqué",
    expired: "Approbation expirée -- redemande l'activation",
  };

  async function loadAutoTrade(isPremium) {
    const panel = document.querySelector("[data-autotrade-panel]");
    const upsell = document.querySelector("[data-autotrade-upsell]");
    if (!panel) return;
    if (!isPremium) {
      if (upsell) upsell.hidden = false;
      return;
    }
    panel.hidden = false;
    bindAutoTradeBrokerForm();
    await refreshAutoTradeStatus();
  }

  function bindAutoTradeBrokerForm() {
    bindAutoTradePreferences();
    const form = document.querySelector("[data-autotrade-broker-form]");
    if (!form || form.dataset.bound) return;
    form.dataset.bound = "1";
    const message = document.querySelector("[data-autotrade-broker-message]");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const token = form.querySelector("[data-autotrade-token]").value.trim();
      const accountId = form.querySelector("[data-autotrade-account-id]").value.trim();
      const region = form.querySelector("[data-autotrade-region]").value.trim() || "london";
      if (!token || !accountId) return;
      const submitButton = form.querySelector('button[type="submit"]');
      submitButton.disabled = true;
      if (message) message.hidden = true;
      try {
        const response = await fetch("/api/auto-trade/broker/connect", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, accountId, region }),
        });
        const result = await response.json();
        if (result.ok) {
          form.reset();
          form.querySelector("[data-autotrade-region]").value = "london";
        } else if (message) {
          message.textContent = result.message ? `Connexion refusée : ${result.message}` : `Échec (${result.error || "erreur inconnue"}).`;
          message.hidden = false;
        }
      } catch {
        if (message) { message.textContent = "Impossible de contacter le serveur -- vérifie ta connexion."; message.hidden = false; }
      } finally {
        submitButton.disabled = false;
        // The broker connection is shared by both flows -- reflect it in both
        // panels immediately, not just the one the form happens to live in.
        await Promise.all([refreshAutoTradeStatus(), loadTradeOrders(true)]);
      }
    });

    document.querySelector("[data-autotrade-broker-disconnect]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await fetch("/api/auto-trade/broker/disconnect", { method: "POST" });
      } finally {
        await Promise.all([refreshAutoTradeStatus(), loadTradeOrders(true)]);
      }
    });

    document.querySelector("[data-autotrade-request]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await fetch("/api/auto-trade/request", { method: "POST" });
      } finally {
        await refreshAutoTradeStatus();
      }
    });

    document.querySelector("[data-autotrade-pause]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await fetch("/api/auto-trade/pause", { method: "POST" });
      } finally {
        await refreshAutoTradeStatus();
      }
    });

    document.querySelector("[data-autotrade-resume]")?.addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await fetch("/api/auto-trade/resume", { method: "POST" });
      } finally {
        await refreshAutoTradeStatus();
      }
    });
  }

  // The single broker connection (auto_trading_accounts) backs both the
  // semi-automatic panel and the bot panel -- one function toggles the shared
  // connect-form/"connected" display so both panels always agree, instead of each
  // keeping its own copy of the same toggle logic.
  function renderBrokerConnectStatus(connected) {
    const brokerConnected = document.querySelector("[data-autotrade-broker-connected]");
    const brokerForm = document.querySelector("[data-autotrade-broker-form]");
    if (brokerConnected) brokerConnected.hidden = !connected;
    if (brokerForm) brokerForm.hidden = connected;
  }

  async function refreshAutoTradeStatus() {
    const status = await fetchJson("/api/auto-trade/status");
    if (!status?.ok) return;

    const badge = document.querySelector("[data-autotrade-status-badge]");
    if (badge) badge.textContent = AUTOTRADE_STATUS_LABELS[status.approvalStatus] || status.approvalStatus;

    renderBrokerConnectStatus(status.brokerConnected);

    const activationSection = document.querySelector("[data-autotrade-activation-section]");
    if (activationSection) activationSection.hidden = !status.brokerConnected;

    const statusText = document.querySelector("[data-autotrade-status-text]");
    const requestButton = document.querySelector("[data-autotrade-request]");
    const pauseButton = document.querySelector("[data-autotrade-pause]");
    const resumeButton = document.querySelector("[data-autotrade-resume]");
    const metrics = document.querySelector("[data-autotrade-metrics]");
    const historySection = document.querySelector("[data-autotrade-history-section]");

    if (requestButton) requestButton.hidden = true;
    if (pauseButton) pauseButton.hidden = true;
    if (resumeButton) resumeButton.hidden = true;
    if (metrics) metrics.hidden = true;
    if (historySection) historySection.hidden = true;

    if (status.approvalStatus === "none" || status.approvalStatus === "rejected" || status.approvalStatus === "expired") {
      if (statusText) {
        statusText.textContent = status.approvalStatus === "rejected" && status.rejectReason
          ? `Demande refusée : ${status.rejectReason}`
          : "Connecte ton broker ci-dessus, puis demande l'activation. Un administrateur doit approuver le compte avant que le robot ne trade réellement.";
      }
      if (requestButton) requestButton.hidden = false;
    } else if (status.approvalStatus === "requested") {
      if (statusText) statusText.textContent = "Demande envoyée -- en attente d'approbation par un administrateur.";
    } else if (status.approvalStatus === "revoked") {
      if (statusText) statusText.textContent = "L'accès au trading automatique a été révoqué.";
    } else if (status.approvalStatus === "approved") {
      const until = status.approvedUntil ? formatDate(status.approvedUntil) : "";
      if (statusText) {
        statusText.textContent = status.userPaused
          ? `En pause (approuvé jusqu'au ${until}).`
          : `Actif jusqu'au ${until} · paires : ${status.approvedPairs.join(", ") || "aucune"} · risque ${status.riskPercent}% par trade.`;
      }
      if (pauseButton) pauseButton.hidden = status.userPaused;
      if (resumeButton) resumeButton.hidden = !status.userPaused;
      if (metrics) {
        metrics.hidden = false;
        metrics.innerHTML = [
          ["Positions ouvertes", `${status.openPositions} / ${status.maxConcurrentPositions ?? "—"}`],
          ["P&L du jour", `${status.dailyPnlPercent >= 0 ? "+" : ""}${status.dailyPnlPercent}%`],
          ["Limite de perte/jour", `${status.dailyLossLimitPercent ?? "—"}%`],
          ["Seuil de confiance", `${Math.max(status.minConfidenceFloor || 0, status.userMinConfidence || 0)}%`],
        ].map(([label, value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
      }
      if (historySection) historySection.hidden = false;
      renderAutoTradePreferences(status);
      await loadAutoTradeHistory();
    }
  }

  // Every admin-set bot parameter has a user-side counterpart the account owner
  // can tighten further (never loosen -- server-side combineTightened() is what
  // actually enforces that, this is just the UI for it). Hints show the admin's
  // real current value next to each field so it's never a mystery what "leave
  // blank" defers to -- the exact kind of invisible-mismatch confusion the
  // minConfidenceFloor/userMinConfidence pair caused before this UI existed.
  const AUTOTRADE_PREF_FIELDS = [
    ["userRiskPercent", "riskPercent", (v) => `${v}%`],
    ["userMinConfidence", "minConfidenceFloor", (v) => `${v}%`],
    ["userMinRiskReward", "minRiskReward", (v) => v],
    ["userMaxConcurrentPositions", "maxConcurrentPositions", (v) => v],
    ["userMaxTradesPerDay", "maxTradesPerDay", (v) => v],
    ["userDailyLossLimitPercent", "dailyLossLimitPercent", (v) => `${v}%`],
    ["userDailyLossLimitAmount", "dailyLossLimitAmount", (v) => v],
  ];

  function renderAutoTradePreferences(status) {
    const section = document.querySelector("[data-autotrade-preferences-section]");
    if (!section) return;
    section.hidden = false;
    for (const [prefKey, adminKey, format] of AUTOTRADE_PREF_FIELDS) {
      const input = section.querySelector(`[data-pref="${prefKey}"]`);
      if (input && document.activeElement !== input) input.value = status[prefKey] ?? "";
      const hint = section.querySelector(`[data-pref-hint="${adminKey}"]`);
      if (hint) hint.textContent = status[adminKey] != null ? `(admin : ${format(status[adminKey])})` : "(admin : aucune limite)";
    }
    const hoursStart = section.querySelector('[data-pref="userTradingHoursStart"]');
    const hoursEnd = section.querySelector('[data-pref="userTradingHoursEnd"]');
    if (hoursStart && document.activeElement !== hoursStart) hoursStart.value = status.userTradingHoursStart || "";
    if (hoursEnd && document.activeElement !== hoursEnd) hoursEnd.value = status.userTradingHoursEnd || "";
    const daysWrap = section.querySelector("[data-pref-trading-days]");
    if (daysWrap) {
      daysWrap.querySelectorAll("input").forEach((box) => {
        box.checked = !status.userTradingDays || status.userTradingDays.includes(Number(box.value));
      });
    }
  }

  function bindAutoTradePreferences() {
    const button = document.querySelector("[data-autotrade-preferences-save]");
    if (!button || button.dataset.bound) return;
    button.dataset.bound = "1";
    const message = document.querySelector("[data-autotrade-preferences-message]");
    button.addEventListener("click", async () => {
      const section = document.querySelector("[data-autotrade-preferences-section]");
      const field = (name) => section.querySelector(`[data-pref="${name}"]`)?.value || null;
      const userTradingDays = [...section.querySelectorAll("[data-pref-trading-days] input:checked")].map((input) => Number(input.value));
      button.disabled = true;
      if (message) message.hidden = true;
      try {
        const response = await fetch("/api/auto-trade/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userRiskPercent: field("userRiskPercent"), userMinConfidence: field("userMinConfidence"),
            userMinRiskReward: field("userMinRiskReward"), userMaxConcurrentPositions: field("userMaxConcurrentPositions"),
            userMaxTradesPerDay: field("userMaxTradesPerDay"), userDailyLossLimitPercent: field("userDailyLossLimitPercent"),
            userDailyLossLimitAmount: field("userDailyLossLimitAmount"), userTradingHoursStart: field("userTradingHoursStart"),
            userTradingHoursEnd: field("userTradingHoursEnd"), userTradingDays,
          }),
        });
        const result = await response.json();
        if (message) {
          message.textContent = result.ok ? "✓ Préférences enregistrées." : (result.message || result.error || "Échec de l'enregistrement.");
          message.classList.toggle("dashboard-prepare-error", !result.ok);
          message.hidden = false;
        }
        if (result.ok) await refreshAutoTradeStatus();
      } catch {
        if (message) { message.textContent = "Impossible de contacter le serveur -- vérifie ta connexion."; message.hidden = false; }
      } finally {
        button.disabled = false;
      }
    });
  }

  async function loadAutoTradeHistory() {
    const host = document.querySelector("[data-autotrade-trades]");
    if (!host) return;
    const data = await fetchJson("/api/auto-trade/history");
    const trades = data?.trades || [];
    if (!trades.length) {
      host.innerHTML = `<div class="dashboard-empty">Le robot n'a encore ouvert aucune position.</div>`;
      return;
    }
    const HISTORY_VISIBLE = 5;
    const cards = trades.slice(0, 20).map((item) => `
      <article class="dashboard-trade-order" data-broker-order-id="${escapeHtml(item.brokerOrderId || "")}">
        <div>
          <strong>${escapeHtml(item.pair)} · ${escapeHtml(item.direction)}</strong>
          <span class="${historyStatusClass(item)}">${formatDate(item.createdAt)} · ${historyStatusIcon(item)}${escapeHtml(historyStatusLabel(item))}${item.status === "OPEN" && item.brokerOrderId ? ` · <span class="dashboard-live-pnl" data-live-pnl hidden></span>` : ""}</span>
        </div>
        <div class="dashboard-history-levels">
          <span>Entrée ${escapeHtml(item.entry)}</span>
          <span>SL ${escapeHtml(item.sl)}</span>
          <span>TP1 ${escapeHtml(item.tp1 ?? "—")}</span>
        </div>
      </article>
    `);
    const rest = cards.slice(HISTORY_VISIBLE);
    host.innerHTML = cards.slice(0, HISTORY_VISIBLE).join("")
      + (rest.length ? `<button type="button" class="dashboard-history-more" data-autotrade-history-more>Voir ${rest.length} position${rest.length > 1 ? "s" : ""} de plus</button>` : "");
    host.querySelector("[data-autotrade-history-more]")?.addEventListener("click", function () {
      this.insertAdjacentHTML("beforebegin", rest.join(""));
      this.remove();
    });
  }

  // CLOSED_MANUALLY (position closed directly at the broker -- app, dealer, EA --
  // instead of an automatic SL/TP hit, see getBrokerPositionOutcome server-side)
  // has no fixed win/loss direction the way TP1_HIT/SL_HIT do: it could be a manual
  // close in profit or at a loss, so it reads the real rMultiple sign instead of a
  // hardcoded class.
  function historyStatusClass(item) {
    const status = item.status;
    if (status === "OPEN") return "history-open";
    if (status === "TP1_HIT" || status === "TP2_HIT") return "history-win";
    if (status === "SL_HIT") return "history-loss";
    if (status === "CLOSED_MANUALLY") return Number(item.rMultiple) >= 0 ? "history-win" : "history-loss";
    if (status === "EXPIRED") return "history-expired";
    return "history-blocked";
  }

  // Checkmark for a win, cross for a loss, right before the label -- neither is
  // shown for OPEN/EXPIRED/BLOCKED, those aren't a win or a loss.
  function historyStatusIcon(item) {
    const status = item.status;
    if (status === "TP1_HIT" || status === "TP2_HIT") return "✓ ";
    if (status === "SL_HIT") return "✕ ";
    if (status === "CLOSED_MANUALLY") return Number(item.rMultiple) >= 0 ? "✓ " : "✕ ";
    return "";
  }

  // createdAt -> closedAt wasn't shown anywhere -- how long a setup actually took to
  // resolve is exactly the kind of thing worth knowing at a glance per trade.
  function historyDuration(item) {
    if (!item.closedAt) return "";
    const ms = new Date(item.closedAt).getTime() - new Date(item.createdAt).getTime();
    if (!Number.isFinite(ms) || ms < 0) return "";
    const minutes = Math.round(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
    const days = Math.floor(hours / 24);
    return `${days} j${hours % 24 ? ` ${hours % 24} h` : ""}`;
  }

  // Real broker-tracked $ leads whenever it's known (only ever set for trades the
  // bot actually placed and closed with the broker -- see server.mjs brokerProfitAmount);
  // the R-multiple is kept alongside as secondary context, not dropped, since it's
  // still the only number available for manually-logged analyses with no broker fill.
  function historyResultLabel(item) {
    const amount = Number.isFinite(item.brokerProfitAmount)
      ? `${item.brokerProfitAmount >= 0 ? "+" : ""}${item.brokerProfitAmount.toFixed(2)} $`
      : null;
    const r = Number.isFinite(item.rMultiple) ? `${item.rMultiple >= 0 ? "+" : ""}${item.rMultiple.toFixed(2)}R` : null;
    if (amount && r) return `${amount} (${r})`;
    return amount || r;
  }

  function historyStatusLabel(item) {
    const r = historyResultLabel(item);
    if (item.status === "TP1_HIT") return r ? `TP1 touché · ${r}` : "TP1 touché";
    if (item.status === "TP2_HIT") return r ? `TP2 touché · ${r}` : "TP2 touché";
    if (item.status === "SL_HIT") return r ? `Stop Loss touché · ${r}` : "Stop Loss touché";
    if (item.status === "CLOSED_MANUALLY") return r ? `Clôturé manuellement · ${r}` : "Clôturé manuellement";
    if (item.status === "EXPIRED") return r ? `Expiré · ${r}` : "Expiré";
    if (item.status === "BLOCKED") return "Bloquée";
    return "En cours";
  }

  // The backend already computes and sends blockReason/outcomeReason/closePrice for
  // every analysis (server.mjs personalAnalysesPayload) but until now the dashboard
  // only ever showed the bare status word ("Bloquée") with zero explanation of why,
  // and never showed the actual exit price for a closed trade.
  function historyDetailNote(item) {
    if (item.status === "BLOCKED" && item.blockReason) return item.blockReason;
    if (["TP1_HIT", "TP2_HIT", "SL_HIT", "CLOSED_MANUALLY", "EXPIRED"].includes(item.status)) {
      const price = Number.isFinite(item.closePrice) ? `clôturé à ${item.closePrice}` : "";
      // outcomeReason repeats the status label word-for-word for TP/SL hits ("TP1
      // touché.") -- only worth showing for EXPIRED, where it explains a status the
      // label alone doesn't ("Ni TP1 ni SL touché après 24h.").
      const reason = item.status === "EXPIRED" ? item.outcomeReason : "";
      return [reason, price].filter(Boolean).join(" · ");
    }
    return "";
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
