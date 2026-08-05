// Walk-forward backtest of the exact signal logic used in buildDeterministicSignals()
// (server.mjs), replayed against real historical bars pulled from free, no-API-key
// sources (Stooq daily CSV for FX/metals/indices, Binance public klines for crypto).
//
// This is deliberately standalone (does not import server.mjs, which starts an HTTP
// server as a side effect on load) so it can be run on demand with `node scripts/backtest.mjs`.
//
// What this is: a signal-quality check on one strategy variant, on the history that
// happens to be reachable without paid data. What this is NOT: a claim about future
// performance, a full portfolio simulation (trades are evaluated independently, not
// with realistic concurrent position sizing), or a precise cost model (spread/slippage
// is approximated as a flat R haircut, not per-instrument order-book reality).

const SYMBOLS = [
  { pair: "EUR/USD", kind: "yahoo", yahooSymbol: "EURUSD=X" },
  { pair: "XAU/USD", kind: "yahoo", yahooSymbol: "GC=F" }, // gold futures used as a spot-XAU/USD proxy: no free spot-gold history without a key
  { pair: "GBP/JPY", kind: "yahoo", yahooSymbol: "GBPJPY=X" },
  { pair: "US500", kind: "yahoo", yahooSymbol: "^GSPC" },
  { pair: "BTC/USD", kind: "binance", binanceSymbol: "BTCUSDT" },
  { pair: "ETH/USD", kind: "binance", binanceSymbol: "ETHUSDT" },
];

const LOOKAHEAD_BARS = 20; // ~1 trading month on daily bars: how long a signal is given to hit TP/SL before being marked "expired"
const COST_DRAG_R = 0.05; // flat spread/slippage haircut applied to every trade's realized R, in R units

