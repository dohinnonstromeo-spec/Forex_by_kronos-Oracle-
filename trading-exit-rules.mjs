// Shared, pure exit rules used by production and offline research.

export const SWING_TRAILING_PARAMS_BY_PAIR = Object.freeze({
  "XAU/USD": Object.freeze({ trailActivationR: 1, trailR: 0.5, trailBufferR: 0.15 }),
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
  if (bestFavR < params.trailActivationR + params.trailR) return breakevenStop;
  const trailedStop = buy
    ? entry + (bestFavR - params.trailR) * risk
    : entry - (bestFavR - params.trailR) * risk;
  return buy ? Math.max(breakevenStop, trailedStop) : Math.min(breakevenStop, trailedStop);
}
