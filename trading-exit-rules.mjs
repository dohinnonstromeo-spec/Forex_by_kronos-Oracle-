// Shared, pure exit rules used by production and offline research.

export const SWING_TRAILING_PARAMS_BY_PAIR = Object.freeze({
  // Ten-year walk-forward validation keeps a positive edge versus fixed TP in both periods.
  // 0.6R deliberately locks profit 0.4R earlier than the higher-return 1R variant.
  "XAU/USD": Object.freeze({ trailActivationR: 0.6, trailR: 0.5, trailBufferR: 0.15 }),
  "USD/CHF": Object.freeze({ trailActivationR: 0.2, trailR: 0.3, trailBufferR: 0.15 }),
  "EUR/USD": Object.freeze({ trailActivationR: 0.2, trailR: 0.3, trailBufferR: 0.15 }),
});

export function computeTrailingStopPrice(entry, direction, risk, bestFavorablePrice, params) {
  const buy = direction === "ACHAT";
  const bestFavR = buy
    ? (bestFavorablePrice - entry) / risk
    : (entry - bestFavorablePrice) / risk;
  if (bestFavR < params.trailActivationR) return null;
  const breakevenStop = buy
    ? entry + params.trailBufferR * risk
    : entry - params.trailBufferR * risk;
  // Start following the recorded peak immediately at activation. The positive
  // buffer remains a floor, but there is no unprotected activation-to-trail
  // gap where a winner can give back most of its floating profit.
  const trailedStop = buy
    ? entry + (bestFavR - params.trailR) * risk
    : entry - (bestFavR - params.trailR) * risk;
  return buy ? Math.max(breakevenStop, trailedStop) : Math.min(breakevenStop, trailedStop);
}
