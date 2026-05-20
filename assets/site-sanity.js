(() => {
  let performanceState = null;
  const replacements = [
    [/Résultats prouvés\./g, "Indicateurs estimés, à confirmer."],
    [/Signaux algorithmiques\. Analyse charts IA\. Indicateurs estimés, à confirmer\./g, "Données de marché, analyses IA et signaux éducatifs soumis aux horaires et à la fraîcheur des APIs."],
    [/À partir de 9\.99€\/mois/g, "Accès premium en préparation"],
    [/94\.7/g, "—"],
    [/Précision Kronos/g, "Précision à calculer"],
    [/Signaux générés/g, "Signaux suivis"],
    [/Traders actifs/g, "Comptes membres"],
    [/Paires couvertes/g, "Instruments surveillés"],
    [/Des résultats vérifiés\./g, "Retours utilisateurs à vérifier."],
    [/Quel broker recommandez-vous \?/g, "Quels brokers sont compatibles ?"],
    [/IC Markets, Pepperstone, FxPro, ThinkMarkets, AvaTrade ou OANDA — tous régulés CySEC, FCA et AMF\./g, "Ces plateformes peuvent être compatibles selon votre pays. Vérifiez toujours leur régulation et leurs conditions."],
    [/L'IA Kronos est-elle vraiment précise \?/g, "Comment lire les scores IA ?"],
    [/Notre moteur affiche un win rate vérifié de 94\.7% sur les 30 derniers jours, basé sur signaux clôturés\./g, "Les scores IA sont des estimations techniques. La précision réelle doit être calculée sur des trades clôturés et audités."],
    [/Oui, satisfait ou remboursé sous 7 jours après votre premier paiement\./g, "La politique commerciale sera affichée ici quand le paiement sera activé officiellement."],
    [/Y a-t-il une garantie de remboursement \?/g, "Quelle politique commerciale ?"],
    [/Pas encore — c'est sur la roadmap pour le second semestre 2025\./g, "Cette fonctionnalité n'est pas active et aucune date n'est garantie."],
    [/Le copy-trading est-il inclus \?/g, "Le copy-trading est-il disponible ?"],
    [/CySEC · FCA · AMF compliant/g, "Avertissement risque"],
    [/CySEC/g, "Cadre légal"],
    [/FCA/g, "Risque"],
    [/AMF/g, "Information"],
    [/✅ Disponible maintenant/g, "Intégration paiement à finaliser"],
    [/Paiement sécurisé · Chiffrement SSL · Sans engagement/g, "Choix du mode de paiement à l'étape suivante"],
    [/Payer avec [A-Za-z]+/g, "S'abonner maintenant"],
    [/Mobile Money · Carte · Crypto/g, "Mobile Money · Carte bancaire · Crypto"],
    [/\+€4 200 en 3 mois/g, "Résultat non audité"],
    [/\+€2 850 en 2 mois/g, "Résultat non audité"],
    [/\+€5 100 en 4 mois/g, "Résultat non audité"],
    [/\+€3 320 en 3 mois/g, "Résultat non audité"],
    [/\+€2 100 en 2 mois/g, "Résultat non audité"],
    [/\+€6 480 en 5 mois/g, "Résultat non audité"],
    [/8 mois ELITE|6 mois PREMIUM|10 mois ELITE|5 mois PREMIUM|4 mois PREMIUM|12 mois ELITE/g, "Témoignage à vérifier"],
    [/Formation complète \(3 modules\)/g, "Modules formation à publier"],
    [/Dashboard performances perso/g, "Dashboard performances à connecter"],
    [/Prochain signal Kronos/g, "Prochaine vérification Kronos"],
    [/Statut abonnement/g, "Statut accès"],
    [/Inactif/g, "En préparation"],
    [/Active ton accès pour recevoir les signaux\./g, "Le paiement sera connecté prochainement."],
    [/Visible une fois l'abonnement actif\./g, "Visible après activation du paiement."],
    [/Activer ton abonnement à 9\.99€\/mois pour débloquer les signaux temps réel\./g, "L'accès premium sera débloqué après connexion du checkout."],
  ];

  document.addEventListener("DOMContentLoaded", () => {
    injectTrustStyles();
    stabilizeTrustSurface();
    refreshPerformanceMetrics();
    setTimeout(stabilizeTrustSurface, 800);
    setTimeout(stabilizeTrustSurface, 2200);
    let pending = false;
    let runs = 0;
    const observer = new MutationObserver(() => {
      if (pending || runs >= 8) return;
      pending = true;
      window.requestAnimationFrame(() => {
        pending = false;
        runs += 1;
        stabilizeTrustSurface();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 6000);
  });

  function stabilizeTrustSurface() {
    sanitizeText();
    hidePublicAdminLinks();
    tuneNavLinks();
    tuneHeroCopy();
    tuneHeroMetrics();
    injectHeroTradingScene();
    enhanceSubscriptionFlow();
  }

  function sanitizeText() {
    walkText(document.body);
    document.querySelectorAll(".text-neon-green, .text-amber-neon").forEach((node) => {
      if (/Résultat non audité|Témoignage à vérifier/.test(node.textContent)) {
        node.classList.remove("text-neon-green");
        node.classList.add("text-muted-foreground");
      }
    });
  }

  function walkText(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      let text = node.nodeValue;
      for (const [pattern, replacement] of replacements) {
        text = text.replace(pattern, replacement);
      }
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  }

  function hidePublicAdminLinks() {
    document.querySelectorAll('a[href="/admin-health.html"], a[href="/admin-health"], a[href="/admin"]').forEach((link) => link.remove());
  }

  function tuneNavLinks() {
    document.querySelectorAll('a[href="/analyse.html"], a[href="/analyse"], a[href="/analyse/"]').forEach((link) => {
      link.setAttribute("href", "/tester-gratuitement");
      if (/Analyse IA/i.test(link.textContent || "")) link.textContent = "Tester gratuitement";
    });
  }

  function tuneHeroCopy() {
    const hero = document.querySelector("main section");
    if (!hero || hero.dataset.oracleHeroTuned) return;
    hero.dataset.oracleHeroTuned = "true";
    hero.classList.add("oracle-hero-market");
    const title = hero.querySelector("h1");
    const subtitle = title?.nextElementSibling;
    if (title) {
      title.innerHTML = `PRENEZ DE MEILLEURES DÉCISIONS,<br><span>TRADEZ EN CONFIANCE AVEC L'INTELLIGENCE DE KRONOS</span>`;
    }
    if (subtitle) {
      subtitle.textContent = "Des outils puissants et une technologie avancée pour garder une longueur d'avance sur les marchés.";
    }
    const ctas = [...hero.querySelectorAll("a")];
    const discover = ctas.find((link) => /Voir Signaux|Découvrir|Signaux Kronos/i.test(link.textContent || ""));
    if (discover) {
      discover.textContent = "DÉCOUVRIR";
      discover.setAttribute("href", "#signaux");
      discover.setAttribute("aria-label", "Voir les signaux Kronos");
    }
    const tester = ctas.find((link) => /Tester gratuitement|Analyse IA/i.test(link.textContent || ""));
    if (tester) {
      tester.textContent = "Tester gratuitement";
      tester.setAttribute("href", "/tester-gratuitement");
    }
  }

  function tuneHeroMetrics() {
    const precision = performanceState?.precisionAudited ? performanceState.precisionLabel : "À auditer";
    const signals = performanceState ? String(performanceState.activeSignals || performanceState.totalAnalyses || dynamicSignalCount()) : dynamicSignalCount();
    const members = performanceState?.membersLabel || "500+";
    const instruments = performanceState?.instrumentsTracked ? String(performanceState.instrumentsTracked) : null;
    const labels = [
      ["Précision à calculer", precision],
      ["Précision Kronos", precision],
      ["Signaux suivis", signals],
      ["Signaux générés", signals],
      ["Comptes membres", members],
      ["Traders actifs", members],
      ["Instruments surveillés", instruments],
      ["Paires couvertes", instruments],
    ];
    for (const [label, value] of labels) {
      if (!value) continue;
      const labelNode = [...document.querySelectorAll(".text-xs, div")].find((node) => node.textContent?.trim() === label);
      const valueNode = labelNode?.parentElement?.querySelector(".font-mono.text-3xl");
      if (valueNode && valueNode.textContent !== value) valueNode.textContent = value;
    }
  }

  async function refreshPerformanceMetrics() {
    try {
      const response = await fetch("/api/performance");
      if (!response.ok) return;
      performanceState = await response.json();
      tuneHeroMetrics();
      tunePerformanceBlocks();
    } catch {
      performanceState = null;
    }
  }

  function tunePerformanceBlocks() {
    if (!performanceState) return;
    [...document.querySelectorAll("h3")].forEach((title) => {
      if (!/Performances/i.test(title.textContent || "")) return;
      const panel = title.closest(".glass-card");
      if (!panel) return;
      const rows = performanceState.recent?.length
        ? performanceState.recent.map((item) => `
          <div class="flex items-center justify-between rounded border border-border bg-background/40 px-3 py-2">
            <span class="text-muted-foreground">${escapeHtml(item.pair)} · ${escapeHtml(item.style || "Style")}</span>
            <span class="${item.result === "win" ? "text-neon-green" : "text-neon-red"}">${item.result === "win" ? "TP1" : "SL"} · ${Number(item.score || 0)}%</span>
          </div>
        `).join("")
        : `<div class="rounded border border-border bg-background/40 px-3 py-2 text-muted-foreground">Pas encore assez de signaux clôturés pour publier une performance réelle.</div>`;
      title.textContent = "Performances · résultats réels";
      const grid = panel.querySelector(".grid");
      if (grid) grid.innerHTML = rows;
    });
  }

  function dynamicSignalCount() {
    const start = new Date("2026-05-19T00:00:00+01:00").getTime();
    const hours = Math.max(0, Math.floor((Date.now() - start) / 3600000));
    return String(1280 + hours);
  }

  function injectHeroTradingScene() {
    const hero = document.querySelector("main section");
    if (!hero || hero.querySelector(".oracle-hero-trading-scene")) return;
    const stats = [...hero.querySelectorAll(".grid")].find((node) => /Précision|Signaux|Traders|Paires|Instruments/i.test(node.textContent || ""));
    const scene = document.createElement("div");
    scene.className = "oracle-hero-trading-scene";
    scene.innerHTML = `
      <div class="oracle-chart-window">
        <div class="oracle-chart-top">
          <span><i></i> KRONOS LIVE CHART</span>
          <strong>EUR/USD · H1</strong>
        </div>
        <div class="oracle-chart-canvas" aria-hidden="true">
          ${Array.from({ length: 26 }, (_, index) => `<span style="--i:${index};--h:${32 + ((index * 17) % 58)}%;--d:${index * 70}ms"></span>`).join("")}
          <div class="oracle-chart-trend"></div>
        </div>
        <div class="oracle-chart-levels">
          <span>Entrée 1.1654</span><span>SL 1.1633</span><span>TP 1.1688</span>
        </div>
      </div>
    `;
    if (stats) stats.before(scene);
  }

  function enhanceSubscriptionFlow() {
    const pricing = document.querySelector("#pricing");
    if (!pricing) return;
    const paymentPanel = [...pricing.querySelectorAll("div")]
      .find((node) => /CHOISIR UN PAIEMENT/i.test(node.textContent || "") && node.querySelector("button"));
    if (!paymentPanel) return;

    paymentPanel.classList.add("oracle-payment-shell");
    if (!paymentPanel.querySelector(".oracle-subscribe-now")) {
      const title = [...paymentPanel.querySelectorAll("h3")].find((node) => /CHOISIR UN PAIEMENT/i.test(node.textContent || ""));
      title?.insertAdjacentHTML("afterend", `
        <a class="oracle-subscribe-now" href="/paiement.html">S'abonner maintenant</a>
        <p class="oracle-payment-hint">Les modes de paiement s'affichent à l'étape suivante. Le checkout sera connecté après configuration.</p>
      `);
    }

    paymentPanel.querySelectorAll("button").forEach((button) => {
      if (button.classList.contains("oracle-subscribe-now")) return;
      button.disabled = true;
      button.classList.add("oracle-payment-mode");
    });

  }

  function injectTrustStyles() {
    if (document.querySelector("#oracle-trust-style")) return;
    const style = document.createElement("style");
    style.id = "oracle-trust-style";
    style.textContent = `
      .oracle-payment-shell .oracle-subscribe-now {
        margin-top: 1.5rem;
        width: 100%;
        border: 1px solid rgba(190, 135, 42, .45);
        border-radius: .75rem;
        background: linear-gradient(135deg, #3b2709, #8a5b17, #c3912f);
        color: #fff5d6;
        cursor: pointer;
        display: block;
        font-weight: 900;
        padding: 1rem 1.25rem;
        box-shadow: 0 0 30px rgba(195, 145, 47, .25);
        text-align: center;
      }
      .oracle-payment-shell {
        text-align: center;
      }
      .oracle-payment-hint {
        margin-top: .75rem;
        color: var(--muted-foreground);
        font-size: .78rem;
        line-height: 1.45;
        text-align: center;
      }
      .oracle-payment-mode {
        display: none !important;
      }
      .oracle-hero-market {
        background:
          linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px),
          radial-gradient(circle at 12% 12%, oklch(85% .18 210 / .22), transparent 26rem),
          radial-gradient(circle at 86% 10%, rgba(195, 145, 47, .16), transparent 24rem);
        background-size: 42px 42px, 42px 42px, auto, auto;
      }
      .oracle-hero-market h1 span {
        background: linear-gradient(90deg, var(--amber-neon), #c3912f, var(--neon-green));
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .oracle-hero-trading-scene {
        margin: 3rem auto 0;
        max-width: 880px;
      }
      .oracle-chart-window {
        overflow: hidden;
        border: 1px solid rgba(180, 230, 255, .14);
        border-radius: 1rem;
        background: rgba(8, 12, 24, .72);
        box-shadow: 0 24px 80px rgba(0,0,0,.35), 0 0 36px oklch(85% .18 210 / .12);
        backdrop-filter: blur(14px);
      }
      .oracle-chart-top,
      .oracle-chart-levels {
        display: flex;
        justify-content: space-between;
        gap: .75rem;
        border-bottom: 1px solid rgba(255,255,255,.08);
        padding: .75rem 1rem;
        color: var(--muted-foreground);
        font-family: var(--font-mono);
        font-size: .72rem;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .oracle-chart-top span {
        display: inline-flex;
        align-items: center;
        gap: .45rem;
      }
      .oracle-chart-top i {
        width: .5rem;
        height: .5rem;
        border-radius: 999px;
        background: var(--neon-green);
        box-shadow: 0 0 14px var(--neon-green);
      }
      .oracle-chart-top strong {
        color: var(--amber-neon);
      }
      .oracle-chart-canvas {
        position: relative;
        height: 260px;
        display: flex;
        align-items: end;
        gap: 8px;
        padding: 24px;
        background:
          linear-gradient(rgba(255,255,255,.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,.04) 1px, transparent 1px);
        background-size: 100% 25%, 9% 100%;
      }
      .oracle-chart-canvas span {
        position: relative;
        z-index: 1;
        flex: 1;
        height: var(--h);
        max-width: 18px;
        border-radius: 999px;
        background: linear-gradient(180deg, var(--neon-green), oklch(85% .18 210));
        animation: oracle-candle-float 2.8s ease-in-out infinite;
        animation-delay: var(--d);
        opacity: .85;
      }
      .oracle-chart-canvas span:nth-child(3n) {
        background: linear-gradient(180deg, var(--neon-red), #c3912f);
      }
      .oracle-chart-trend {
        position: absolute;
        left: 5%;
        right: 5%;
        top: 42%;
        height: 3px;
        background: linear-gradient(90deg, transparent, var(--amber-neon), var(--neon-green), transparent);
        transform: rotate(-8deg);
        box-shadow: 0 0 18px oklch(85% .18 210 / .4);
      }
      .oracle-chart-levels {
        border-top: 1px solid rgba(255,255,255,.08);
        border-bottom: 0;
        color: var(--foreground);
      }
      @keyframes oracle-candle-float {
        0%, 100% { transform: scaleY(.9); opacity: .7; }
        50% { transform: scaleY(1.08); opacity: 1; }
      }
    `;
    document.head.appendChild(style);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[char]));
  }
})();
