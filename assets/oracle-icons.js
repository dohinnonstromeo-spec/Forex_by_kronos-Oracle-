// Shared inline-SVG icon set. Plain global (no IIFE/module system, matching the rest
// of this site's hand-written JS) so both analyse-page.js and kronos-live.js/index.html
// can use the same icons without duplicating markup. Load this script BEFORE any file
// that references window.OracleIcons.
//
// Minimal stroke-based icons (currentColor, no fill) so they inherit color from CSS
// and stay visually consistent wherever they're dropped in -- this is the site's
// first icon usage anywhere (previously emoji-only), so there's no prior convention
// to match beyond the existing --amber-neon/--neon-green/--neon-red accent colors.
window.OracleIcons = {
  eye: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.5 10s3-6 8.5-6 8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6Z"/><circle cx="10" cy="10" r="2.5"/></svg>',
  check: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M6.5 10.2l2.3 2.3 4.7-5"/></svg>',
  alertTriangle: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 3.2 17.5 16h-15L10 3.2Z"/><path d="M10 8.2v3.6"/><circle cx="10" cy="14" r=".3" fill="currentColor" stroke="none"/></svg>',
  arrowUp: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 16V4"/><path d="M4.5 9.5 10 4l5.5 5.5"/></svg>',
  arrowDown: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4v12"/><path d="M15.5 10.5 10 16l-5.5-5.5"/></svg>',
  chevronDown: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 7.5 10 13l5.5-5.5"/></svg>',
  activity: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 10.5h3.2l2-5.6 3 11.2 2-5.6H18"/></svg>',
  barChart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 16V9"/><path d="M10 16V4"/><path d="M16 16v-6"/></svg>',
  layers: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true"><path d="M10 2.5 17.5 7 10 11.5 2.5 7 10 2.5Z"/><path d="M2.5 11.2 10 15.7l7.5-4.5"/></svg>',
  smartphone: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="1.5" width="9" height="17" rx="1.8"/><path d="M8.5 15.3h3"/></svg>',
  creditCard: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.5" y="4" width="17" height="12" rx="1.8"/><path d="M1.5 8h17"/><path d="M4.5 12.3h3.5"/></svg>',
  coin: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 5.8v8.4"/><path d="M12.6 7.6c-.5-.7-1.5-1-2.6-1-1.4 0-2.6.7-2.6 1.9s1.2 1.6 2.6 1.7c1.4.1 2.6.5 2.6 1.8s-1.2 1.9-2.6 1.9c-1.1 0-2.1-.4-2.6-1.1"/></svg>',
  user: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="6.5" r="3.5"/><path d="M2.5 17c1-3.5 4-5.5 7.5-5.5s6.5 2 7.5 5.5"/></svg>',
  history: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 10a7.5 7.5 0 1 1 2.4 5.5"/><path d="M2.5 15v-4h4"/><path d="M10 6v4.5l3 1.7"/></svg>',
};

// Static markup can reference an icon declaratively (<span data-icon="user">Label</span>)
// instead of embedding raw <svg> soup inline -- hydrated here on load so every page
// using data-icon just needs this one script, no per-page wiring.
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    const markup = window.OracleIcons[el.dataset.icon];
    if (markup) el.insertAdjacentHTML("afterbegin", markup);
  });
});
