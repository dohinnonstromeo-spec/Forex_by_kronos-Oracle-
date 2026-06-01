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
      return response.json();
    } catch {
      return null;
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
          <span>${escapeHtml(user.role || "user")} · ${escapeHtml(user.plan || "free")}</span>
        </div>
        <div class="dashboard-history-levels">
          <button type="button">${user.premiumUntil ? `Premium jusqu'au ${formatDate(user.premiumUntil)}` : "Free"}</button>
          <button type="button">${user.manualPremium ? "Manuel" : "Standard"}</button>
        </div>
        <span class="${user.plan === "premium" ? "history-open" : "history-blocked"}">${escapeHtml(user.plan || "free")}</span>
      </article>
    `).join("");
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
