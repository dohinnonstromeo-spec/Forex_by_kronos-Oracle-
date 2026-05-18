(() => {
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
    setTimeout(stabilizeTrustSurface, 800);
    setTimeout(stabilizeTrustSurface, 2200);
  });

  function stabilizeTrustSurface() {
    sanitizeText();
    hidePublicAdminLinks();
    tuneHeroMetrics();
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
      node.nodeValue = text;
    }
  }

  function hidePublicAdminLinks() {
    document.querySelectorAll('a[href="/admin-health.html"], a[href="/admin-health"], a[href="/admin"]').forEach((link) => link.remove());
  }

  function tuneHeroMetrics() {
    const labels = [
      ["Précision à calculer", "Calibration"],
      ["Signaux suivis", "Live"],
      ["Comptes membres", "Ouvert"],
      ["Instruments surveillés", "8+"],
    ];
    for (const [label, value] of labels) {
      const labelNode = [...document.querySelectorAll(".text-xs, div")].find((node) => node.textContent?.trim() === label);
      const valueNode = labelNode?.parentElement?.querySelector(".font-mono.text-3xl");
      if (valueNode) valueNode.textContent = value;
    }
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
        <p class="oracle-payment-hint">Les modes de paiement s'affichent à l'étape suivante. Les liens de checkout seront connectés après configuration.</p>
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
        border: 0;
        border-radius: .75rem;
        background: #00ff88;
        color: #03120a;
        cursor: pointer;
        display: block;
        font-weight: 900;
        padding: 1rem 1.25rem;
        box-shadow: 0 0 26px rgba(0, 255, 136, .22);
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
    `;
    document.head.appendChild(style);
  }
})();
