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
};
