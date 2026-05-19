(() => {
  const messages = [];
  let files = [];

  document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll('a[href="/analyse"], a[href="/analyse/"]').forEach((link) => {
      link.setAttribute("href", "/tester-gratuitement");
    });
    document.querySelectorAll('a[href="/analyse.html"]').forEach((link) => {
      if (/Analyse IA|Tester gratuitement/i.test(link.textContent || "")) link.setAttribute("href", "/tester-gratuitement");
    });
    mountChatbot();
    updateStatus();
  });

  function mountChatbot() {
    if (document.querySelector(".oracle-chat-toggle")) return;
    document.body.insertAdjacentHTML("beforeend", `
      <div class="oracle-chat-online" aria-hidden="true"></div>
      <button class="oracle-chat-toggle" type="button" aria-label="Ouvrir ChatBot"><span class="oracle-chat-ai">CB</span></button>
      <section class="oracle-chat-panel" aria-label="ChatBot Oracle Forex">
        <header class="oracle-chat-head">
          <div class="oracle-chat-head-row">
            <div>
              <div class="oracle-chat-title">ChatBot Kronos</div>
              <div class="oracle-chat-subtitle">Groq texte · Gemini vision · Auto-technique · 2 graphiques max</div>
              <div class="oracle-chat-status"><span class="oracle-chat-dot"></span><span data-chat-status>En ligne</span></div>
            </div>
            <button class="oracle-chat-close" type="button" aria-label="Fermer">✕</button>
          </div>
        </header>
        <div class="oracle-chat-messages"></div>
        <div class="oracle-chat-previews"></div>
        <form class="oracle-chat-form">
          <input class="oracle-chat-file" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden>
          <button class="oracle-upload-btn" type="button" title="Joindre des graphiques">📎</button>
          <input class="oracle-chat-input" type="text" placeholder="Pose ta question Forex..." autocomplete="off">
          <button class="oracle-send-btn" type="submit">Envoyer</button>
        </form>
      </section>
    `);

    const panel = document.querySelector(".oracle-chat-panel");
    const toggle = document.querySelector(".oracle-chat-toggle");
    const close = document.querySelector(".oracle-chat-close");
    const form = document.querySelector(".oracle-chat-form");
    const input = document.querySelector(".oracle-chat-input");
    const fileInput = document.querySelector(".oracle-chat-file");
    const upload = document.querySelector(".oracle-upload-btn");

    toggle.addEventListener("click", () => panel.classList.toggle("open"));
    close.addEventListener("click", () => panel.classList.remove("open"));
    upload.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      files = await filesToDataUrls([...fileInput.files].slice(0, 2));
      renderPreviews();
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const text = input.value.trim();
      if (!text && !files.length) return;
      input.value = "";
      addMessage("user", text || "Analyse ces graphiques.");
      const pending = addMessage("assistant", "Analyse en cours...");
      const response = await postJson("/api/chat", {
        message: text,
        images: files,
        messages: messages.slice(-8),
      });
      pending.remove();
      if (!response?.ok && response?.offline) {
        setChatOnline(false);
        addMessage("assistant", response.answer || "ChatBot hors service pour l'instant. Réessaie dans quelques minutes.", { score: 0, technique: "Hors service" });
      } else if (!response?.answer) {
        setChatOnline(false);
        addMessage("assistant", "ChatBot hors service pour l'instant. Le moteur IA n'a pas répondu.", { score: 0, technique: "Hors service" });
      } else {
        setChatOnline(true);
        addMessage("assistant", response.answer, response);
      }
      files = [];
      fileInput.value = "";
      renderPreviews();
    });

    addMessage("assistant", "Bienvenue. Envoie une question Forex ou jusqu'à 2 graphiques. Les réponses sont des analyses IA éducatives, pas des conseils financiers.", {
      score: 88,
      technique: "Auto-technique",
    });
  }

  async function updateStatus() {
    const health = await getJson("/api/health");
    const groqOk = health?.providers?.groq?.status === "ok";
    const geminiOk = health?.providers?.gemini_vision?.status === "ok" || health?.providers?.gemini_text?.status === "ok";
    const knownDown = health?.providers?.groq?.status === "down" && health?.providers?.gemini_text?.status === "down" && health?.providers?.gemini_vision?.status === "down";
    const config = await getJson("/api/config");
    setChatOnline(Boolean(!knownDown && (groqOk || geminiOk || config?.groq || config?.gemini)));
  }

  function setChatOnline(ready) {
    const online = document.querySelector(".oracle-chat-online");
    const toggle = document.querySelector(".oracle-chat-toggle");
    const status = document.querySelector("[data-chat-status]");
    const dot = document.querySelector(".oracle-chat-status .oracle-chat-dot");
    online?.classList.toggle("offline", !ready);
    toggle?.classList.toggle("offline", !ready);
    dot?.classList.toggle("closed", !ready);
    if (status) status.textContent = ready ? "En ligne" : "Hors service";
    const list = document.querySelector(".oracle-chat-messages");
    if (!ready && list && !list.querySelector("[data-offline-notice]")) {
      const node = addMessage("assistant", "ChatBot hors service pour l'instant. Les réponses IA reprendront dès que le moteur sera disponible.", { score: 0, technique: "Hors service" });
      node.dataset.offlineNotice = "true";
    }
  }

  function addMessage(role, text, meta) {
    messages.push({ role, content: text });
    const list = document.querySelector(".oracle-chat-messages");
    const node = document.createElement("div");
    node.className = `oracle-msg ${role}`;
    node.innerHTML = `
      <div class="oracle-bubble">
        ${escapeHtml(text)}
        ${role === "assistant" && meta ? renderMeta(meta) : ""}
      </div>
    `;
    list.appendChild(node);
    list.scrollTop = list.scrollHeight;
    return node;
  }

  function renderMeta(meta) {
    const score = Number(meta.score || 0);
    const color = score >= 75 ? "green" : score >= 50 ? "orange" : "red";
    return `<div class="oracle-meta">
      <span class="oracle-tech">${escapeHtml(meta.technique || "Price Action")}</span>
      <div class="oracle-score"><span class="score-fill ${color}" style="width:${Math.max(0, Math.min(100, score))}%"></span></div>
      <small>Score confiance: ${score || "—"}/100</small>
    </div>`;
  }

  function renderPreviews() {
    const previews = document.querySelector(".oracle-chat-previews");
    previews.classList.toggle("has-files", files.length > 0);
    previews.innerHTML = files.map((src) => `<img src="${src}" alt="Graphique joint">`).join("");
  }

  async function filesToDataUrls(items) {
    const valid = items.filter((file) => /image\/(png|jpe?g|webp)/i.test(file.type)).slice(0, 2);
    return Promise.all(valid.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    })));
  }

  async function postJson(url, body) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  async function getJson(url) {
    try {
      const response = await fetch(url);
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
