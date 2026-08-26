export const CORE_SYMBOLS = Object.freeze(["PF_XBTUSD", "PF_ETHUSD"]);
export const TRADE_UNIVERSE_LIMIT = 15;
export const HIGH_BETA_UNIVERSE_LIMIT = 20;
export const ALT_MIN_CONFIDENCE = 80;
export const ALT_MIN_SETUP_CONFIDENCE = 85;
export const ALT_MIN_RR = 2.5;

const HIGH_BETA_EXCLUDED_SYMBOLS = new Set([
  "PF_XBTUSD", "PF_ETHUSD", "PF_SOLUSD", "PF_XRPUSD", "PF_ADAUSD", "PF_DOGEUSD",
  "PF_LINKUSD", "PF_BNBUSD", "PF_AVAXUSD", "PF_SUIUSD", "PF_HYPEUSD", "PF_DOTUSD",
  "PF_LTCUSD", "PF_XMRUSD", "PF_XLMUSD", "PF_AAVEUSD", "PF_BCHUSD", "PF_TRXUSD",
]);

const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function tickerSpreadPct(ticker = {}) {
  if (finite(ticker.spreadPct)) return Math.max(0, Number(ticker.spreadPct));
  if (Number(ticker.bid) > 0 && Number(ticker.ask) > 0) {
    return ((Number(ticker.ask) - Number(ticker.bid)) / ((Number(ticker.ask) + Number(ticker.bid)) / 2)) * 100;
  }
  return 0.2;
}

function liquidityScore(market, ticker = {}) {
  if (!market?.tradeable || ticker.suspended || ticker.postOnly) return -Infinity;
  const volume = Math.max(0, Number(ticker.volumeQuote) || 0);
  const oi = Math.max(0, Number(ticker.openInterest) || 0) * Math.max(0, Number(ticker.markPrice || ticker.lastPrice) || 0);
  const spread = tickerSpreadPct(ticker);
  const depth = Math.max(0, Number(ticker.validatedDepthUSD) || 0);
  const slippage = Math.max(0, Number(ticker.buySlippagePct) || 0, Number(ticker.sellSlippagePct) || 0);
  return Math.log10(volume + 1) * 35
    + Math.log10(oi + 1) * 15
    + Math.log10(depth + 1) * 10
    + clamp(0.2 - spread, -0.5, 0.2) * 120
    - slippage * 80;
}

export function selectTradeUniverse(markets = [], tickers = new Map(), limit = TRADE_UNIVERSE_LIMIT) {
  const bySymbol = new Map(markets.map((market) => [market.symbol, market]));
  const core = CORE_SYMBOLS.map((symbol) => bySymbol.get(symbol)).filter(Boolean);
  const coreSet = new Set(core.map((market) => market.symbol));
  const ranked = markets
    .filter((market) => !coreSet.has(market.symbol))
    .map((market) => ({ market, score: liquidityScore(market, tickers.get(market.symbol) || {}) }))
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || a.market.symbol.localeCompare(b.market.symbol))
    .map((row) => row.market);
  return [...core, ...ranked].slice(0, Math.max(core.length, limit));
}

export function selectHighBetaUniverse(markets = [], tickers = new Map(), limit = HIGH_BETA_UNIVERSE_LIMIT) {
  return markets
    .filter((market) => !HIGH_BETA_EXCLUDED_SYMBOLS.has(market.symbol))
    .map((market) => {
      const ticker = tickers.get(market.symbol) || {};
      const volume = Math.max(0, Number(ticker.volumeQuote) || 0);
      const oiNotional = Math.max(0, Number(ticker.openInterest) || 0) * Math.max(0, Number(ticker.markPrice || ticker.lastPrice) || 0);
      const spread = tickerSpreadPct(ticker);
      const change = Math.abs(Number(ticker.change24h) || Number(ticker.change) || 0);
      const eligible = market.tradeable === true && ticker.suspended !== true && ticker.postOnly !== true
        && volume >= 250_000 && spread <= 0.25;
      const score = eligible
        ? Math.log10(volume + 1) * 28 + Math.log10(oiNotional + 1) * 12 + clamp(change, 0, 50) * 2 - spread * 120
        : -Infinity;
      return { market, score };
    })
    .filter((row) => Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score || a.market.symbol.localeCompare(b.market.symbol))
    .slice(0, Math.max(1, Math.min(HIGH_BETA_UNIVERSE_LIMIT, Number(limit) || HIGH_BETA_UNIVERSE_LIMIT)))
    .map((row) => row.market);
}

export function isCoreSymbol(symbol) { return CORE_SYMBOLS.includes(symbol); }

export function passes85TradeGate(signal, { symbol = signal?.symbol, btcSignal = null } = {}) {
  const reasons = [];
  if (!signal || !["LONG", "SHORT"].includes(signal.status)) reasons.push("Geen bevestigd LONG/SHORT-signaal");
  if ((Number(signal?.score) || 0) < 85) reasons.push("Score lager dan 85");
  if (!["A", "A+"].includes(signal?.tradeQuality)) reasons.push("Trade Quality is geen A/A+");
  if (!signal?.plan?.confirmed) reasons.push(signal?.plan?.waitFor || "Technische bevestiging ontbreekt");
  if (isCoreSymbol(symbol)) return { eligible: reasons.length === 0, reasons };
  if ((Number(signal?.confidence) || 0) < ALT_MIN_CONFIDENCE) reasons.push(`Altcoin Confidence lager dan ${ALT_MIN_CONFIDENCE}`);
  if ((Number(signal?.setupConfidence) || 0) < ALT_MIN_SETUP_CONFIDENCE) reasons.push(`Altcoin Setup Confidence lager dan ${ALT_MIN_SETUP_CONFIDENCE}`);
  if ((Number(signal?.plan?.rr2) || 0) < ALT_MIN_RR) reasons.push(`Altcoin R/R naar T2 lager dan ${ALT_MIN_RR}`);
  if ((Number(signal?.executionScore) || 0) < 85) reasons.push("Altcoin execution/liquiditeit lager dan 85");
  if (btcSignal && ["LONG", "SHORT"].includes(btcSignal.status) && btcSignal.status !== signal.status && (Number(btcSignal.score) || 0) >= 85) reasons.push(`BTC heeft tegengestelde ${btcSignal.status} 85+ setup`);
  return { eligible: reasons.length === 0, reasons };
}
