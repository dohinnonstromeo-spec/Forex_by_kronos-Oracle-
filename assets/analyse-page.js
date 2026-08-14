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
      const response = await postJson("/api/analyze-chart", body, deep ? 120000 : 45000);
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
            <strong>${result.score}%</strong>
            <span>Score d'efficacité</span>
          </div>
        </div>
        <div class="levels-table result-level-grid">
          ${renderCopyValue("Entrée", result.entry, "entry")}
          ${renderCopyValue("Stop Loss", result.sl, "sl")}
          ${renderCopyValue("Take Profit 1", result.tp1, "tp")}
          ${renderCopyValue("Take Profit 2", result.tp2, "tp")}
          ${renderCopyValue("R/R ratio", result.rr, "rr")}
          <div class="level-card tech"><span>Technique</span><strong>${escapeHtml(result.technique)}</strong></div>
        </div>
        <div class="score-line">
          <div class="signal-bottom"><span>Score d'efficacité</span><strong>${result.score}%</strong></div>
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
        ${renderVisualReading(result)}
        ${renderConfluence(result)}
        ${renderRiskNote(result)}
        ${renderDeterministicCrossCheck(result)}
        ${renderAdvancedDisclosure(result)}
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
            <div class="signal-dir ${suspended ? "" : buy ? "buy" : "sell"}">${suspended ? suspendLabel : `${icon(buy ? "arrowUp" : "arrowDown")} ${signal.direction}`}</div>
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
    const grade = quality.grade ? ` · grade ${quality.grade}` : "";
    const dataScore = Number.isFinite(Number(quality.dataScore)) ? ` · score data ${quality.dataScore}%` : "";
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

  // Second, independent opinion from the one part of Kronos with a real, backtested
  // statistical edge (scripts/backtest.mjs) -- shown so the user can manually weigh
  // it, never used to auto-override the LLM's read (see server.mjs normalizeAnalysis:
  // deterministicCrossCheck only ever adds an `agreement` field, it doesn't touch score).
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
      verdict = `Pas de signal validé actuellement sur cette paire côté moteur backtesté (${escapeHtml(check.reason || "confluence insuffisante")}).`;
    } else if (check.agreement === "accord") {
      cls = "cross-check-agree";
      verdict = `D'accord avec Kronos : ${escapeHtml(check.direction)} (confiance moteur ${check.confidence}%).`;
    } else if (check.agreement === "desaccord") {
      cls = "cross-check-disagree";
      verdict = `En désaccord avec Kronos : le moteur backtesté penche pour ${escapeHtml(check.direction)} (confiance ${check.confidence}%).`;
    } else {
      verdict = `Signal actif côté moteur backtesté : ${escapeHtml(check.direction)} (confiance ${check.confidence}%).`;
    }
    return `
      <div class="result-cross-check ${cls}">
        <span>${icon("activity")} Moteur backtesté (edge prouvé)</span>
        <p>${verdict}</p>
        ${statsLine ? `<small>${escapeHtml(statsLine)}</small>` : ""}
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
      ${quality ? `<div>Image: ${quality.score}% · ${escapeHtml(quality.reason || "")}</div>` : ""}
      ${live ? `<div>Prix live vérifié: ${escapeHtml(live)}</div>` : ""}
      ${technical ? `<div>Technique API: ${escapeHtml(technical.trend || "n/a")} · RSI ${escapeHtml(technical.rsi ?? "n/a")} · ${escapeHtml(technical.bars || 0)} bougies · ${escapeHtml(technical.source || "source n/a")}</div>` : ""}
      ${dataReliability ? `<div>Fiabilité données: ${Number(dataReliability.score || 0)}% · grade ${escapeHtml(dataReliability.grade || "n/a")}${Array.isArray(dataReliability.blockers) && dataReliability.blockers.length ? ` · ${escapeHtml(dataReliability.blockers.slice(0, 2).join(" · "))}` : ""}</div>` : ""}
      ${meta.analysisDepth ? `<div>Mode analyse: ${escapeHtml(meta.analysisDepth)}</div>` : ""}
      ${mtfConsensus ? `<div>Consensus MTF: ${escapeHtml(mtfConsensus.summary || "n/a")}${mtfConsensus.conflict ? " · conflit détecté" : ""}</div>` : ""}
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

  function renderCopyValue(label, value, className = "") {
    if (!value || value === "—") return "";
    return `<button class="level-card ${escapeHtml(className)}" type="button" data-copy-value="${escapeHtml(value)}" title="Copier ${escapeHtml(label)}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></button>`;
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
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
