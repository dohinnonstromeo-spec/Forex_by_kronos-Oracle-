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
    if (!loginLinks.length && !dashboardLinks.length && !trialLinks.length && !paymentStatus.length && !paymentForms.length) return;

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

    const isPremium = String(me.user.plan || "").toLowerCase() === "premium";
    const personal = await fetchJson("/api/my-analyses");
    renderPersonalHistory(personal, isPremium);
    initPush(isPremium);
    loadTradeOrders(isPremium);
  }

  function urlBase64ToUint8Array(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const base64Safe = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64Safe);
    return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
  }

  const PUSH_TOPIC_LABELS = {
    tp_sl: { on: "Désactiver les notifications TP/SL", off: "Activer les notifications TP/SL", active: "Notifications TP/SL actives sur cet appareil." },
    new_signal: { on: "Désactiver les alertes nouveaux signaux", off: "Activer les alertes nouveaux signaux", active: "Alertes nouveaux signaux actives sur cet appareil." },
  };

  // One browser only ever exposes one PushManager subscription per device, but it
  // carries several independently-toggled topics server-side (see
  // /api/push/subscribe's topic param) -- "new_signal" (alerts the moment Kronos
  // detects a fresh high-confidence setup, not tied to a personal analysis) is
  // premium-only, "tp_sl" (a saved analysis of yours hit TP/SL) is open to everyone.
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
        <span class="${historyStatusClass(item.status)}">${escapeHtml(historyStatusLabel(item))}</span>
        ${historyDetailNote(item) ? `<p class="dashboard-history-note">${escapeHtml(historyDetailNote(item))}</p>` : ""}
        ${item.status === "OPEN" && isPremium ? `<button type="button" class="dashboard-trade-prepare" data-prepare-order="${escapeHtml(item.id)}">Préparer un ordre</button>` : ""}
      </article>
    `).join("");
    host.querySelectorAll("[data-copy-level]").forEach((button) => {
      button.addEventListener("click", async () => {
        await navigator.clipboard?.writeText(button.dataset.copyLevel || "");
        const original = button.textContent;
        button.textContent = "Copié";
        setTimeout(() => { button.textContent = original; }, 1400);
      });
    });
    host.querySelectorAll("[data-prepare-order]").forEach((button) => {
      button.addEventListener("click", async () => {
        button.disabled = true;
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
          }
        } catch {
          button.disabled = false;
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
    if (statusEl) statusEl.textContent = brokerConfigured ? "Broker connecté" : "Broker non connecté (démo requise)";
    const host = document.querySelector("[data-trade-orders]");
    if (!host) return;
    if (!orders.length) {
      host.innerHTML = `<div class="dashboard-empty">Aucun ordre préparé. Depuis une analyse ouverte ci-dessus, clique sur "Préparer un ordre".</div>`;
      return;
    }
    host.innerHTML = orders.map((order) => `
      <article class="dashboard-trade-order" data-order-id="${escapeHtml(order.id)}">
        <div>
          <strong>${escapeHtml(order.pair)} · ${escapeHtml(order.direction)}</strong>
          <span>${formatDate(order.createdAt)} · ${escapeHtml(TRADE_ORDER_LABELS[order.status] || order.status)}</span>
        </div>
        <div class="dashboard-history-levels">
          <span>Entrée ${escapeHtml(order.entry)}</span>
          <span>SL ${escapeHtml(order.sl)}</span>
          <span>TP1 ${escapeHtml(order.tp1 ?? "—")}</span>
        </div>
        ${order.status === "PENDING_CONFIRMATION" ? `
          <div class="dashboard-trade-confirm">
            <input type="number" step="0.01" min="0.01" placeholder="Taille (lots)" data-order-volume>
            <button type="button" class="payment-method-button" data-order-confirm>Confirmer et envoyer</button>
            <button type="button" class="dashboard-trade-cancel" data-order-cancel>Annuler</button>
          </div>
        ` : ""}
        ${order.status === "FAILED" && order.errorMessage ? `<p class="dashboard-history-note">${escapeHtml(order.errorMessage)}</p>` : ""}
      </article>
    `).join("");

    host.querySelectorAll("[data-order-confirm]").forEach((button) => {
      button.addEventListener("click", async () => {
        const article = button.closest("[data-order-id]");
        const orderId = article.dataset.orderId;
        const volumeInput = article.querySelector("[data-order-volume]");
        const volume = Number(volumeInput.value);
        if (!Number.isFinite(volume) || volume <= 0) {
          volumeInput.focus();
          return;
        }
        button.disabled = true;
        try {
          await fetch("/api/trade/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ orderId, volume }),
          });
        } finally {
          await loadTradeOrders(true);
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

  function historyStatusClass(status) {
    if (status === "OPEN") return "history-open";
    if (status === "TP1_HIT" || status === "TP2_HIT") return "history-win";
    if (status === "SL_HIT") return "history-loss";
    if (status === "EXPIRED") return "history-expired";
    return "history-blocked";
  }

  function historyStatusLabel(item) {
    const r = Number.isFinite(item.rMultiple) ? `${item.rMultiple >= 0 ? "+" : ""}${item.rMultiple.toFixed(2)}R` : null;
    if (item.status === "TP1_HIT") return r ? `TP1 touché · ${r}` : "TP1 touché";
    if (item.status === "TP2_HIT") return r ? `TP2 touché · ${r}` : "TP2 touché";
    if (item.status === "SL_HIT") return r ? `Stop Loss touché · ${r}` : "Stop Loss touché";
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
    if (["TP1_HIT", "TP2_HIT", "SL_HIT", "EXPIRED"].includes(item.status)) {
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