// Stooq now sits behind a JS proof-of-work bot challenge from most cloud/sandbox IPs
// (confirmed while building this script -- it returns an HTML challenge page instead
// of CSV). That's also the server's fallback #4 provider for live data, so production
// may hit the same wall intermittently. Yahoo's unofficial chart endpoint is used here
// instead: no key required, real OHLC, multi-year range.
async function fetchYahooDaily(yahooSymbol, range = "5y") {
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", "1d");
  const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`yahoo_http_${response.status}`);
  const data = await response.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || "yahoo_no_data");
  const timestamps = result.timestamp || [];
  const quote = result.indicators?.quote?.[0] || {};
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    close: Number(quote.close?.[i]),
    high: Number(quote.high?.[i]),
    low: Number(quote.low?.[i]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

async function fetchBinanceDaily(binanceSymbol) {
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", binanceSymbol);
  url.searchParams.set("interval", "1d");
  url.searchParams.set("limit", "1000");
  const response = await fetch(url);
  if (!response.ok) throw new Error(`binance_http_${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error("binance_invalid");
  return data.map((bar) => ({
    date: new Date(bar[0]).toISOString().slice(0, 10),
    close: Number(bar[4]),
    high: Number(bar[2]),
    low: Number(bar[3]),
  })).filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.high) && Number.isFinite(bar.low));
}

function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, v) => sum + v, 0) / finite.length : NaN;
}

// Wilder's smoothed RSI, identical formula to the one now used in server.mjs
// (calculateRsi), so this backtest tests what production actually computes.
function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length < period + 1) return NaN;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

// Faithful replay of buildDeterministicSignals()'s decision logic in server.mjs,
// using only bars up to (and including) `i` -- no lookahead.
function evaluateSignalAt(bars, i) {
  if (i < 60) return null; // need enough history for SMA30 + a converged Wilder RSI
  const window = bars.slice(0, i + 1);
  const closes = window.map((bar) => bar.close);
  const last = closes.at(-1);
  const sma10 = average(closes.slice(-10));
  const sma30 = average(closes.slice(-30));
  const atr = average(window.slice(-14).map((bar) => Math.max(0, bar.high - bar.low))) || last * 0.004;
  const momentum = ((sma10 - sma30) / sma30) * 100;
  const rsi = calculateRsi(closes.slice(-100));
  const prevClose = closes.at(-2);
  const move = Number.isFinite(prevClose) && prevClose ? ((last - prevClose) / prevClose) * 100 : 0;
  if (!Number.isFinite(last) || !Number.isFinite(momentum) || !Number.isFinite(rsi)) return null;
  const trendAligned = momentum >= 0 ? rsi >= 52 : rsi <= 48;
  const volatilityOk = atr / last >= 0.0008;
  const confluence = [trendAligned, volatilityOk, true, Math.abs(move) >= 0.05].filter(Boolean).length;
  const strength = Math.abs(momentum) + Math.min(Math.abs(move), 2) * 0.35 + confluence * 0.08;
  if (strength < 0.18 || confluence < 3 || !trendAligned) return null;
  const direction = momentum >= 0 ? "ACHAT" : "VENTE";
  const risk = Math.max(atr * 1.2, last * 0.0025);
  const entry = last;
  const sl = direction === "ACHAT" ? entry - risk : entry + risk;
  const tp1 = direction === "ACHAT" ? entry + risk * 1.6 : entry - risk * 1.6;
  const tp2 = direction === "ACHAT" ? entry + risk * 2.5 : entry - risk * 2.5;
  return { direction, entry, sl, tp1, tp2, risk };
}

function simulateForward(bars, signalIndex, signal) {
  const buy = signal.direction === "ACHAT";
  for (let j = signalIndex + 1; j <= Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1); j++) {
    const bar = bars[j];
    const hitSl = buy ? bar.low <= signal.sl : bar.high >= signal.sl;
    const hitTp2 = buy ? bar.high >= signal.tp2 : bar.low <= signal.tp2;
    const hitTp1 = buy ? bar.high >= signal.tp1 : bar.low <= signal.tp1;
    // Conservative ordering when both could technically fall inside the same bar: SL first.
    if (hitSl) return { result: "loss", rMultiple: -1 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp2) return { result: "win", rMultiple: 2.5 - COST_DRAG_R, barsHeld: j - signalIndex };
    if (hitTp1) return { result: "win", rMultiple: 1.6 - COST_DRAG_R, barsHeld: j - signalIndex };
  }
  const expiryIndex = Math.min(signalIndex + LOOKAHEAD_BARS, bars.length - 1);
  const expiryClose = bars[expiryIndex].close;
  const markToMarketR = buy
    ? (expiryClose - signal.entry) / signal.risk
    : (signal.entry - expiryClose) / signal.risk;
  return { result: "expired", rMultiple: markToMarketR - COST_DRAG_R, barsHeld: expiryIndex - signalIndex };
}

function backtestSymbol(pair, bars) {
  const trades = [];
  for (let i = 60; i < bars.length - 1; i++) {
    const signal = evaluateSignalAt(bars, i);
    if (!signal) continue;
    trades.push({ pair, date: bars[i].date, direction: signal.direction, ...simulateForward(bars, i, signal) });
  }
  return trades;
}

function summarize(trades) {
  if (!trades.length) return { count: 0 };
  const wins = trades.filter((t) => t.result === "win").length;
  const losses = trades.filter((t) => t.result === "loss").length;
  const expired = trades.filter((t) => t.result === "expired").length;
  const totalR = trades.reduce((sum, t) => sum + t.rMultiple, 0);
  const avgR = totalR / trades.length;
  const avgHold = trades.reduce((sum, t) => sum + t.barsHeld, 0) / trades.length;
  return {
    count: trades.length,
    wins,
    losses,
    expired,
    winRate: Math.round((wins / trades.length) * 1000) / 10,
    avgR: Math.round(avgR * 1000) / 1000,
    totalR: Math.round(totalR * 100) / 100,
    avgHoldBars: Math.round(avgHold * 10) / 10,
  };
}

async function main() {
  console.log("Backtest walk-forward de buildDeterministicSignals() -- données réelles, sans clé API.");
  console.log(`Lookahead max: ${LOOKAHEAD_BARS} bougies · haircut coûts: ${COST_DRAG_R}R par trade\n`);

  const allTrades = [];
  for (const symbol of SYMBOLS) {
    try {
      const bars = symbol.kind === "yahoo"
        ? await fetchYahooDaily(symbol.yahooSymbol)
        : await fetchBinanceDaily(symbol.binanceSymbol);
      if (bars.length < 90) {
        console.log(`${symbol.pair}: historique insuffisant (${bars.length} bougies) -- ignoré.`);
        continue;
      }
      const trades = backtestSymbol(symbol.pair, bars);
      allTrades.push(...trades);
      const stats = summarize(trades);
      console.log(
        `${symbol.pair.padEnd(8)} | ${bars.length} bougies (${bars[0].date} -> ${bars.at(-1).date}) | `
        + `${stats.count} signaux | winrate ${stats.winRate ?? "n/a"}% | R moyen ${stats.avgR ?? "n/a"} | R total ${stats.totalR ?? "n/a"}`,
      );
    } catch (error) {
      console.log(`${symbol.pair}: échec de récupération des données (${error.message}) -- ignoré.`);
    }
  }

  console.log("\n=== Global ===");
  const global = summarize(allTrades);
  if (!global.count) {
    console.log("Aucun trade simulé -- vérifie la connectivité réseau vers stooq.com / api.binance.com.");
    return;
  }
  console.log(`Trades: ${global.count} (${global.wins} gagnants, ${global.losses} perdants, ${global.expired} expirés)`);
  console.log(`Winrate brut: ${global.winRate}%`);
  console.log(`R moyen par trade (expectancy): ${global.avgR}`);
  console.log(`Durée de détention moyenne: ${global.avgHoldBars} bougies`);
  console.log("\nLimites à garder en tête: échantillon limité par l'historique gratuit disponible, pas de");
  console.log("gestion de portefeuille (positions concurrentes non modélisées), coûts approximés par un");
  console.log("haircut fixe plutôt qu'un vrai carnet d'ordres. Traiter ce chiffre comme un indicateur de");
  console.log("direction (edge positif ou négatif), pas comme une performance garantie.");
}

main();
