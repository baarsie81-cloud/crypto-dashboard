import test from "node:test";
import assert from "node:assert/strict";
import {
  KrakenClient,
  displayBase,
  filterCryptoPerpetuals,
  loadSnapshot,
  normalizeAnalytics,
  normalizeSpreadAnalytics,
  normalizeTicker,
  rankTopMarkets,
  saveSnapshot,
} from "../js/kraken.js";

const eligible = (symbol, overrides = {}) => ({
  symbol,
  type: "flexible_futures",
  base: symbol.replace(/^PF_/, "").replace(/USD$/, ""),
  quote: "USD",
  category: "Layer 1",
  tradeable: true,
  isExpired: false,
  tickSize: 0.1,
  contractValueTradePrecision: 3,
  maxPositionSize: 1_000,
  marginSchedules: { europa: { retail: [{ initialMargin: 0.1 }] } },
  ...overrides,
});

test("XBT wordt in de interface BTC", () => assert.equal(displayBase("XBT"), "BTC"));

test("marktfilter accepteert alleen EEA lineaire crypto-perpetuals", () => {
  const markets = filterCryptoPerpetuals([
    eligible("PF_XBTUSD", { base: "XBT" }),
    eligible("PF_AAPLUSD", { category: "xStocks" }),
    eligible("PF_EURUSD", { category: "Forex" }),
    eligible("PI_XBTUSD", { type: "futures_inverse" }),
    eligible("PF_NOEEAUSD", { marginSchedules: {} }),
    eligible("PF_EXPIREDUSD", { isExpired: true }),
  ]);
  assert.deepEqual(markets.map((market) => market.symbol), ["PF_XBTUSD"]);
  assert.equal(markets[0].label, "BTC/USD Perp");
  assert.equal(markets[0].maxLeverage, 10);
  assert.equal(markets[0].qtyStep, 0.001);
});

test("top 30 rangschikt eerst op quotevolume en dan open interest", () => {
  const markets = ["PF_AUSD", "PF_BUSD", "PF_CUSD"].map((symbol) => ({ symbol, tradeable: true }));
  const tickers = new Map([
    ["PF_AUSD", { volumeQuote: 100, openInterest: 1 }],
    ["PF_BUSD", { volumeQuote: 200, openInterest: 1 }],
    ["PF_CUSD", { volumeQuote: 100, openInterest: 5 }],
  ]);
  assert.deepEqual(rankTopMarkets(markets, tickers, 3).map((market) => market.symbol), ["PF_BUSD", "PF_CUSD", "PF_AUSD"]);
});

test("REST- en WebSocketticker worden naar dezelfde interface genormaliseerd", () => {
  const rest = normalizeTicker({ symbol: "PF_XBTUSD", last: 100, bid: 99, ask: 101, indexPrice: 100, markPrice: 100.5, fundingRate: 0.01, fundingRatePrediction: 0.02, change24h: 2, volumeQuote: 5_000 });
  assert.equal(rest.fundingRate, 0.0001);
  assert.equal(rest.fundingRatePrediction, 0.0002);
  assert.equal(rest.premiumPct, 0.5);
  const ws = normalizeTicker({ product_id: "PF_XBTUSD", last: 100, bid: 99, ask: 101, index: 100, markPrice: 100.5, relative_funding_rate: 0.0001, relative_funding_rate_prediction: 0.0002, premium: 0.5 });
  assert.equal(ws.symbol, "PF_XBTUSD");
  assert.equal(ws.indexPrice, 100);
  assert.equal(ws.fundingRatePrediction, 0.0002);
});

test("analytics normaliseert milliseconden en seconden", () => {
  const funding = normalizeAnalytics({ result: { timestamp: [1_700_000_000_000], data: { relativeRate: [[1, 2, 3, "0.001"]] } } });
  const spread = normalizeSpreadAnalytics({ result: { timestamp: [1_700_000_000], data: { bid: { best_price: [99] }, ask: { best_price: [101] } } } });
  assert.deepEqual(funding, [{ start: 1_700_000_000_000, value: 0.001 }]);
  assert.equal(spread[0].start, 1_700_000_000_000);
  assert.equal(spread[0].value, 2);
});

test("Kraken API-fouten en rate limits krijgen een duidelijke foutmelding", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429 });
  try {
    await assert.rejects(new KrakenClient({ timeout: 100 }).request("/tickers"), /HTTP 429/);
  } finally { globalThis.fetch = originalFetch; }
});

test("publieke WebSocket plant automatisch een herverbinding", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const sockets = [];
  class FakeWebSocket {
    constructor() { this.listeners = new Map(); sockets.push(this); }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
    emit(type, payload = {}) { this.listeners.get(type)?.(payload); }
    send() {}
    close() {}
  }
  globalThis.setTimeout = (handler, delay, ...args) => originalSetTimeout(handler, Math.min(delay, 5), ...args);
  const client = new KrakenClient({ WebSocketImpl: FakeWebSocket });
  try {
    client.connectPublic(["PF_XBTUSD"]);
    assert.equal(sockets.length, 1);
    sockets[0].emit("close");
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    assert.equal(sockets.length, 2);
  } finally {
    client.disconnect();
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("versie-2-cache bewaart maximaal veertig markten", () => {
  const original = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    const candles = Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`PF_${index}USD`, { savedAt: index }]));
    saveSnapshot({ version: 2, savedAt: 1, candles });
    assert.equal(Object.keys(loadSnapshot().candles).length, 40);
  } finally { globalThis.localStorage = original; }
});
