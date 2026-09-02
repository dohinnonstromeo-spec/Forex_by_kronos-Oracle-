(() => {
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelector('#refreshHealth')?.addEventListener('click', render);
    render();
    setInterval(render, 60 * 1000);
  });

  async function render() {
    const output = document.querySelector('#healthOutput');
    if (!output || output.getAttribute('aria-busy') === 'true') return;
    output.setAttribute('aria-busy', 'true');
    output.innerHTML = '<div class="health-detail-card health-detail-card--full"><p class="health-empty">Chargement des contrôles de santé...</p></div>';
    const health = await getJson('/api/health');
    if (!health) {
      updateSummary(0, 'critical', 'Indisponible', "Aucune réponse de l'API de santé.");
      output.innerHTML = '<div class="health-detail-card health-detail-card--full"><p class="health-empty">Impossible de joindre l’API de santé. Réessaie dans quelques instants.</p></div>';
      output.setAttribute('aria-busy', 'false');
      return;
    }
    const providers = Object.entries(health.providers || {});
    const prices = Object.entries(health.cache?.prices || {});
    const histories = Object.entries(health.cache?.histories || {});
    const healthy = providers.filter(([, item]) => stateFor(item?.status) === 'ok').length;
    const score = providers.length ? Math.round((healthy / providers.length) * 100) : 0;
    const overallState = !providers.length || score < 50 ? 'critical' : score < 100 ? 'warning' : 'ok';
    const stateLabel = overallState === 'ok' ? 'Opérationnel' : overallState === 'warning' ? 'Dégradé' : 'Critique';
    const recommendationCount = Array.isArray(health.recommendations) ? health.recommendations.length : 0;
    updateSummary(score, overallState, stateLabel, healthy + ' / ' + providers.length + ' provider(s) opérationnel(s)');
    setText('[data-health-provider-count]', providers.length);
    setText('[data-health-provider-meta]', healthy + ' opérationnel(s), ' + (providers.length - healthy) + ' à surveiller');
    setText('[data-health-price-count]', prices.filter(([, item]) => item?.cached).length + ' / ' + prices.length);
    setText('[data-health-analysis-count]', health.learning?.totalAnalyses || 0);
    setText('[data-health-updated]', 'Dernière vérification : ' + new Date().toLocaleTimeString('fr-FR'));
    const alert = document.querySelector('[data-health-alerts]');
    if (alert) {
      alert.dataset.state = overallState;
      alert.querySelector('strong').textContent = recommendationCount ? recommendationCount + ' recommandation(s) à examiner' : stateLabel;
      alert.querySelector('div span').textContent = recommendationCount ? "La console détaillée contient les points d'attention prioritaires." : 'Les contrôles de disponibilité sont à jour.';
    }
    const providerRows = providers.length ? providers.map(([name, item]) => {
      const state = stateFor(item?.status);
      return '<div class="health-provider-row"><div><span class="health-provider-name">' + escapeHtml(name) + '</span><span class="health-provider-meta">OK ' + (item?.ok || 0) + ' / échec ' + (item?.fail || 0) + '</span></div><span class="health-state" data-state="' + state + '">' + labelFor(state) + '</span></div>';
    }).join('') : '<p class="health-empty">Aucun provider testé depuis le dernier redémarrage.</p>';
    const priceRows = prices.length ? prices.map(([symbol, item]) => '<div class="health-cache-row"><div><span class="health-cache-name">' + escapeHtml(symbol) + '</span><span class="health-cache-meta">Source : ' + escapeHtml(item?.source || 'inconnue') + '</span></div><strong>' + (item?.cached ? 'Disponible' : 'Vide') + '</strong></div>').join('') : '<p class="health-empty">Aucun prix en cache.</p>';
    const historyRows = histories.length ? histories.map(([symbol, item]) => '<div class="health-cache-row"><div><span class="health-cache-name">' + escapeHtml(symbol) + '</span><span class="health-cache-meta">Historique disponible</span></div><strong>' + (item?.bars || 0) + ' barres</strong></div>').join('') : '<p class="health-empty">Aucun historique en cache.</p>';
    const recommendations = recommendationCount ? health.recommendations.map((item) => '<p class="health-recommendation">' + escapeHtml(item) + '</p>').join('') : '<p class="health-empty">Rien à signaler pour le moment.</p>';
    output.innerHTML = '<article class="health-detail-card health-detail-card--wide"><div class="health-detail-card-header"><h3>Providers de données</h3><span class="health-state" data-state="' + overallState + '">' + healthy + '/' + providers.length + ' OK</span></div>' + providerRows + '</article>'
      + '<article class="health-detail-card"><h3>Marché actif</h3><p class="health-empty">' + escapeHtml(health.market?.forex?.label || 'Marché inconnu') + '</p><div class="health-learning-row"><span>Heure de New York</span><strong>' + escapeHtml(health.market?.newYorkTime || '--') + '</strong></div></article>'
      + '<article class="health-detail-card"><h3>Cache des prix</h3>' + priceRows + '</article>'
      + '<article class="health-detail-card"><h3>Cache historique</h3>' + historyRows + '</article>'
      + '<article class="health-detail-card"><h3>Apprentissage</h3><div class="health-learning-row"><span>Analyses</span><strong>' + (health.learning?.totalAnalyses || 0) + '</strong></div><div class="health-learning-row"><span>Taux de réussite global</span><strong>' + escapeHtml(health.learning?.globalWinRate ?? 'non mesuré') + '</strong></div></article>'
      + '<article class="health-detail-card health-detail-card--full"><div class="health-detail-card-header"><h3>Recommandations</h3><span class="admin-section-note">' + recommendationCount + ' point(s)</span></div>' + recommendations + '</article>';
    output.setAttribute('aria-busy', 'false');
  }

  function updateSummary(score, state, label, meta) {
    setText('[data-health-score]', score + '%');
    setText('[data-health-summary-status]', label);
    setText('[data-health-summary-meta]', meta);
    const stateChip = document.querySelector('[data-health-state]');
    if (stateChip) { stateChip.dataset.state = state; stateChip.textContent = label; }
  }

  function stateFor(status) {
    const value = String(status || '').toLowerCase();
    if (['ok', 'up', 'healthy'].includes(value)) return 'ok';
    if (['down', 'error', 'failed', 'critical'].includes(value)) return 'critical';
    return 'warning';
  }

  function labelFor(state) { return state === 'ok' ? 'OK' : state === 'warning' ? 'Surveiller' : 'Critique'; }
  function setText(selector, value) { const element = document.querySelector(selector); if (element) element.textContent = String(value); }
  async function getJson(url) { try { const response = await fetch(url, { signal: AbortSignal.timeout(7000) }); return response.ok ? response.json() : null; } catch { return null; } }
  function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char])); }
})();
