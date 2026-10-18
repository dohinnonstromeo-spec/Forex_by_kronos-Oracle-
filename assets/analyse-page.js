(() => {
  const staticSignals = [];
  const MAX_CHART_IMAGES = 2;
  let images = [];
  let activeFilter = "Tous";
  let detectedContext = null;
  let pendingDetectedContext = null;
  let chartDetectionVersion = 0;

  document.addEventListener("DOMContentLoaded", () => {
    setupUpload();
    setupAnalyzeForm();
    setupAnalysisDepthHints();
    setupAnalysisStyleHints();
    setupAnalysisModeHints();
    setupTradingView();
    setupQuickPairControls();
    setupTimeframeControls();
    setupTabs();
    document.querySelector("#autoDetectChart")?.addEventListener("change", () => {
      chartDetectionVersion += 1;
      detectedContext = null;
      pendingDetectedContext = null;
      const panel = document.querySelector("#chartDetectionPanel");
      if (panel) panel.textContent = "";
      if (isAutoDetectEnabled()) detectChartContext();
    });
    renderSignals(staticSignals);
    setupSignalsStream();
  });

  // Live signals used to mean "poll every 15 minutes", which doesn't match a
  // page badged "Live". Server-Sent Events push a fresh payload as soon as
  // the shared cache refreshes (see /api/signals/stream + signalCacheTtlMs
  // in server.mjs) instead of every open tab guessing on its own timer.
  function setupSignalsStream() {
    refreshSignals(); // fastest possible first paint, before the stream connects
    if (typeof EventSource === "undefined") {
      setInterval(refreshSignals, 60 * 1000);
      return;
    }
    const source = new EventSource("/api/signals/stream");
    source.onmessage = (event) => {
      try {
        applySignalsPayload(JSON.parse(event.data));
      } catch {
        // malformed frame: ignore, the next push (or EventSource's built-in
        // auto-reconnect on a dropped connection) will self-correct
      }
    };
    // No explicit onerror handling needed: EventSource retries the
    // connection on its own with backoff. A slow safety-net poll covers the
    // gap between "connection dropped" and "browser reconnected".
    setInterval(() => { if (source.readyState !== EventSource.OPEN) refreshSignals(); }, 90 * 1000);
  }

  function setupUpload() {
    const drop = document.querySelector(".drop-zone");
    const input = document.querySelector("#chartUpload");
    const previews = document.querySelector(".preview-grid");
    if (!drop || !input || !previews) return;

    drop.addEventListener("click", () => input.click());
    // The drop zone is a <div role="button">, not a real <button>: browsers give
    // real buttons/links Enter+Space activation for free, but a div needs it wired
    // by hand or a keyboard-only user (or screen reader) can never reach the file
    // picker on this page at all -- the whole point of "Analyse IA" is uploading a
    // chart, so this wasn't a cosmetic gap.
    drop.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        input.click();
      }
    });
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
      chartDetectionVersion += 1;
      detectedContext = null;
      pendingDetectedContext = null;
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
      // Captured here, not hardcoded below -- this button's idle label can be
      // overridden by the site-content admin CMS (data-cms="analyse.submit_button"),
      // applied asynchronously by site-content.js shortly after page load. Reading
      // the button's *current* text right before we overwrite it (rather than a
      // literal string) means the reset after the analysis finishes restores
      // whatever was actually showing -- default or admin-overridden -- instead of
      // silently reverting a CMS edit back to the hardcoded original the first time
      // anyone submits the form.
      const idleLabel = submit.textContent.trim() || "Lancer l'analyse Kronos";
      submit.disabled = true;
      const progress = startAnalysisProgress(form);
      let analysisReceived = false;
      try {
        const body = Object.fromEntries(new FormData(form).entries());
        const deep = body.analysisDepth !== "Rapide";
        setSubmitLabel(submit, deep ? "Kronos analyse en profondeur..." : "Kronos analyse rapidement...");
        body.images = images;
        body.autoDetect = isAutoDetectEnabled() && Boolean(detectedContext);
        body.detectedContext = body.autoDetect ? detectedContext : null;
        if (isAutoDetectEnabled() && images.length && !detectedContext) {
          const panel = document.querySelector("#chartDetectionPanel");
          if (panel) panel.innerHTML = `<span class="oracle-chat-dot closed"></span> Détection non confirmée : la paire et l'unité de temps du formulaire seront utilisées.`;
        }
        const response = await postJson("/api/analyze-chart", body, deep ? 120000 : 45000);
        renderAnalysisResult(result, response);
        analysisReceived = Boolean(response);
      } catch (error) {
        result.classList.add("show");
        result.innerHTML = `
          <div class="analysis-card">
            <div class="direction-label">Analyse interrompue</div>
            <p class="mt-4 text-sm text-muted-foreground">${escapeHtml(error?.message || "Une erreur inattendue a interrompu l'affichage de l'analyse.")}</p>
            <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
          </div>
        `;
      } finally {
        finishAnalysisProgress(progress, analysisReceived);
        submit.disabled = false;
        setSubmitLabel(submit, idleLabel, "zap");
      }
    });

    result.addEventListener("click", (event) => {
      if (event.target.closest(".new-analysis")) result.classList.remove("show");
      if (event.target.closest("[data-copy-plan]")) copyTradePlan(result);
      const valueButton = event.target.closest("[data-copy-value]");
      if (valueButton) copySingleValue(valueButton);
    });
  }

  // .textContent on this button used to permanently destroy its <span data-icon>
  // child (populated once by oracle-icons.js on page load) -- confirmed live: after
  // the first analysis, the submit button lost its custom zap SVG for the rest of
  // the session, replaced by nothing (progress states) or a raw emoji fallback
  // (idle state). Rebuilds the icon from window.OracleIcons instead of relying on
  // a DOM node that's already gone.
  function setSubmitLabel(button, text, iconName = null) {
    const iconSvg = iconName ? window.OracleIcons?.[iconName] : null;
    button.innerHTML = iconSvg ? `<span data-icon="${iconName}">${iconSvg}</span>${escapeHtml(text)}` : escapeHtml(text);
  }

  function setupTradingView() {
    const pair = document.querySelector("#pair");
    const timeframe = document.querySelector("#timeframe");
    const update = () => updateTradingViewFrame(pair?.value, timeframe?.value);
    pair?.addEventListener("change", update);
    timeframe?.addEventListener("change", update);
    update();
  }

  function setupAnalysisDepthHints() {
    const depth = document.querySelector("#analysisDepth");
    const news = document.querySelector("#includeNewsContext");
    const hint = document.querySelector("#newsDepthHint");
    if (!hint) return;
    const update = () => {
      if (depth?.value === "Rapide") {
        hint.textContent = "Mode rapide : l'analyse SMC/Price Action utilise les bougies disponibles; news et calendrier ne sont croises qu'en mode Profonde.";
      } else if (news?.checked) {
        hint.textContent = "Mode Profonde : Kronos ajoute le calendrier et les actualites au contexte de marche.";
      } else {
        hint.textContent = "Mode Profonde actif; le croisement news/calendrier est desactive.";
      }
    };
    depth?.addEventListener("change", update);
    news?.addEventListener("change", update);
    update();
  }

  function setupAnalysisStyleHints() {
    const style = document.querySelector("#style");
    const hint = document.querySelector("#styleModeHint");
    if (!style || !hint) return;
    const update = () => {
      hint.textContent = style.value === "SMC"
        ? "SMC experimental : sweep, biais MTF, cassure, FVG/OB puis retest sur bougies cloturees. Diagnostic uniquement, aucun signal copiable."
        : "Price Action reste le choix par defaut. SMC est un diagnostic experimental calcule sur les bougies OHLC cloturees.";
    };
    style.addEventListener("change", update);
    update();
  }

  function setupAnalysisModeHints() {
    const mode = document.querySelector("#analysisMode");
    const hint = document.querySelector("#analysisModeHint");
    if (!mode || !hint) return;
    const update = () => {
      hint.textContent = mode.value === "pa_research"
        ? "Recherche séparée : exige des bougies Deriv clôturées et alignées. Ses paramètres de sortie sont fixes; les candidats ne sont jamais copiables."
        : "Mode prudent : lecture du marche et scenarios conditionnels, avec un panneau de candidats experimental separe. Aucun candidat ne devient un ordre copiable.";
    };
    mode.addEventListener("change", update);
    update();
  }

  function setupQuickPairControls() {
    const select = document.querySelector("#pair");
    const chips = [...document.querySelectorAll("[data-pair-chips] button")];
    if (!select || !chips.length) return;
    const sync = () => {
      const current = select.value.toUpperCase();
      chips.forEach((chip) => {
        const isActive = chip.dataset.pair?.toUpperCase() === current;
        chip.classList.toggle("active", isActive);
        chip.setAttribute("aria-pressed", String(isActive));
      });
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
      chips.forEach((chip) => {
        const isActive = chip.dataset.timeframe?.toUpperCase() === current;
        chip.classList.toggle("active", isActive);
        chip.setAttribute("aria-pressed", String(isActive));
      });
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
      allow_symbol_change: "0",
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
    const deep = form.querySelector("#analysisDepth")?.value !== "Rapide";
    const steps = [
      "Lecture des images et paramètres...",
      "Vérification paire, timeframe et prix live...",
      deep ? "Croisement news, calendrier et données de marché..." : "Contrôle du flux prix/bougies...",
      "Application du style choisi, vérification des niveaux et du risque...",
      "Vérification des niveaux et calcul de l'indice interne...",
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
    const requestVersion = ++chartDetectionVersion;
    detectedContext = null;
    pendingDetectedContext = null;
    const panel = document.querySelector("#chartDetectionPanel");
    if (!isAutoDetectEnabled() || !images.length || !panel) {
      if (panel) panel.textContent = "";
      return;
    }
    panel.innerHTML = `<span class="oracle-chat-dot"></span> Lecture paire/timeframes par IA vision...`;
    const data = await postJson("/api/detect-chart-context", { images });
    if (requestVersion !== chartDetectionVersion) return;
    if (!data?.ok) {
      panel.innerHTML = `<span class="oracle-chat-dot closed"></span> Détection indisponible. Sélection manuelle conservée.`;
      return;
    }
    pendingDetectedContext = data;
    const pair = data.primaryPair;
    const timeframe = data.executionTimeframe || data.timeframes?.[0];
    panel.innerHTML = `
      <span class="oracle-chat-dot"></span>
      Contexte détecté — vérifie avant utilisation : <strong>${escapeHtml(pair || "paire inconnue")}</strong> ·
      timeframes ${escapeHtml((data.timeframes || []).join(" / ") || "inconnus")} ·
      exécution ${escapeHtml(timeframe || "à confirmer")}
      <button class="ml-2 rounded border border-amber-neon/40 px-2 py-1 text-[10px] uppercase text-amber-neon" type="button" data-confirm-detection>Utiliser ce contexte</button>
    `;
    panel.querySelector("[data-confirm-detection]")?.addEventListener("click", () => {
      detectedContext = pendingDetectedContext;
      if (pair) setSelectValue("pair", pair);
      if (timeframe) setSelectValue("timeframe", timeframe);
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
        document.querySelectorAll(".signal-tabs button").forEach((item) => {
          item.classList.remove("active");
          item.setAttribute("aria-pressed", "false");
        });
        button.classList.add("active");
        button.setAttribute("aria-pressed", "true");
        activeFilter = button.dataset.filter;
        renderSignals(staticSignals);
      });
    });
    document.querySelector(".refresh-signals")?.addEventListener("click", refreshSignals);
  }

  let signalsRefreshInFlight = false;
  async function refreshSignals() {
    if (signalsRefreshInFlight) return;
    signalsRefreshInFlight = true;
    try {
      const data = await getJson("/api/signals", 18000);
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
    applySignalsPayload(data);
    } finally {
      signalsRefreshInFlight = false;
    }
  }

  // Shared by the initial fetch, the manual refresh button and every SSE
  // push, so all three render through the exact same path.
  function applySignalsPayload(data) {
    const signals = Array.isArray(data?.signals) ? data.signals.map((signal) => ({
      pair: signal.paire,
      type: inferType(signal.paire),
      direction: signal.direction,
      entry: signal.entree,
      tp1: signal.tp1,
      tp2: signal.tp2,
      sl: signal.sl,
      rr: signal.rr,
      score: signal.confiance,
      age: relativeAge(data.generatedAt),
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

  // Was a fabricated "index * 7 + 4 min" before -- looked live, meant
  // nothing. This reflects how old the payload actually is.
  function relativeAge(generatedAt) {
    const seconds = generatedAt ? Math.max(0, Math.round((Date.now() - new Date(generatedAt).getTime()) / 1000)) : null;
    if (seconds === null) return "à l'instant";
    if (seconds < 45) return "à l'instant";
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${Math.round(seconds / 3600)} h`;
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
            <div class="direction-label ${buy ? "buy" : "sell"}">${result.direction} ${icon(buy ? "arrowUp" : "arrowDown")}</div>
          </div>
          <div class="result-confidence">
            <strong>${result.score}/100</strong>
            <span>Indice de qualité interne</span>
          </div>
        </div>
        ${renderTargetProfileSummary(result)}
        <div class="levels-table result-level-grid">
          ${renderCopyValue("Zone d'entrée indicative", getEntryZone(result)?.range || result.entry, "entry", getEntryZoneNote(result))}
          ${renderCopyValue("Stop Loss", result.sl, "sl")}
          ${renderCopyValue("Take Profit 1", result.tp1, "tp")}
          ${renderCopyValue("Take Profit 2", result.tp2, "tp")}
          ${renderCopyValue(result.meta?.targetProfile === "mdt_extended" ? "R/R TP1 · TP2" : "R/R ratio",
            result.meta?.targetProfile === "mdt_extended" && Number.isFinite(Number(result.meta?.tp2R))
              ? `${result.rr} / 1:${Number(result.meta.tp2R).toFixed(2)}` : result.rr, "rr")}
          <div class="level-card tech"><span>Technique</span><strong>${escapeHtml(result.technique)}</strong></div>
        </div>
        ${renderPriceActionMarketOutlook(result)}
        ${renderPriceActionResearch(result)}
        ${renderPriceFreshness(result)}
        ${renderSmcAnalysis(result)}
        ${renderMarketChart(result)}
        <div class="score-line">
          <div class="signal-bottom"><span>Qualité interne · pas un taux de réussite</span><strong>${result.score}/100</strong></div>
          <div class="oracle-score"><span class="score-fill ${scoreColor(result.score)}" style="width:${result.score}%"></span></div>
        </div>
        ${renderDangerScore(result)}
        ${renderQualityGate(result)}
        ${renderVisualReading(result)}
        ${renderConfluence(result)}
        ${renderRiskNote(result)}
        ${renderDeterministicCrossCheck(result)}
        ${renderRiskPanel(result)}
        ${renderTradePlan(result)}
        ${renderBeginnerPlan(result)}
        ${renderAdvancedDisclosure(result)}
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
    const smc = result.meta?.smcAnalysis || null;
    const label = result.statusLabel || diagnostic.statusLabel || "Setup non confirmé";
    const message = result.userMessage || diagnostic.userMessage || "Kronos bloque le trade pour éviter un signal forcé.";
    const actions = Array.isArray(result.nextActions) ? result.nextActions : diagnostic.nextActions || [];
    return `
        <div class="analysis-card no-signal-card${smc ? " smc-no-signal-card" : ""}">
        <div class="no-signal-hero">
          <div>
            <p class="analysis-kicker">Diagnostic Kronos</p>
            <div class="direction-label no-signal-title">⏸ ${escapeHtml(label)}</div>
          </div>
          <div class="result-confidence no-signal-confidence">
            <strong>${score}/100</strong>
            <span>Qualité du filtre</span>
          </div>
        </div>
        <p class="no-signal-message">${escapeHtml(message)}</p>
        ${renderNoSignalAnalysis(result)}
        ${renderPriceActionMarketOutlook(result)}
        ${renderTargetProfileSummary(result)}
        ${renderPriceFreshness(result)}
        ${renderPriceActionResearch(result)}
        ${renderSmcAnalysis(result)}
        ${smc ? `<div class="smc-readiness-mini">Ce mode ne donne pas de probabilite de reussite. Les etapes sont un diagnostic, pas une probabilite.</div>` : ""}
        ${renderMarketChart(result)}
        <div class="score-line">
          <div class="signal-bottom"><span>Indice interne · pas une probabilité</span><strong>${score}/100</strong></div>
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
        ${renderVisualReading(result)}
        ${renderConfluence(result)}
        ${renderRiskNote(result)}
        ${renderDeterministicCrossCheck(result)}
        ${renderAdvancedDisclosure(result)}
        <button class="new-analysis mt-4" type="button">Nouvelle analyse</button>
      </div>
    `;
  }

  function renderNoSignalAnalysis(result) {
    const meta = result.meta || {};
    const technical = meta.technicalSnapshot || {};
    const narrative = String(result.explanation || "").trim();
    const pair = String(meta.pair || "Marché");
    const timeframe = String(meta.timeframe || "");
    const hasImages = Number(meta.imageQuality?.images || 0) > 0;
    const facts = [
      [technical.livePriceUsable ? "Prix live" : "Dernière clôture OHLC", technical.livePriceUsable ? meta.livePrice : technical.last],
      ["Tendance", technical.trend],
      ["RSI", technical.rsi],
      ["ATR", technical.atr],
      ["Support calculé", technical.support],
      ["Résistance calculée", technical.resistance],
    ].filter(([, value]) => (
      (value != null && value !== "" && Number.isFinite(Number(value)))
      || (typeof value === "string" && Boolean(value.trim()))
    ));
    const hasTechnicalRead = Boolean(technical.priceActionRead?.summary || technical.text || facts.length);
    if (!narrative && !hasTechnicalRead) return "";
    const historyDiagnostics = technical.historyDiagnostics;
    const providerAttempts = Array.isArray(historyDiagnostics?.attempts) ? historyDiagnostics.attempts : [];
    const providerErrors = Array.isArray(historyDiagnostics?.errors) ? historyDiagnostics.errors : [];
    const executionReadiness = meta.executionReadiness || null;
    const executionDiagnostics = executionReadiness
      ? `<div class="no-signal-data-status"><strong>Pourquoi aucun ordre copiable n'est affiché</strong><p>Historique OHLC frais et aligné : ${executionReadiness.historyConfirmed ? "confirmé" : "non confirmé"} · prix et bougies Deriv alignés : ${executionReadiness.feedConfirmed ? "confirmé" : "non confirmé"} · bid/ask pour mesurer le spread : ${executionReadiness.bidAskConfirmed ? "confirmé" : "non confirmé"} · déclencheur Price Action : ${executionReadiness.triggerConfirmed ? "confirmé" : "non confirmé"}.</p><p>${escapeHtml(executionReadiness.reason || "L'analyse du marché reste disponible; le plan d'ordre attend sa confirmation.")}</p></div>`
      : "";
    const historyNeedsAttention = Number(technical.bars || 0) < 30
      || technical.historyFresh === false
      || technical.timeframeCompatible === false;
    const dataTroubleshooting = historyNeedsAttention && historyDiagnostics
      ? `<details class="no-signal-data-status" open><summary>Diagnostic de l'historique OHLC</summary>
          <p>${escapeHtml(`${historyDiagnostics.status || "données insuffisantes"} · timeframe demandé ${historyDiagnostics.timeframe || timeframe || "n/a"} · ${historyDiagnostics.elapsedMs ?? "?"} ms · budget ${historyDiagnostics.budgetMs ?? "?"} ms`)}</p>
          ${providerAttempts.length ? `<ul>${providerAttempts.map((attempt) => `<li>${escapeHtml(`${attempt.provider || "source"}${attempt.interval ? `/${attempt.interval}` : ""} : ${attempt.result || "réponse inconnue"}${attempt.bars ? ` (${attempt.bars} bougies)` : ""}`)}</li>`).join("")}</ul>` : ""}
          ${providerErrors.length ? `<p>Détails : ${escapeHtml(providerErrors.join(" · "))}</p>` : ""}
          <p>Kronos exige au moins 30 bougies clôturées, récentes et alignées sur l'unité choisie. Tant que cette condition manque, aucun biais confirmé ni niveau d'ordre n'est validé.</p>
        </details>`
      : "";
    const formatValue = (value) => {
      if (value == null || value === "") return "—";
      if (!Number.isFinite(Number(value))) return String(value);
      return Number(value).toFixed(levelPrecision(pair, Number(value)));
    };
    const factMarkup = facts.map(([label, value]) => `
      <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(formatValue(value))}</strong></div>
    `).join("");
    const reading = technical.priceActionRead?.summary || technical.text || "";
    const lastCloseTimestamp = technical.lastCandleClosedAt ? Date.parse(technical.lastCandleClosedAt) : NaN;
    const lastCloseText = Number.isFinite(lastCloseTimestamp)
      ? new Date(lastCloseTimestamp).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
      : "date inconnue";
    const lastCloseAgeMinutes = Number.isFinite(lastCloseTimestamp)
      ? Math.max(0, Math.round((Date.now() - lastCloseTimestamp) / 60_000))
      : null;
    const lastCloseAgeText = lastCloseAgeMinutes == null
      ? "âge inconnu"
      : lastCloseAgeMinutes < 60
        ? `${lastCloseAgeMinutes} min`
        : lastCloseAgeMinutes < 1440
          ? `${(lastCloseAgeMinutes / 60).toFixed(1)} h`
          : `${(lastCloseAgeMinutes / 1440).toFixed(1)} j`;
    return `
      <section class="no-signal-analysis" aria-label="Analyse du marché sans capture">
        <div class="no-signal-analysis-head">
          <strong>${hasImages ? "Lecture Kronos" : "Lecture OHLC sans capture"} · ${escapeHtml(pair)}${timeframe ? ` · ${escapeHtml(timeframe)}` : ""}</strong>
          <small>${Number(technical.bars || 0)} bougies · ${escapeHtml(technical.source || meta.historySource || "source indisponible")}</small>
          <small>Dernière bougie clôturée : ${escapeHtml(lastCloseText)} · il y a ${escapeHtml(lastCloseAgeText)}${technical.historyFresh === false ? " · historique différé/non confirmé" : " · horodatage OHLC"}</small>
        </div>
        ${factMarkup ? `<div class="no-signal-analysis-facts">${factMarkup}</div>` : ""}
        ${reading ? `<p class="no-signal-analysis-reading"><strong>Structure lue :</strong> ${escapeHtml(reading)}</p>` : ""}
        ${executionDiagnostics}
        ${dataTroubleshooting}
        ${narrative ? `<details class="no-signal-analysis-details" open><summary>Raisonnement et données utilisées</summary><p>${escapeHtml(narrative)}</p></details>` : ""}
      </section>
    `;
  }

  function renderPriceActionMarketOutlook(result) {
    const outlook = result.meta?.marketOutlook;
    if (!outlook) return "";
    const rows = [
      ["Scénario à surveiller", outlook.primaryScenario],
      ["Position dans la structure", outlook.marketState],
      ["Option haussière · conditionnelle", outlook.bullishScenario],
      ["Option baissière · conditionnelle", outlook.bearishScenario],
      ["Confirmation requise", outlook.trigger],
      ["Invalidation", outlook.invalidation],
      ["Bougie clôturée", outlook.candle],
      ["Structure des swings", outlook.structure],
      ["Balayage de liquidité", outlook.liquidity],
      ["Imbalance récente", outlook.imbalance],
    ].filter(([, value]) => Boolean(value));
    return `
      <section class="pa-market-outlook" aria-label="Prévision conditionnelle Price Action">
        <div class="pa-market-outlook-head">
          <div><span>Price Action · lecture OHLC</span><strong>${escapeHtml(outlook.bias || "Biais non déterminé")}</strong></div>
          <b>SCÉNARIO CONDITIONNEL</b>
        </div>
        <div class="pa-market-outlook-location"><span>${outlook.dataFresh === false ? "Position actuelle indisponible" : outlook.liveQuoteUsable ? "Position au prix live" : "Position du dernier close OHLC"}</span><strong>${escapeHtml(outlook.priceLocation || "indisponible")}</strong></div>
        <div class="pa-market-outlook-grid">${rows.map(([label, value]) => `
          <div><span>${escapeHtml(label)}</span><p>${escapeHtml(value)}</p></div>
        `).join("")}</div>
        <div class="pa-market-outlook-footer">
          <span>${escapeHtml(outlook.dataNote || "Données OHLC indisponibles")}</span>
          <strong>${escapeHtml(outlook.levelsNote || "Aucun niveau d'ordre calculé sans déclencheur confirmé.")}</strong>
        </div>
      </section>
    `;
  }

  function renderTargetProfileSummary(result) {
    if (result.meta?.analysisMode === "pa_research") {
      return `<div class="target-profile-summary"><span>Profil de sortie</span><strong>Règles de recherche fixes</strong><small>Le profil prudent/étendu du formulaire ne s'applique pas aux candidats expérimentaux non exécutables.</small></div>`;
    }
    const extended = result.meta?.targetProfile === "mdt_extended";
    const label = result.meta?.targetProfileLabel || (extended ? "Objectifs étendus (expérimental)" : "Prudent (profil actuel)");
    const tp1R = Number(result.meta?.tp1R);
    const tp2R = Number(result.meta?.tp2R);
    const details = extended
      ? `TP1 ${Number.isFinite(tp1R) ? tp1R.toFixed(2) : "0.67"}R · TP2 ${Number.isFinite(tp2R) ? `${tp2R.toFixed(2)}R` : "2.00R achat / 2.67R vente"} · 50 % à TP1 puis BE`
      : "Le profil prudent existant reste actif par défaut.";
    return `<div class="target-profile-summary${extended ? " extended" : ""}"><span>Profil de sortie</span><strong>${escapeHtml(label)}</strong><small>${escapeHtml(details)}</small></div>`;
  }

  function renderSmcAnalysis(result) {
    const smc = result.meta?.smcAnalysis;
    if (!smc) return "";
    const pair = String(result.meta?.pair || "");
    const formatPrice = (value) => {
      if (value == null || value === "") return "indisponible";
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(levelPrecision(pair, number)) : "indisponible";
    };
    const statusClass = (status) => status === "confirme" ? "confirmed" : status === "attente" ? "waiting" : "blocked";
    const stages = Array.isArray(smc.stages) ? smc.stages.map((stage) => `
      <li class="smc-stage ${statusClass(stage.status)}">
        <span class="smc-stage-state">${stage.status === "confirme" ? "OK" : stage.status === "attente" ? "..." : "--"}</span>
        <span><strong>${escapeHtml(stage.label || "Etape")}</strong><small>${escapeHtml(stage.detail || "")}</small></span>
      </li>
    `).join("") : "";
    const zones = Array.isArray(smc.zones) ? smc.zones : [];
    const zoneMarkup = zones.length ? zones.map((zone) => `
      <div class="smc-zone-card ${String(zone.type || "").toLowerCase()}">
        <strong>${escapeHtml(zone.type || "Zone")} - ${zone.direction === 1 ? "ACHAT" : zone.direction === -1 ? "VENTE" : escapeHtml(zone.direction || "")}</strong>
        <span>${formatPrice(zone.low)} - ${formatPrice(zone.high)} - ${escapeHtml(zone.timeframe || smc.setupTimeframe || "")}</span>
        <small>${escapeHtml(zone.lifecycle || "repere de contexte")}</small>
      </div>
    `).join("") : `<p class="smc-empty">Aucune zone FVG, OB ou OTE exploitable dans les bougies confirmees.</p>`;
    const liquidity = smc.liquidity
      ? `<div class="smc-fact"><span>Liquidite observee</span><strong>Haut ${formatPrice(smc.liquidity.high)} - Bas ${formatPrice(smc.liquidity.low)}</strong><small>${escapeHtml(smc.liquidity.source || "extremes OHLC")}</small></div>`
      : "";
    const candidate = smc.candidateLevels ? `
      <div class="smc-candidate-levels">
        <strong>Niveaux indicatifs - aucun signal copiable</strong>
        <span>${escapeHtml(smc.candidateLevels.direction)} - entree ${formatPrice(smc.candidateLevels.entry)} - invalidation ${formatPrice(smc.candidateLevels.sl)} - cible 1.5R ${formatPrice(smc.candidateLevels.tp)}</span>
        <small>${escapeHtml(smc.candidateLevels.label || "Aucun ordre ne sera emis depuis cette simulation.")}</small>
      </div>
    ` : "";
    const benchmark = smc.benchmark || {};
    const benchmarkText = benchmark.strictTrades != null
      ? `Backtest recherche ${escapeHtml(benchmark.market || "XAU/USD")} (${escapeHtml(benchmark.timeframe || "M5/M15")}, ${escapeHtml(benchmark.sample || "période disponible")}): ${benchmark.strictTrades} trades, ${benchmark.strictWinRatePct}% gagnants, ${Number(benchmark.strictAverageR).toFixed(3)}R/trade, PF ${Number(benchmark.strictProfitFactor).toFixed(3)}, ${benchmark.positiveFolds}/${benchmark.folds} plis positifs.${benchmark.xauTrades != null ? ` XAU/USD seul: ${benchmark.xauTrades} trades, ${Number(benchmark.xauAverageR).toFixed(3)}R/trade, PF ${Number(benchmark.xauProfitFactor).toFixed(3)}.` : ""} ${escapeHtml(benchmark.note || "Résultat de recherche; ce n'est pas une probabilité de réussite.")}`
      : "Aucun resultat de recherche SMC disponible.";
    const bars = smc.inputs?.setupBars || 0;
    const contextBars = smc.inputs?.contextBars || 0;
    const stale = smc.inputs?.setupStale || smc.inputs?.contextStale;
    const mismatch = smc.inputs?.sourceAligned === false;
    return `
      <section class="smc-analysis-panel" aria-label="Diagnostic SMC Kronos">
        <div class="smc-panel-heading">
          <div><span>SMC KRONOS - ${escapeHtml(smc.version || "research")}</span><strong>${escapeHtml(smc.statusLabel || "Diagnostic indisponible")}</strong></div>
          <b>RECHERCHE</b>
        </div>
        <p class="smc-summary">${escapeHtml(smc.summary || "Analyse OHLC indisponible.")}</p>
        <div class="smc-facts-grid">
          <div class="smc-fact"><span>Contexte / setup</span><strong>${escapeHtml(smc.contextTimeframe || "-")} / ${escapeHtml(smc.setupTimeframe || "-")}</strong><small>${contextBars} / ${bars} bougies cloturees</small></div>
          <div class="smc-fact"><span>Biais MTF</span><strong>${escapeHtml(smc.bias?.label || "indisponible")}</strong><small>${escapeHtml(smc.structure?.label || "structure indisponible")}</small></div>
          ${liquidity}
          ${smc.activeZone ? `<div class="smc-fact"><span>Zone active</span><strong>${escapeHtml(smc.activeZone.type)} ${formatPrice(smc.activeZone.low)} - ${formatPrice(smc.activeZone.high)}</strong><small>expire dans ${Number(smc.activeZone.expiresInBars || 0)} bougies</small></div>` : ""}
        </div>
        ${stages ? `<ol class="smc-stage-list">${stages}</ol>` : ""}
        <div class="smc-zones-heading">Zones detectees - informationnelles</div>
        <div class="smc-zone-list">${zoneMarkup}</div>
        ${candidate}
        <div class="smc-benchmark">${benchmarkText}</div>
        <p class="smc-source-note">Sources: ${escapeHtml(smc.inputs?.setupSource || "inconnue")} / ${escapeHtml(smc.inputs?.contextSource || "inconnue")} - ${stale ? "historique differe" : "historique recent"} - ${mismatch ? "fournisseurs differents" : "sources alignees"}. Les bougies non cloturees sont exclues. Les zones ne garantissent pas un rejet et OHLC ne montre pas les ordres institutionnels.</p>
      </section>
    `;
  }

  function renderPriceActionResearch(result) {
    const research = result.meta?.priceActionAnalysis;
    if (!research) return "";
    const pair = String(result.meta?.pair || research.pair || "");
    const formatPrice = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? number.toFixed(levelPrecision(pair, number)) : "indisponible";
    };
    const candidates = Array.isArray(research.candidates) ? research.candidates : [];
    const costsVerified = research.costValidation?.status === "spread_confirmed_commission_unknown";
    const candidateMarkup = candidates.length ? candidates.map((candidate) => `
      <div class="pa-research-candidate">
        <strong>${candidate.setup === "break_retest" ? "Cassure + retest" : "Rejet confirmé"} · ${escapeHtml(candidate.directionLabel || (candidate.direction === 1 ? "ACHAT" : "VENTE"))}</strong>
        <span>Clôture candidate : ${formatPrice(candidate.entry)}</span>
        <span>Invalidation théorique : ${formatPrice(candidate.stop)}</span>
        <span>TP théoriques : ${formatPrice(candidate.tp1)} / ${formatPrice(candidate.tp2)}</span>
        <small>${candidate.costStatus === "spread_unverified"
          ? `${escapeHtml(research.costValidation?.message || "Coût total inconnu et filtre de coût non validé.")} · niveaux non copiables`
          : `Coût estimé ${Number(candidate.costR).toFixed(3)}R, commission non incluse · niveaux non copiables`}</small>
      </div>
    `).join("") : `<p class="pa-research-empty">Aucun déclencheur sur la dernière bougie clôturée. ${escapeHtml(research.statusLabel || "Attendre le setup complet.")}</p>`;
    return `
      <section class="pa-research-panel" aria-label="Diagnostic Price Action OHLC expérimental">
        <div class="pa-research-heading"><div><span>PRICE ACTION OHLC · ${escapeHtml(research.version || "recherche")}</span><strong>${escapeHtml(research.statusLabel || "Diagnostic")}</strong></div><b>NON EXÉCUTABLE</b></div>
        <p>${escapeHtml(research.summary || "Le moteur attend des bougies Deriv alignées.")}</p>
        <small>${escapeHtml(research.timeframe || result.meta?.timeframe || "UT")} · ${Number(research.bars || 0)} bougies clôturées · ${escapeHtml(research.source || "source inconnue")}</small>
        <div class="pa-research-candidates">${candidateMarkup}</div>
        <small>${escapeHtml(research.rule || "Cassure clôturée puis retest confirmé.")} ${costsVerified
          ? "Spread ponctuel mesuré, commission non confirmée; un tick de slippage par côté est modélisé."
          : `${escapeHtml(research.costValidation?.message || "Coût total et filtre de coût non validés.")} Un tick de slippage par côté est seulement indicatif.`} Ces scénarios ne valident pas l'exécution.</small>
      </section>
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
    const SIGNALS_VISIBLE = 5;
    const cards = visible.map((signal) => {
      const buy = signal.direction === "ACHAT";
      const isDirect = signal.direct !== false;
      const suspended = signal.suspended || !isDirect;
      const suspendLabel = signal.open === false ? "⏸ MARCHÉ FERMÉ" : "⏸ NON VALIDÉ";
      return `<article class="analysis-signal-card">
        <div class="signal-top">
          <div>
            <div class="signal-pair">${escapeHtml(signal.pair)}</div>
            <div class="signal-dir ${suspended ? "" : buy ? "buy" : "sell"}">${suspended ? suspendLabel : `${icon(buy ? "arrowUp" : "arrowDown")} ${signal.direction}`}</div>
          </div>
          <span class="oracle-tech">${escapeHtml(suspended ? "ANALYSE SUSPENDUE" : signal.tech)}</span>
        </div>
        ${suspended ? renderSuspended(signal) : renderActiveSignal(signal)}
        <div class="mt-2 text-[11px] text-muted-foreground">${escapeHtml(signal.reason || "")}</div>
        ${renderQuality(signal.quality)}
        <div class="mt-3 text-[10px] uppercase tracking-widest ${suspended ? "text-neon-orange" : "text-muted-foreground"}">${suspended ? suspensionFooter(signal) : "Propulsé par Kronos"}</div>
      </article>`;
    });
    const rest = cards.slice(SIGNALS_VISIBLE);
    list.innerHTML = cards.slice(0, SIGNALS_VISIBLE).join("")
      + (rest.length ? `<button type="button" class="dashboard-history-more" data-signals-more>Voir ${rest.length} paire${rest.length > 1 ? "s" : ""} de plus</button>` : "");
    list.querySelector("[data-signals-more]")?.addEventListener("click", function () {
      this.insertAdjacentHTML("beforebegin", rest.join(""));
      this.remove();
    });
  }

  function renderQuality(quality) {
    if (!quality) return "";
    const ok = quality.valid;
    const grade = quality.grade ? ` · grade ${quality.grade}` : "";
    const dataScore = Number.isFinite(Number(quality.dataScore)) ? ` · score data ${quality.dataScore}/100` : "";
    const blockers = Array.isArray(quality.blockers) && quality.blockers.length ? ` · ${quality.blockers.slice(0, 2).join(" · ")}` : "";
    return `<div class="mt-2 text-[10px] uppercase tracking-widest ${ok ? "text-neon-green" : "text-neon-orange"}">
      Qualité: ${ok ? "validée" : "bloquée"}${grade}${dataScore} · ${quality.source || "n/a"} · fiabilité ${quality.reliability || 0}% · ${quality.bars || 0} barres${blockers}
    </div>`;
  }

  function icon(name) {
    return window.OracleIcons?.[name] || "";
  }

  // The three genuinely new pieces of narrative the API extracts server-side
  // (everything else in the raw answer duplicates fields already rendered above as
  // clean cards: price, levels, R/R, technique, score). Each renders only when the
  // corresponding section actually has content, so a model that omits one doesn't
  // leave an empty card on screen.
  function renderVisualReading(result) {
    const text = result.meta?.sections?.visualReading;
    const hasImages = Number(result.meta?.imageQuality?.images || 0) > 0;
    if (!hasImages || !text) return "";
    return `
      <div class="result-visual-reading">
        <span>${icon("eye")} Lecture du graphe</span>
        <p>${escapeHtml(text)}</p>
      </div>
    `;
  }

  function renderMarketChart(result) {
    const chart = result.meta?.marketChart;
    const candles = Array.isArray(chart?.candles) ? chart.candles.filter((bar) =>
      [bar?.o, bar?.h, bar?.l, bar?.c].every((value) => Number.isFinite(Number(value)))
    ) : [];
    if (candles.length < 10) return "";

    const width = 760;
    const height = 230;
    const left = 12;
    const right = 64;
    const top = 12;
    const bottom = 18;
    const plotWidth = width - left - right;
    const plotHeight = height - top - bottom;
    const rawMin = Math.min(...candles.map((bar) => Number(bar.l)));
    const rawMax = Math.max(...candles.map((bar) => Number(bar.h)));
    const pad = Math.max((rawMax - rawMin) * 0.06, Math.abs(rawMax) * 0.00001, 1e-8);
    const min = rawMin - pad;
    const max = rawMax + pad;
    const span = max - min || 1;
    const y = (price) => top + ((max - price) / span) * plotHeight;
    const step = plotWidth / candles.length;
    const bodyWidth = Math.max(2, Math.min(9, step * 0.66));
    const guides = [
      { name: "Résistance", value: chart.resistance, color: "#ff6978", dash: "4 4" },
      { name: "Support", value: chart.support, color: "#41d99a", dash: "4 4" },
      { name: "Centre entrée", value: result.entry, color: "#f6c85f", dash: "" },
      { name: "SL", value: result.sl, color: "#ff5964", dash: "" },
      { name: "TP1", value: result.tp1, color: "#49d8a0", dash: "" },
      { name: "TP2", value: result.tp2, color: "#4bb7ff", dash: "" },
    ].map((item) => ({ ...item, value: Number(item.value) }))
      .filter((item) => Number.isFinite(item.value) && item.value >= min && item.value <= max);
    const grid = [0.25, 0.5, 0.75].map((fraction) => {
      const yy = top + plotHeight * fraction;
      const value = max - span * fraction;
      return `<line x1="${left}" y1="${yy.toFixed(2)}" x2="${(width - right).toFixed(2)}" y2="${yy.toFixed(2)}" class="market-chart-grid"/><text x="${width - right + 5}" y="${(yy + 3).toFixed(2)}" class="market-chart-axis">${escapeHtml(value.toPrecision(5))}</text>`;
    }).join("");
    const guideSvg = guides.map((item) => {
      const yy = y(item.value);
      const dash = item.dash ? ` stroke-dasharray="${item.dash}"` : "";
      return `<line x1="${left}" y1="${yy.toFixed(2)}" x2="${(width - right).toFixed(2)}" y2="${yy.toFixed(2)}" stroke="${item.color}" stroke-width="1.2"${dash}/><text x="${width - right + 5}" y="${(yy + 3).toFixed(2)}" fill="${item.color}" class="market-chart-axis">${item.name}</text>`;
    }).join("");
    const smc = result.meta?.smcAnalysis;
    const smcZones = smc?.setupTimeframe === chart.timeframe && Array.isArray(smc.zones)
      ? smc.zones.filter((zone) => Number.isFinite(Number(zone.low)) && Number.isFinite(Number(zone.high))
        && Number(zone.low) >= min && Number(zone.high) <= max)
      : [];
    const smcZoneSvg = smcZones.map((zone) => {
      const color = zone.type === "FVG" ? "#f6c85f" : zone.type === "OB" ? "#c27aff" : "#49b7ff";
      const yTop = y(Number(zone.high));
      const yBottom = y(Number(zone.low));
      return `<rect x="${left}" y="${yTop.toFixed(2)}" width="${plotWidth.toFixed(2)}" height="${Math.max(2, yBottom - yTop).toFixed(2)}" fill="${color}" fill-opacity=".14" stroke="${color}" stroke-opacity=".7" stroke-dasharray="3 3"><title>${escapeHtml(zone.type)} ${escapeHtml(zone.lifecycle || "zone")}: ${escapeHtml(Number(zone.low).toPrecision(7))} - ${escapeHtml(Number(zone.high).toPrecision(7))}</title></rect>`;
    }).join("");
    const smcLiquiditySvg = smc?.setupTimeframe === chart.timeframe && smc.liquidity
      ? [
        { label: "Liquidite haute", value: Number(smc.liquidity.high) },
        { label: "Liquidite basse", value: Number(smc.liquidity.low) },
      ].filter((item) => Number.isFinite(item.value) && item.value >= min && item.value <= max)
        .map((item) => `<line x1="${left}" y1="${y(item.value).toFixed(2)}" x2="${(width - right).toFixed(2)}" y2="${y(item.value).toFixed(2)}" stroke="#49b7ff" stroke-width="1" stroke-dasharray="2 4"><title>${item.label}: ${item.value.toPrecision(7)}</title></line>`).join("")
      : "";
    const entryZone = getEntryZone(result);
    const entryZoneSvg = entryZone && entryZone.low >= min && entryZone.high <= max
      ? `<rect x="${left}" y="${y(entryZone.high).toFixed(2)}" width="${plotWidth.toFixed(2)}" height="${Math.max(2, y(entryZone.low) - y(entryZone.high)).toFixed(2)}" fill="#f6c85f" fill-opacity=".16" stroke="#f6c85f" stroke-opacity=".55" stroke-dasharray="3 3"><title>Zone d'entrée indicative ${escapeHtml(entryZone.range)} · centre ${escapeHtml(entryZone.centerText)}</title></rect>`
      : "";
    const barsSvg = candles.map((bar, index) => {
      const x = left + step * index + step / 2;
      const open = Number(bar.o);
      const close = Number(bar.c);
      const color = close >= open ? "#42d99b" : "#f36b79";
      const bodyTop = Math.min(y(open), y(close));
      const bodyHeight = Math.max(1.4, Math.abs(y(close) - y(open)));
      return `<line x1="${x.toFixed(2)}" y1="${y(Number(bar.h)).toFixed(2)}" x2="${x.toFixed(2)}" y2="${y(Number(bar.l)).toFixed(2)}" stroke="${color}" stroke-width="1"/><rect x="${(x - bodyWidth / 2).toFixed(2)}" y="${bodyTop.toFixed(2)}" width="${bodyWidth.toFixed(2)}" height="${bodyHeight.toFixed(2)}" rx="0.6" fill="${color}"/>`;
    }).join("");
    const stale = Boolean(chart.stale);
    const source = chart.source || "API";
    const structure = chart.structureLookbackBars ? ` · structure ${chart.structureLookbackBars} bougies` : "";
    const priceActionSummary = result.meta?.technicalSnapshot?.priceActionRead?.summary;
    return `<section class="result-market-chart${stale ? " stale" : ""}" aria-label="Mini graphique interne issu des bougies API">
      <div class="result-market-chart-head"><div><span>GRAPHIQUE KRONOS · OHLC API</span><strong>${escapeHtml(chart.pair || result.meta?.pair || "Paire")} · ${escapeHtml(chart.timeframe || result.meta?.timeframe || "UT")}</strong></div><small>${candles.length} dernières bougies · ${escapeHtml(source)}${stale ? " · historique différé" : ""}</small></div>
      <div class="result-market-chart-scroll"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${candles.length} chandeliers OHLC avec niveaux calculés">
        ${grid}${smcZoneSvg}${smcLiquiditySvg}${entryZoneSvg}${guideSvg}${barsSvg}
      </svg></div>
      ${priceActionSummary ? `<p class="result-market-chart-reading"><strong>Lecture OHLC :</strong> ${escapeHtml(priceActionSummary)}</p>` : ""}
      <p>Ce mini-graphe reprend les bougies OHLC reçues par Kronos; il ne lit pas les pixels de l’iframe TradingView. Les niveaux hors de la fenêtre visible restent dans le plan ci-dessus.${escapeHtml(structure)}</p>
    </section>`;
  }

  function renderConfluence(result) {
    const text = result.meta?.sections?.confluence;
    if (!text) return "";
    return `
      <div class="result-confluence">
        <span>${icon("check")} Confluence</span>
        <p>${escapeHtml(text)}</p>
      </div>
    `;
  }

  function renderRiskNote(result) {
    const text = result.meta?.sections?.risk;
    if (!text) return "";
    return `
      <div class="result-risk-note">
        <span>${icon("alertTriangle")} Risque</span>
        <p>${escapeHtml(text)}</p>
      </div>
    `;
  }

  // Separate deterministic research signal with historical test stats. It is shown
  // for comparison and never overrides the image analysis or changes its score.
  function renderDeterministicCrossCheck(result) {
    const check = result.meta?.deterministicCrossCheck;
    if (!check) return "";
    const stats = check.stats || {};
    const statsLine = Number.isFinite(stats.rMoyenTest)
      ? `R moyen (test hors-échantillon, cette paire) : ${stats.rMoyenTest >= 0 ? "+" : ""}${stats.rMoyenTest.toFixed(3)}${stats.note ? ` — ${stats.note}` : ""}`
      : "";
    let cls = "cross-check-neutral";
    let verdict;
    if (!check.active) {
      verdict = `Pas de signal validé actuellement sur cette paire côté second moteur (${escapeHtml(check.reason || "confluence insuffisante")}).`;
    } else if (check.agreement === "accord") {
      cls = "cross-check-agree";
      verdict = `D'accord avec Kronos : ${escapeHtml(check.direction)} (indice interne du moteur ${check.confidence}/100).`;
    } else if (check.agreement === "desaccord") {
      cls = "cross-check-disagree";
      verdict = `En désaccord avec Kronos : le moteur de recherche penche pour ${escapeHtml(check.direction)} (indice interne ${check.confidence}/100).`;
    } else {
      verdict = `Signal actif côté moteur de recherche : ${escapeHtml(check.direction)} (indice interne ${check.confidence}/100).`;
    }
    return `
      <div class="result-cross-check ${cls}">
        <span>${icon("activity")} Second moteur · validation historique indicative</span>
        <p>${verdict}</p>
        ${statsLine ? `<small>${escapeHtml(statsLine)}</small>` : ""}
        <small>Ce contrôle est distinct de l'analyse affichée. Une simulation historique ne garantit pas le résultat du prochain trade.</small>
      </div>
    `;
  }

  // Everything power-users might still want (the full raw AI text, plus the dense
  // technical debug dump renderAnalysisMeta() already builds) collapsed behind one
  // disclosure instead of always-on -- this was the other half of the "wall of text"
  // complaint alongside the raw explanation blob.
  function renderAdvancedDisclosure(result) {
    const metaHtml = renderAnalysisMeta(result);
    const rawText = result.explanation || result.answer || "";
    if (!metaHtml && !rawText) return "";
    return `
      <details class="result-advanced">
        <summary>${icon("chevronDown")} Détails avancés</summary>
        ${rawText ? `<div class="result-explanation"><span>Raisonnement complet</span><p>${escapeHtml(rawText)}</p></div>` : ""}
        ${metaHtml}
      </details>
    `;
  }

  // Was buried in the collapsed "Détails avancés" section with no age indicator at
  // all -- a user reading a result after a slow Profonde-mode analysis (60-90+s,
  // confirmed live) had no way to know the entry was checked against a price from a
  // minute and a half ago. Shown inline, next to the levels, not hidden.
  function renderPriceFreshness(result) {
    const asOf = result.meta?.livePriceAsOf;
    const source = result.meta?.livePriceSource || "source non précisée";
    if (result.meta?.liveUsable === false) {
      const technical = result.meta?.technicalSnapshot || {};
      const lastClose = technical.last == null ? "aucune clôture OHLC disponible" : `dernière clôture OHLC ${technical.last}`;
      return `<p class="result-price-freshness stale">Cotation live indisponible (${escapeHtml(source)}) · ${escapeHtml(lastClose)} · analyse de contexte seulement, sans niveaux d'ordre copiables.</p>`;
    }
    const timestamp = asOf ? new Date(asOf).getTime() : NaN;
    const seconds = Number.isFinite(timestamp) ? Math.max(0, Math.round((Date.now() - timestamp) / 1000)) : null;
    if (seconds == null) return `<p class="result-price-freshness stale">Source prix : ${escapeHtml(source)} · horodatage indisponible; vérifie la cotation du courtier.</p>`;
    const label = seconds < 20 ? "à l'instant" : seconds < 60 ? `il y a ${seconds}s` : `il y a ${Math.round(seconds / 60)} min`;
    const stale = seconds >= 90;
    const brokerNote = /deriv/i.test(source) ? "flux public Deriv; compare au prix de ton compte" : "flux fournisseur, non certifié comme le flux Deriv";
    const historySource = result.meta?.historySource || "historique non précisé";
    const alignment = result.meta?.derivFeedConfirmed ? "prix/bougies Deriv alignés" : "prix et bougies non confirmés sur le même flux Deriv";
    const spread = result.meta?.livePriceBid != null && result.meta?.livePriceAsk != null
      && Number.isFinite(Number(result.meta.livePriceBid)) && Number.isFinite(Number(result.meta.livePriceAsk))
      ? `Bid ${result.meta.livePriceBid} / Ask ${result.meta.livePriceAsk} · spread ${result.meta.livePriceSpread}`
      : "bid/ask et spread d'exécution non fournis";
    return `<p class="result-price-freshness${stale ? " stale" : ""}">Prix ${label} · source ${escapeHtml(source)} · bougies ${escapeHtml(historySource)} · ${alignment} · ${brokerNote} · ${spread} · commissions/slippage non intégrés au R/R${stale ? "; prix à recontrôler avant toute entrée." : "."}</p>`;
  }

  function renderAnalysisMeta(result) {
    const meta = result.meta || {};
    const quality = meta.imageQuality;
    const calibration = meta.calibration;
    const chartContext = meta.chartContext;
    const technical = meta.technicalSnapshot;
    const news = meta.newsContext;
    const dataReliability = meta.dataReliability;
    const mtfConsensus = meta.mtfConsensus;
    const live = meta.livePrice;
    const id = result.learningId;
    if (!quality && !calibration && !live && !id && !chartContext && !technical && !news) return "";
    return `<div class="mt-3 text-[10px] uppercase tracking-widest text-muted-foreground">
      ${quality ? `<div>Qualité fichier image: ${quality.score}% · dimensions uniquement, ne confirme pas la lecture des prix · ${escapeHtml(quality.reason || "")}</div>` : ""}
      ${meta.liveUsable && live ? `<div>Prix live d'analyse: ${escapeHtml(live)} · source ${escapeHtml(meta.livePriceSource || "n/a")}</div>` : technical?.last != null ? `<div>Dernière clôture OHLC: ${escapeHtml(technical.last)} · source ${escapeHtml(technical.source || "historique indisponible")}</div>` : ""}
      ${meta.historySource ? `<div>Historique bougies: ${escapeHtml(meta.historySource)} · ${meta.derivFeedConfirmed ? "prix et bougies issus de Deriv" : "source potentiellement différente de Deriv"}</div>` : ""}
      ${technical ? `<div>Technique API: ${escapeHtml(technical.trend || "n/a")} · RSI ${escapeHtml(technical.rsi ?? "n/a")} · ${escapeHtml(technical.bars || 0)} bougies · ${escapeHtml(technical.source || "source n/a")}</div>` : ""}
      ${dataReliability ? `<div>Indice de fiabilité des données: ${Number(dataReliability.score || 0)}/100 · grade ${escapeHtml(dataReliability.grade || "n/a")}${Array.isArray(dataReliability.blockers) && dataReliability.blockers.length ? ` · ${escapeHtml(dataReliability.blockers.slice(0, 2).join(" · "))}` : ""}</div>` : ""}
      ${meta.analysisDepth ? `<div>Mode analyse: ${escapeHtml(meta.analysisDepth)}</div>` : ""}
      ${mtfConsensus ? `<div>Consensus MTF: ${escapeHtml(mtfConsensus.summary || "n/a")}${mtfConsensus.conflict ? " · conflit détecté" : ""}</div>` : ""}
      ${Array.isArray(meta.multiTimeframe) && meta.multiTimeframe.length ? `<div>Multi-timeframe: ${escapeHtml(meta.multiTimeframe.map((tf) => `${tf.timeframe}:${tf.trend || "n/a"}`).join(" · "))}</div>` : ""}
      ${news ? `<div>News/API: ${news.enabled ? (news.activeRisk ? "risque macro actif" : "contexte consulté") : "désactivé"} · ${escapeHtml(news.headlines?.[0]?.title || news.summary || "aucun titre")}</div>` : ""}
      ${meta.strategy ? `<div>Stratégie: ${escapeHtml(meta.strategy)}</div>` : ""}
      ${chartContext?.primaryPair || chartContext?.executionTimeframe ? `<div>Contexte chart: ${escapeHtml(chartContext.primaryPair || "paire manuelle")} · ${escapeHtml(chartContext.executionTimeframe || "timeframe manuel")}</div>` : ""}
      ${meta.styleComparison ? `<div>Style retenu: ${escapeHtml(meta.styleComparison.bestStyle || result.technique || "n/a")} · indice interne ${Number(meta.styleComparison.bestScore || result.score || 0)}/100</div>` : ""}
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
      <div class="signal-bottom"><span>R/R ${signal.rr} · ${signal.age} · indice interne</span><strong>${signal.score}/100</strong></div>
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
        <img src="${src}" alt="Graphique uploadé ${index + 1}" loading="lazy" decoding="async">
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
    return Promise.all(valid.map((file) => imageFileToOptimizedDataUrl(file)));
  }

  async function imageFileToOptimizedDataUrl(file) {
    const original = await readFileAsDataUrl(file);
    try {
      const image = await loadImage(original);
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", 0.88);
    } catch {
      return original;
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = src;
    });
  }

  function renderTradePlan(result) {
    const synthetic = Boolean(result.meta?.levelsAreSynthetic);
    const entryZone = getEntryZone(result);
    const plan = [
      `PAIRE: ${result.meta?.pair || "—"}`,
      `DIRECTION: ${result.direction || "—"}`,
      `TIMEFRAME: ${result.meta?.timeframe || "—"}`,
      `ZONE D'ENTRÉE: ${entryZone?.range || result.entry}`,
      entryZone ? `CENTRE DE CALCUL: ${entryZone.centerText}` : "",
      `STOP LOSS: ${result.sl}`,
      `PROFIL DE SORTIE: ${result.meta?.targetProfileLabel || "Prudent (profil actuel)"}`,
      `TAKE PROFIT 1: ${result.tp1}`,
      `TAKE PROFIT 2: ${result.tp2}`,
      `R/R TP1: ${result.rr || "—"}`,
      result.meta?.targetProfile === "mdt_extended" && Number.isFinite(Number(result.meta?.tp2R))
        ? `R/R TP2: 1:${Number(result.meta.tp2R).toFixed(2)}` : "",
      "Note: la zone d'entrée est indicative; SL, TP et R/R sont calculés depuis le centre.",
    ].filter((line) => !/:\s*$/.test(line)).join("\n");
    return `
      <div class="trade-plan">
        <div class="signal-bottom"><span>${synthetic ? "Niveaux calculés · à vérifier" : "Niveaux proposés · à vérifier sur Deriv"}</span><button type="button" data-copy-plan>Copier le plan complet</button></div>
        <pre class="trade-plan-copy">${escapeHtml(plan)}</pre>
        <p class="entry-zone-disclaimer">La zone est une marge indicative autour du point central. SL, TP et R/R restent calculés depuis ce point central; attends une confirmation du prix dans la zone.</p>
      </div>
    `;
  }

  function renderRiskPanel(result) {
    const risk = result.meta?.riskPlan || result.meta?.riskProfile;
    if (!risk) return "";
    const maxLoss = Number.isFinite(Number(risk.maxLoss)) ? `${Number(risk.maxLoss).toFixed(2)} unité(s)` : `${risk.percent || 0.5}% du capital`;
    const closeAtTp1 = Number.isFinite(Number(risk.closeAtTp1)) ? `${risk.closeAtTp1}%` : "une partie";
    return `
      <div class="capital-risk-panel">
        <div class="signal-bottom"><span>Protection du capital</span><strong>${escapeHtml(risk.label || "Protection maximale")}</strong></div>
        <div class="risk-mini-grid">
          <div><span>Perte max au SL</span><strong>${escapeHtml(maxLoss)}</strong></div>
          <div><span>TP1</span><strong>Fermer ${escapeHtml(closeAtTp1)}</strong></div>
          <div><span>Après TP1</span><strong>SL breakeven</strong></div>
        </div>
        <p>${escapeHtml(risk.instruction || risk.warning || "Ajuster le lot avant toute entrée.")}</p>
        <p>Le volume exact du contrat Deriv n'est pas calculé ici. Vérifie dans MT5 que la perte estimée au SL reste sous la limite choisie.</p>
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
      <div class="signal-bottom"><span>Indice de risque interne</span><strong>${score}/100 · ${escapeHtml(label)}</strong></div>
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

  function renderCopyValue(label, value, className = "", note = "") {
    if (!value || value === "—") return "";
    return `<div class="level-card ${escapeHtml(className)}"><div class="level-card-content"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div><button class="level-copy-button" type="button" data-copy-value="${escapeHtml(value)}" aria-label="Copier ${escapeHtml(label)}" title="Copier ${escapeHtml(label)}"><span data-copy-label>Copier</span></button></div>`;
  }

  function getEntryZone(result) {
    const center = Number(String(result?.entry ?? "").replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(center)) return null;
    const pair = String(result.meta?.pair || "");
    const precision = levelPrecision(pair, center);
    const tick = 10 ** -precision;
    const atr = Number(result.meta?.technicalSnapshot?.atr);
    const halfWidth = Number.isFinite(atr) && atr > 0 ? Math.max(tick, atr * 0.08) : tick;
    const low = Math.floor((center - halfWidth) / tick + 1e-8) * tick;
    const high = Math.ceil((center + halfWidth) / tick - 1e-8) * tick;
    const safeLow = low < center ? low : center - tick;
    const safeHigh = high > center ? high : center + tick;
    const format = (value) => value.toFixed(precision);
    return {
      low: safeLow,
      high: safeHigh,
      center,
      centerText: format(center),
      range: `${format(safeLow)} – ${format(safeHigh)}`,
    };
  }

  function levelPrecision(pair, value) {
    const symbol = String(pair).toUpperCase();
    if (/BTC|ETH|US500|NAS|SPX/i.test(symbol)) return Math.abs(value) >= 1000 ? 1 : 2;
    if (/XAU|XAG|XPT|XPD/i.test(symbol)) return 2;
    if (/JPY/i.test(symbol)) return 3;
    if (/^[A-Z]{3}\/[A-Z]{3}$/.test(symbol) || Math.abs(value) < 10) return 5;
    return Math.abs(value) >= 100 ? 2 : 5;
  }

  function getEntryZoneNote(result) {
    const entryZone = getEntryZone(result);
    if (!entryZone) return "";
    const atr = Number(result.meta?.technicalSnapshot?.atr);
    const basis = Number.isFinite(atr) && atr > 0 ? "marge de 8 % de l'ATR" : "marge minimale d'un tick";
    return `Centre de calcul : ${entryZone.centerText} · ${basis}.`;
  }

  async function copyTradePlan(container) {
    const plan = container.querySelector(".trade-plan-copy")?.textContent || "";
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan);
      const button = container.querySelector("[data-copy-plan]");
      if (button) {
        button.textContent = "Plan copié";
        setTimeout(() => { button.textContent = "Copier le plan complet"; }, 1400);
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
      const label = button.querySelector("[data-copy-label]");
      const previous = label?.textContent || button.textContent;
      if (label) label.textContent = "Copié";
      else button.textContent = "Copié";
      setTimeout(() => {
        if (label?.isConnected) label.textContent = previous;
        else if (button.isConnected) button.textContent = previous;
      }, 1200);
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

  async function postJson(url, body, timeoutMs = 120000) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) return response.json();
      let message = `Erreur serveur ${response.status}`;
      try {
        const payload = await response.json();
        message = payload.userMessage || payload.message || payload.error || message;
        if (payload?.error?.includes("quota")) {
          return {
            direction: "AUCUN SIGNAL",
            score: 0,
            technique: "Quota",
            explanation: message,
            noSignal: true,
            statusLabel: "Limite atteinte",
            userMessage: message,
            nextActions: Array.isArray(payload.nextActions) ? payload.nextActions : ["Revenir à l'heure de réinitialisation indiquée.", "Activer Premium pour supprimer la limite."],
          };
        }
      } catch {}
      return {
        direction: "AUCUN SIGNAL",
        score: 0,
        technique: "Diagnostic",
        explanation: message,
        noSignal: true,
        statusLabel: "Analyse interrompue",
        userMessage: "Le serveur a refusé ou interrompu l'analyse avant de renvoyer un setup exploitable.",
        nextActions: ["Réessayer avec 1 graphe net.", "Vérifier que le serveur local est lancé.", "Réduire le mode profond si les APIs répondent lentement."],
      };
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        const deep = body?.analysisDepth !== "Rapide";
        return {
          direction: "AUCUN SIGNAL",
          score: 0,
          technique: deep ? "Analyse profonde" : "Analyse rapide",
          explanation: deep
            ? "L'analyse profonde a dépassé le délai côté navigateur. Les APIs ou le modèle IA répondent trop lentement; relancez ou réduisez le nombre d'images/news."
            : "L'analyse rapide n'a pas répondu dans le délai prévu. Relancez avec moins d'images ou sans détection automatique.",
          noSignal: true,
          statusLabel: "Analyse trop longue",
          userMessage: deep
            ? "Kronos prend trop de temps à croiser toutes les sources. Ce n'est pas forcément une panne, mais le résultat n'est pas arrivé dans le délai."
            : "Le mode rapide doit répondre vite; le navigateur a coupé l'attente avant réception.",
          nextActions: deep
            ? ["Réessayer avec 1 seul graphe net.", "Désactiver temporairement le contexte news/API si besoin.", "Relancer l'analyse après quelques secondes."]
            : ["Réessayer sans détection automatique.", "Utiliser 1 seul graphe net.", "Relancer dans quelques secondes."],
        };
      }
      return {
        direction: "AUCUN SIGNAL",
        score: 0,
        technique: "Diagnostic",
        explanation: error?.message || "Erreur réseau inconnue pendant l'analyse.",
        noSignal: true,
        statusLabel: "Réponse non reçue",
        userMessage: "Le navigateur n'a pas pu lire la réponse de Kronos.",
        nextActions: ["Vérifier la console serveur.", "Relancer le serveur local.", "Réessayer avec une seule image."],
      };
    }
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
