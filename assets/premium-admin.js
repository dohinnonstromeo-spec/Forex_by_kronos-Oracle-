(() => {
  const form = document.querySelector("[data-premium-admin-form]");
  const message = document.querySelector("[data-premium-admin-message]");
  const members = document.querySelector("[data-premium-members]");
  const loadButton = document.querySelector("[data-load-members]");

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
