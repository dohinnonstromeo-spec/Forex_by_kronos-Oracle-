(() => {
  const staticSignals = [];
  const MAX_CHART_IMAGES = 2;
  let images = [];
  let activeFilter = "Tous";
  let detectedContext = null;

  document.addEventListener("DOMContentLoaded", () => {
    setupUpload();
    setupAnalyzeForm();
    setupTradingView();
    setupQuickPairControls();
    setupTimeframeControls();
    setupTabs();
    document.querySelector("#autoDetectChart")?.addEventListener("change", () => {
      detectedContext = null;
      const panel = document.querySelector("#chartDetectionPanel");
      if (panel) panel.textContent = "";
      if (isAutoDetectEnabled()) detectChartContext();
    });
    renderSignals(staticSignals);
    refreshSignals();
    setInterval(refreshSignals, 15 * 60 * 1000);
  });

  function setupUpload() {
    const drop = document.querySelector(".drop-zone");
    const input = document.querySelector("#chartUpload");
    const previews = document.querySelector(".preview-grid");
    if (!drop || !input || !previews) return;

    drop.addEventListener("click", () => input.click());
    drop.addEventListener("dragover", (event) => {
      event.preventDefault();
      drop.classList.add("dragover");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
    drop.addEventListener("drop", async (event) => {
      event.preventDefault();
      drop.classList.remove("dragover");
      await addFiles([...event.dataTransfer.files]);
      renderPreviews(previews);
      maybeDetectChartContext();
    });
    input.addEventListener("change", async () => {
      await addFiles([...input.files]);
      input.value = "";
      renderPreviews(previews);
      maybeDetectChartContext();
    });
    previews.addEventListener("click", (event) => {
      const remove = event.target.closest("[data-remove-image]");
      if (!remove) return;
      images.splice(Number(remove.dataset.removeImage), 1);
      detectedContext = null;
      renderPreviews(previews);
      maybeDetectChartContext();
    });
  }

  function setupAnalyzeForm() {
    const form = document.querySelector("#analysisForm");
    const result = document.querySelector("#analysisResult");
    if (!form || !result) return;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = form.querySelector(".analysis-submit");
      submit.disabled = true;
      const progress = startAnalysisProgress(form);
      const body = Object.fromEntries(new FormData(form).entries());
      const deep = body.analysisDepth !== "Rapide";
      submit.textContent = deep ? "Kronos analyse en profondeur..." : "Kronos analyse rapidement...";
      body.images = images;
      body.autoDetect = isAutoDetectEnabled();
      body.detectedContext = isAutoDetectEnabled() ? detectedContext : null;
      const response = await postJson("/api/analyze-chart", body);
      finishAnalysisProgress(progress, Boolean(response));
      renderAnalysisResult(result, response);
      submit.disabled = false;
      submit.textContent = "⚡ Lancer l'analyse Kronos";
    });

    result.addEventListener("click", (event) => {
      if (event.target.closest(".new-analysis")) result.classList.remove("show");
      if (event.target.closest("[data-copy-plan]")) copyTradePlan(result);
      const valueButton = event.target.closest("[data-copy-value]");
      if (valueButton) copySingleValue(valueButton);
    });
  }

  function setupTradingView() {
    const pair = document.querySelector("#pair");
    const timeframe = document.querySelector("#timeframe");
    const update = () => updateTradingViewFrame(pair?.value, timeframe?.value);
    pair?.addEventListener("change", update);
    timeframe?.addEventListener("change", update);
    update();
  }

  function setupQuickPairControls() {
    const select = document.querySelector("#pair");
    const chips = [...document.querySelectorAll("[data-pair-chips] button")];
    if (!select || !chips.length) return;
    const sync = () => {
      const current = select.value.toUpperCase();
      chips.forEach((chip) => chip.classList.toggle("active", chip.dataset.pair?.toUpperCase() === current));
    };
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        setSelectValue("pair", chip.dataset.pair);
        sync();
      });
    });
    select.addEventListener("change", sync);
    sync();
  }

  function setupTimeframeControls() {
    const select = document.querySelector("#timeframe");
    const chips = [...document.querySelectorAll("[data-timeframe-chips] button")];
    if (!select || !chips.length) return;
    const sync = () => {
      const current = select.value.toUpperCase();
      chips.forEach((chip) => chip.classList.toggle("active", chip.dataset.timeframe?.toUpperCase() === current));
    };
    chips.forEach((chip) => {
      chip.addEventListener("click", () => {
        setSelectValue("timeframe", chip.dataset.timeframe);
        sync();
      });
    });
    select.addEventListener("change", sync);
    sync();
  }

  function updateTradingViewFrame(pair, timeframe) {
    const frame = document.querySelector("#tradingViewFrame");
    if (!frame) return;
    const params = new URLSearchParams({
      symbol: tradingViewSymbol(pair || "EUR/USD"),
      interval: tradingViewInterval(timeframe || "H1"),
      theme: "dark",
      style: "1",
      timezone: "Africa/Porto-Novo",
      withdateranges: "1",
      hide_side_toolbar: "0",
      allow_symbol_change: "1",
      save_image: "0",
      studies: "[]",
    });
    frame.src = `https://s.tradingview.com/widgetembed/?${params.toString()}`;
  }

  function tradingViewSymbol(pair) {
    const clean = String(pair || "EUR/USD").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const map = {
      BTCUSD: "BINANCE:BTCUSDT",
      ETHUSD: "BINANCE:ETHUSDT",
      US500: "SP:SPX",
      NAS100: "NASDAQ:NDX",
      XAUUSD: "OANDA:XAUUSD",
      XAGUSD: "OANDA:XAGUSD",
      XPTUSD: "OANDA:XPTUSD",
      XPDUSD: "OANDA:XPDUSD",
      XAUEUR: "OANDA:XAUEUR",
      XAGEUR: "OANDA:XAGEUR",
    };
    if (map[clean]) return map[clean];
    return `FX:${clean}`;
  }

  function tradingViewInterval(timeframe) {
    return ({ M1: "1", M5: "5", M15: "15", M30: "30", H1: "60", H4: "240", D1: "D", W1: "W" })[timeframe] || "60";
  }

  function startAnalysisProgress(form) {
    let node = document.querySelector("#analysisProgress");
    if (!node) {
      form.insertAdjacentHTML("afterend", `
        <div id="analysisProgress" class="analysis-progress" aria-live="polite">
          <div class="analysis-progress-top"><span>Chargement de l'analyse</span><strong data-progress-label>1%</strong></div>
          <div class="analysis-progress-bar"><span data-progress-fill style="width:1%"></span></div>
          <p data-progress-step>Préparation du contexte chart...</p>
        </div>
      `);
      node = document.querySelector("#analysisProgress");
    }
    const label = node.querySelector("[data-progress-label]");
    const fill = node.querySelector("[data-progress-fill]");
    const step = node.querySelector("[data-progress-step]");
    const steps = [
      "Lecture des images et paramètres...",
      "Vérification paire, timeframe et prix live...",
      "Croisement news/API et contexte macro...",
      "Comparaison ICT, SMC, Wyckoff, Elliott, Price Action et Ichimoku...",
      "Calcul SL/TP et score d'efficacité...",
      "Relecture de cohérence avant affichage...",
    ];
    let value = 1;
    let stepIndex = 0;
    node.classList.add("show");
    label.textContent = "1%";
    fill.style.width = "1%";
    step.textContent = steps[0];
    const timer = setInterval(() => {
      value = Math.min(94, value + Math.max(1, Math.round((95 - value) / 9)));
      if (value > 18 && stepIndex < 1) stepIndex = 1;
      if (value > 34 && stepIndex < 2) stepIndex = 2;
      if (value > 52 && stepIndex < 3) stepIndex = 3;
      if (value > 72 && stepIndex < 4) stepIndex = 4;
      if (value > 88 && stepIndex < 5) stepIndex = 5;
      label.textContent = `${value}%`;
      fill.style.width = `${value}%`;
      step.textContent = steps[stepIndex];
    }, 420);
    return { node, timer, label, fill, step };
  }

  function finishAnalysisProgress(progress, ok) {
    if (!progress) return;
    clearInterval(progress.timer);
    progress.label.textContent = "100%";
    progress.fill.style.width = "100%";
    progress.step.textContent = ok ? "Analyse terminée." : "Délai dépassé: l'analyse profonde n'a pas répondu à temps.";
    setTimeout(() => progress.node.classList.remove("show"), 900);
  }

  async function detectChartContext() {
    detectedContext = null;
    const panel = document.querySelector("#chartDetectionPanel");
    if (!isAutoDetectEnabled() || !images.length || !panel) {
      if (panel) panel.textContent = "";
      return;
    }
    panel.innerHTML = `<span class="oracle-chat-dot"></span> Lecture paire/timeframes par IA vision...`;
    const data = await postJson("/api/detect-chart-context", { images });
    if (!data?.ok) {
      panel.innerHTML = `<span class="oracle-chat-dot closed"></span> Détection indisponible. Sélection manuelle conservée.`;
      return;
    }
    detectedContext = data;
    const pair = data.primaryPair;
    const timeframe = data.executionTimeframe || data.timeframes?.[0];
    if (pair) setSelectValue("pair", pair);
    if (timeframe) setSelectValue("timeframe", timeframe);
    panel.innerHTML = `
      <span class="oracle-chat-dot"></span>
      Détection proposée: <strong>${escapeHtml(pair || "paire inconnue")}</strong> ·
      timeframes ${escapeHtml((data.timeframes || []).join(" / ") || "inconnus")} ·
      exécution ${escapeHtml(timeframe || "à confirmer")}
      <button class="ml-2 rounded border border-amber-neon/40 px-2 py-1 text-[10px] uppercase text-amber-neon" type="button" data-confirm-detection>Confirmer</button>
    `;
    panel.querySelector("[data-confirm-detection]")?.addEventListener("click", () => {
      panel.innerHTML = `<span class="oracle-chat-dot"></span> Contexte confirmé: ${escapeHtml(pair || "manuel")} · ${escapeHtml(timeframe || "manuel")}`;
    });
  }

  function maybeDetectChartContext() {
    if (isAutoDetectEnabled()) detectChartContext();
  }

  function isAutoDetectEnabled() {
    return document.querySelector("#autoDetectChart")?.checked === true;
  }

  function setSelectValue(id, value) {
    const select = document.querySelector(`#${id}`);
    if (!select || !value) return;
    const found = [...select.options].find((option) => option.value.toUpperCase() === String(value).toUpperCase());
    if (found) {
      select.value = found.value;
      select.dispatchEvent(new Event("change"));
    }
  }

  function setupTabs() {
    document.querySelectorAll(".signal-tabs button").forEach((button) => {
      button.addEventListener("click", () => {
        document.querySelectorAll(".signal-tabs button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        activeFilter = button.dataset.filter;
        renderSignals(staticSignals);
      });
    });
    document.querySelector(".refresh-signals")?.addEventListener("click", refreshSignals);
  }

  async function refreshSignals() {
    const data = await getJson("/api/signals", 10000);
    if (!data) {
      const market = await getJson("/api/market-status", 5000);
      renderSignals(staticSignals.map((signal) => ({
        ...signal,
        suspended: true,
        open: market?.forex?.open ?? false,
        reason: "Synchronisation des données live en cours.",
      })));
      const badge = document.querySelector(".signals-age");
      if (badge) badge.textContent = market?.forex?.label ? `${market.forex.label} · signaux en synchronisation` : "Connexion marché en synchronisation";
      renderMarketNotice(market, "Connexion marché en synchronisation · vérifiez que le serveur local est lancé.");
      return;
    }
    const signals = Array.isArray(data?.signals) ? data.signals.map((signal, index) => ({
      pair: signal.paire,
      type: inferType(signal.paire),
      direction: signal.direction,
      entry: signal.entree,
      tp1: signal.tp1,
      tp2: signal.tp2,
      sl: signal.sl,
      rr: signal.rr,
      score: signal.confiance,
      age: index === 0 ? "à l'instant" : `${index * 7 + 4} min`,
      tech: signal.technique,
      direct: signal.direct,
      open: signal.open,
      source: signal.source,
      reason: signal.raison,
      suspended: signal.suspended,
      nextOpen: signal.nextOpen,
      quality: signal.quality,
    })) : staticSignals;
    renderSignals(signals);
    const badge = document.querySelector(".signals-age");
    const status = data?.market?.forex?.open ? "Forex ouvert" : "Forex fermé";
    if (badge) badge.textContent = `${status} · ${data?.market?.forex?.open ? "signaux uniquement si qualité validée" : "analyses suspendues"}`;
    renderMarketNotice(data?.market);
  }

  function renderAnalysisResult(container, data) {
    if (!data) {
      container.classList.add("show");
      container.innerHTML = `
        <div class="analysis-card">
          <div class="direction-label">⏸ ANALYSE NON REÇUE</div>
          <p class="mt-4 text-sm text-muted-foreground">Kronos n'a pas renvoyé de résultat dans le délai prévu. L'analyse profonde peut prendre plus longtemps quand elle croise graphes, prix, news et IA vision.</p>
          <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
        </div>
      `;
      return;
    }
    const result = normalizeAnalysisPayload(data);
    if (result.educationalOnly) {
      container.classList.add("show");
      container.innerHTML = `
        <div class="analysis-card">
          <div class="direction-label">⏸ IMAGE REQUISE</div>
          <p class="mt-4 text-sm text-muted-foreground">${escapeHtml(result.explanation || "")}</p>
          <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
        </div>
      `;
      return;
    }
    if (result.noSignal || result.direction === "AUCUN SIGNAL") {
      container.classList.add("show");
      container.innerHTML = renderNoSignalResult(result);
      return;
    }
    const buy = result.direction === "ACHAT";
    container.classList.add("show");
    container.innerHTML = `
      <div class="analysis-card result-console">
        <div class="result-head">
          <div>
            <p class="analysis-kicker">Conclusion Kronos</p>
            <div class="direction-label ${buy ? "buy" : "sell"}">${result.direction} ${buy ? "🟢" : "🔴"}</div>
          </div>
          <div class="result-confidence">
            <strong>${result.score}%</strong>
            <span>Score d'efficacité</span>
          </div>
        </div>
        <div class="levels-table result-level-grid">
          <div class="level-card entry"><span>Entrée</span><strong>${result.entry}</strong></div>
          <div class="level-card sl"><span>Stop Loss</span><strong>${result.sl}</strong></div>
          <div class="level-card tp"><span>Take Profit 1</span><strong>${result.tp1}</strong></div>
          <div class="level-card tp"><span>Take Profit 2</span><strong>${result.tp2}</strong></div>
          <div class="level-card rr"><span>R/R ratio</span><strong>${result.rr}</strong></div>
          <div class="level-card tech"><span>Technique</span><strong>${result.technique}</strong></div>
        </div>
        <div class="score-line">
          <div class="signal-bottom"><span>Score d'efficacité</span><strong>${result.score}%</strong></div>
          <div class="oracle-score"><span class="score-fill ${scoreColor(result.score)}" style="width:${result.score}%"></span></div>
        </div>
        ${renderDangerScore(result)}
        ${renderQualityGate(result)}
        ${renderTradePlan(result)}
        ${renderBeginnerPlan(result)}
        ${renderAnalysisMeta(result)}
        <div class="result-explanation">
          <span>Analyse détaillée</span>
          <p>${escapeHtml(result.explanation || result.answer || "")}</p>
        </div>
        <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
      </div>
    `;
  }

  function normalizeAnalysisPayload(data) {
    return {
      direction: "AUCUN SIGNAL",
      entry: "—",
      sl: "—",
      tp1: "—",
      tp2: "—",
      rr: "—",
      score: 0,
      technique: "Non validé",
      explanation: "",
      dangerScore: 0,
      ...data,
    };
  }

  function renderNoSignalResult(result) {
    const score = Math.max(0, Math.min(100, Number(result.score || 0)));
    const diagnostic = result.diagnostic || {};
    const label = result.statusLabel || diagnostic.statusLabel || "Setup non confirmé";
    const message = result.userMessage || diagnostic.userMessage || "Kronos bloque le trade pour éviter un signal forcé.";
    const actions = Array.isArray(result.nextActions) ? result.nextActions : diagnostic.nextActions || [];
    return `
      <div class="analysis-card no-signal-card">
        <div class="no-signal-hero">
          <div>
            <p class="analysis-kicker">Diagnostic Kronos</p>
            <div class="direction-label no-signal-title">⏸ ${escapeHtml(label)}</div>
          </div>
          <div class="result-confidence no-signal-confidence">
            <strong>${score}%</strong>
            <span>Validité</span>
          </div>
        </div>
        <p class="no-signal-message">${escapeHtml(message)}</p>
        <div class="score-line">
          <div class="signal-bottom"><span>Confiance exploitable</span><strong>${score}%</strong></div>
          <div class="oracle-score"><span class="score-fill ${scoreColor(score)}" style="width:${score}%"></span></div>
        </div>
        ${renderDangerScore(result)}
        ${renderQualityGate(result)}
        <div class="no-signal-grid">
          <div>
            <span>Technique lue</span>
            <strong>${escapeHtml(result.technique || "Non validé")}</strong>
          </div>
          <div>
            <span>Décision</span>
            <strong>Pas d'entrée</strong>
          </div>
          <div>
            <span>Copie SL/TP</span>
            <strong>Désactivée</strong>
          </div>
        </div>
        ${actions.length ? `
          <div class="next-actions">
            <span>Que faire maintenant ?</span>
            <ul>${actions.map((action) => `<li>${escapeHtml(action)}</li>`).join("")}</ul>
          </div>
        ` : ""}
        ${renderAnalysisMeta(result)}
        <div class="result-explanation">
          <span>Lecture de marché</span>
          <p>${escapeHtml(result.explanation || result.answer || "Aucune explication reçue du moteur Kronos.")}</p>
        </div>
        <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
      </div>
    `;
  }

  function renderSignals(signals) {
    const list = document.querySelector(".analysis-signals");
    if (!list) return;
    const visible = signals.filter((signal) => activeFilter === "Tous" || signal.type === activeFilter);
    if (!visible.length) {
      list.innerHTML = `<div class="analysis-signal-card"><div class="signal-pair">Données marché en attente</div><div class="mt-2 text-sm text-muted-foreground">Kronos attend le serveur, l'API et l'historique nécessaire avant d'afficher un signal.</div></div>`;
      return;
    }
    list.innerHTML = visible.map((signal) => {
      const buy = signal.direction === "ACHAT";
      const isDirect = signal.direct !== false;
      const suspended = signal.suspended || !isDirect;
      const suspendLabel = signal.open === false ? "⏸ MARCHÉ FERMÉ" : "⏸ NON VALIDÉ";
      return `<article class="analysis-signal-card">
        <div class="signal-top">
          <div>
            <div class="signal-pair">${escapeHtml(signal.pair)}</div>
            <div class="signal-dir ${suspended ? "" : buy ? "buy" : "sell"}">${suspended ? suspendLabel : `${buy ? "▲" : "▼"} ${signal.direction}`}</div>
          </div>
          <span class="oracle-tech">${escapeHtml(suspended ? "ANALYSE SUSPENDUE" : signal.tech)}</span>
        </div>
        ${suspended ? renderSuspended(signal) : renderActiveSignal(signal)}
        <div class="mt-2 text-[11px] text-muted-foreground">${escapeHtml(signal.reason || "")}</div>
        ${renderQuality(signal.quality)}
        <div class="mt-3 text-[10px] uppercase tracking-widest ${suspended ? "text-neon-orange" : "text-muted-foreground"}">${suspended ? suspensionFooter(signal) : "Propulsé par Kronos"}</div>
      </article>`;
    }).join("");
  }

  function renderQuality(quality) {
    if (!quality) return "";
    const ok = quality.valid;
    return `<div class="mt-2 text-[10px] uppercase tracking-widest ${ok ? "text-neon-green" : "text-neon-orange"}">
      Qualité: ${ok ? "validée" : "bloquée"} · ${quality.source || "n/a"} · fiabilité ${quality.reliability || 0}% · ${quality.bars || 0} barres
    </div>`;
  }

  function renderAnalysisMeta(result) {
    const meta = result.meta || {};
    const quality = meta.imageQuality;
    const calibration = meta.calibration;
    const chartContext = meta.chartContext;
    const technical = meta.technicalSnapshot;
    const news = meta.newsContext;
    const live = meta.livePrice;
    const id = result.learningId;
    if (!quality && !calibration && !live && !id && !chartContext && !technical && !news) return "";
    return `<div class="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
      ${quality ? `<div>Image: ${quality.score}% · ${escapeHtml(quality.reason || "")}</div>` : ""}
      ${live ? `<div>Prix live vérifié: ${escapeHtml(live)}</div>` : ""}
      ${technical ? `<div>Technique API: ${escapeHtml(technical.trend || "n/a")} · RSI ${escapeHtml(technical.rsi ?? "n/a")} · ${escapeHtml(technical.bars || 0)} bougies · ${escapeHtml(technical.source || "source n/a")}</div>` : ""}
      ${meta.analysisDepth ? `<div>Mode analyse: ${escapeHtml(meta.analysisDepth)}</div>` : ""}
      ${Array.isArray(meta.multiTimeframe) && meta.multiTimeframe.length ? `<div>Multi-timeframe: ${escapeHtml(meta.multiTimeframe.map((tf) => `${tf.timeframe}:${tf.trend || "n/a"}`).join(" · "))}</div>` : ""}
      ${news ? `<div>News/API: ${news.enabled ? (news.activeRisk ? "risque macro actif" : "contexte consulté") : "désactivé"} · ${escapeHtml(news.headlines?.[0]?.title || news.summary || "aucun titre")}</div>` : ""}
      ${meta.strategy ? `<div>Stratégie: ${escapeHtml(meta.strategy)}</div>` : ""}
      ${chartContext?.primaryPair || chartContext?.executionTimeframe ? `<div>Contexte chart: ${escapeHtml(chartContext.primaryPair || "paire manuelle")} · ${escapeHtml(chartContext.executionTimeframe || "timeframe manuel")}</div>` : ""}
      ${meta.styleComparison ? `<div>Style retenu: ${escapeHtml(meta.styleComparison.bestStyle || result.technique || "n/a")} · efficacité ${Number(meta.styleComparison.bestScore || result.score || 0)}%</div>` : ""}
      ${meta.assistedLevels ? `<div>Plan: ${escapeHtml(meta.assistedLevels)}</div>` : ""}
      ${meta.targetConstraint ? `<div>Objectifs: ${escapeHtml(meta.targetConstraint)}</div>` : ""}
      ${calibration ? `<div>Apprentissage: ${escapeHtml(calibration.message || "")}</div>` : ""}
      ${id ? `<div>ID analyse: ${escapeHtml(id)}</div>` : ""}
    </div>`;
  }

  function renderActiveSignal(signal) {
    return `<div class="signal-levels">
      <span>Entrée ${signal.entry}</span><span>SL ${signal.sl}</span>
      <span>TP1 ${signal.tp1}</span><span>TP2 ${signal.tp2}</span>
    </div>
    <div class="score-line">
      <div class="signal-bottom"><span>R/R ${signal.rr} · ${signal.age}</span><strong>${signal.score}%</strong></div>
      <div class="oracle-score"><span class="score-fill ${scoreColor(signal.score)}" style="width:${signal.score}%"></span></div>
    </div>`;
  }

  function renderSuspended(signal) {
    return `<div class="signal-levels suspended">
      <span>Entrée suspendue</span><span>SL suspendu</span>
      <span>TP1 suspendu</span><span>TP2 suspendu</span>
    </div>
    <div class="score-line">
      <div class="signal-bottom"><span>${signal.nextOpen ? `Réouverture: ${formatDate(signal.nextOpen)}` : "En attente donnée fraîche"}</span><strong>—</strong></div>
      <div class="oracle-score"><span class="score-fill red" style="width:0%"></span></div>
    </div>`;
  }

  function suspensionFooter(signal) {
    if (signal.open === false) return "Aucun signal actif · reprise à l'ouverture";
    if (signal.source !== "twelve_data") return "Aucun signal actif · donnée API non fiable";
    return "Aucun signal actif · setup non confirmé";
  }

  function renderMarketNotice(market, fallbackText = "Connexion marché en synchronisation · vérifiez que le serveur local est lancé.") {
    let notice = document.querySelector(".market-notice");
    const host = document.querySelector(".signal-tabs");
    if (!host) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.className = "market-notice";
      host.before(notice);
    }
    if (!market?.forex) {
      notice.innerHTML = `<span class="oracle-chat-dot closed"></span> ${escapeHtml(fallbackText)}`;
      return;
    }
    notice.innerHTML = market.forex.open
      ? `<span class="oracle-chat-dot"></span> ${market.forex.label} · les analyses auto peuvent être live si Twelve Data fournit une cotation fraîche.`
      : `<span class="oracle-chat-dot closed"></span> ${market.forex.label} · analyses auto Forex suspendues jusqu'à la réouverture.`;
  }

  function renderPreviews(container) {
    container.innerHTML = images.map((src, index) => `
      <div class="preview-item">
        <img src="${src}" alt="Graphique uploadé ${index + 1}">
        <button type="button" class="preview-remove" data-remove-image="${index}" aria-label="Supprimer le graphique ${index + 1}">×</button>
      </div>
    `).join("");
  }

  async function addFiles(items) {
    const remaining = Math.max(0, MAX_CHART_IMAGES - images.length);
    if (!remaining) return;
    const additions = await filesToDataUrls(items, remaining);
    images = [...images, ...additions].slice(0, MAX_CHART_IMAGES);
  }

  async function filesToDataUrls(items, limit = MAX_CHART_IMAGES) {
    const valid = items.filter((file) => /image\/(png|jpe?g|webp)/i.test(file.type)).slice(0, limit);
    return Promise.all(valid.map((file) => new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    })));
  }

  function renderTradePlan(result) {
    const plan = [
      `STOP LOSS: ${result.sl}`,
      `TAKE PROFIT 1: ${result.tp1}`,
      `TAKE PROFIT 2: ${result.tp2}`,
    ].filter((line) => !/:\s*$/.test(line)).join("\n");
    return `
      <div class="trade-plan">
        <div class="signal-bottom"><span>SL / TP prêts à copier</span><button type="button" data-copy-plan>Copier SL/TP</button></div>
        <div class="copy-level-grid">
          ${renderCopyValue("SL", result.sl)}
          ${renderCopyValue("TP1", result.tp1)}
          ${renderCopyValue("TP2", result.tp2)}
        </div>
        <pre class="trade-plan-copy">${escapeHtml(plan)}</pre>
      </div>
    `;
  }

  function renderDangerScore(result) {
    const score = Math.max(0, Math.min(100, Number(result.dangerScore ?? result.meta?.dangerScore ?? 0)));
    const danger = result.meta?.danger || {};
    const label = danger.label || (score >= 70 ? "Élevé" : score >= 40 ? "Moyen" : "Faible");
    const reasons = Array.isArray(danger.reasons) ? danger.reasons.slice(0, 3).join(" · ") : "risque standard";
    return `
      <div class="danger-panel ${score >= 70 ? "high" : score >= 40 ? "medium" : "low"}">
        <div class="signal-bottom"><span>Score danger</span><strong>${score}% · ${escapeHtml(label)}</strong></div>
        <div class="oracle-score"><span class="score-fill ${score >= 70 ? "red" : score >= 40 ? "orange" : "green"}" style="width:${score}%"></span></div>
        <p>${escapeHtml(reasons)}</p>
      </div>
    `;
  }

  function renderQualityGate(result) {
    const gate = result.qualityGate || result.meta?.qualityGate;
    if (!gate || !Array.isArray(gate.checks)) return "";
    return `
      <div class="quality-gate ${gate.valid ? "valid" : "blocked"}">
        <div class="signal-bottom"><span>Contrôle qualité</span><strong>${gate.valid ? "Validé" : "Bloqué"}</strong></div>
        <div class="quality-checks">
          ${gate.checks.map((check) => `
            <span class="${check.ok ? "ok" : "bad"}">${check.ok ? "✓" : "!"} ${escapeHtml(check.name)}</span>
          `).join("")}
        </div>
        <p>${escapeHtml(gate.reason || "")}</p>
      </div>
    `;
  }

  function renderBeginnerPlan(result) {
    const plan = result.beginnerPlan;
    if (!plan || !Array.isArray(plan.steps)) return "";
    return `
      <div class="beginner-plan">
        <div class="signal-bottom"><span>${escapeHtml(plan.title || "Plan débutant")}</span><button type="button" data-copy-value="${escapeHtml(plan.copy || "")}">Copier plan</button></div>
        <ol>${plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
      </div>
    `;
  }

  function renderCopyValue(label, value) {
    if (!value || value === "—") return "";
    return `<button type="button" data-copy-value="${escapeHtml(value)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></button>`;
  }

  async function copyTradePlan(container) {
    const plan = container.querySelector(".trade-plan-copy")?.textContent || "";
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan);
      const button = container.querySelector("[data-copy-plan]");
      if (button) {
        button.textContent = "Copié";
        setTimeout(() => { button.textContent = "Copier SL/TP"; }, 1400);
      }
    } catch {
      window.prompt("Copiez le plan", plan);
    }
  }

  async function copySingleValue(button) {
    const value = button.dataset.copyValue || "";
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      const previous = button.querySelector("strong")?.textContent || value;
      button.querySelector("strong").textContent = "Copié";
      setTimeout(() => { button.querySelector("strong").textContent = previous; }, 1200);
    } catch {
      window.prompt("Copiez ce niveau", value);
    }
  }

  function scoreColor(score) {
    return Number(score) >= 75 ? "green" : Number(score) >= 50 ? "orange" : "red";
  }

  function inferType(pair) {
    if (/BTC|ETH/i.test(pair)) return "Crypto";
    if (/XAU|XAG|OIL|WTI/i.test(pair)) return "Commodités";
    if (/US500|NAS|DAX|SPX/i.test(pair)) return "Indices";
    return "Forex";
  }

  function formatDate(value) {
    try {
      return new Intl.DateTimeFormat("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "2-digit",
        timeZoneName: "short",
      }).format(new Date(value));
    } catch {
      return "prochaine session";
    }
  }

  async function getJson(url, timeoutMs = 9000) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  }

  async function postJson(url, body) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(65000),
      });
      return response.ok ? response.json() : null;
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        return {
          direction: "AUCUN SIGNAL",
          score: 0,
          technique: "Analyse profonde",
          explanation: "L'analyse profonde a dépassé le délai côté navigateur. Les APIs ou le modèle IA répondent trop lentement; relancez ou réduisez le nombre d'images/news.",
          noSignal: true,
          statusLabel: "Analyse trop longue",
          userMessage: "Kronos prend trop de temps à croiser toutes les sources. Ce n'est pas forcément une panne, mais le résultat n'est pas arrivé dans le délai.",
          nextActions: ["Réessayer avec 1 seul graphe net.", "Désactiver temporairement le contexte news/API si besoin.", "Relancer l'analyse après quelques secondes."],
        };
      }
      return null;
    }
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
