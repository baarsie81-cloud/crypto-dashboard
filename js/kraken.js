import {
  CRYPTO_CATEGORIES,
  MARKET_LIMITS,
  REST_BASE,
  STORAGE_KEYS,
  TIMEFRAMES,
  WS_URL,
} from "./constants.js";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const finite = (value) => Number.isFinite(Number(value));

export function displayBase(base) {
  return String(base || "").toUpperCase() === "XBT" ? "BTC" : String(base || "").toUpperCase();
}

function quantityStep(precision) {
  const digits = Math.max(0, Math.min(12, Number(precision) || 0));
  return Number((10 ** -digits).toFixed(digits));
}

function eeaRetailSchedule(instrument) {
  return instrument?.marginSchedules?.europa?.retail
    || instrument?.marginSchedules?.europa_crypto?.retail
    || [];
}

export function normalizeInstrument(instrument = {}) {
  const schedule = eeaRetailSchedule(instrument);
  const initialMargin = Number(schedule[0]?.initialMargin);
  const leverageFromSchedule = initialMargin > 0 ? Math.floor(1 / initialMargin + 1e-9) : 0;
  const base = displayBase(instrument.base);
  const qtyStep = quantityStep(instrument.contractValueTradePrecision);
  const tradeable = instrument.type === "flexible_futures"
    && String(instrument.symbol || "").startsWith("PF_")
    && instrument.quote === "USD"
    && instrument.tradeable === true
    && instrument.isExpired !== true;
  return {
    symbol: String(instrument.symbol || ""),
    base,
    apiBase: String(instrument.base || ""),
    quote: "USD",
    label: `${base}/USD Perp`,
    category: String(instrument.category || "Onbekend"),
    tickSize: Number(instrument.tickSize),
    contractSize: Number(instrument.contractSize) || 1,
    quantityPrecision: Number(instrument.contractValueTradePrecision) || 0,
    qtyStep,
    minQty: qtyStep,
    maxPositionSize: Number(instrument.maxPositionSize),
    initialMargin,
    maxLeverage: Math.max(0, Math.min(10, leverageFromSchedule)),
    tradeable,
    postOnly: instrument.postOnly === true,
    suspended: false,
    eeaEligible: schedule.length > 0,
  };
}

export function filterCryptoPerpetuals(instruments = []) {
  return instruments
    .map(normalizeInstrument)
    .filter((market) => market.tradeable && market.eeaEligible && market.maxLeverage > 0 && CRYPTO_CATEGORIES.has(market.category));
}

function derivedRelativeFunding(fundingRate, indexPrice) {
  const absolute = Number(fundingRate);
  const index = Number(indexPrice);
  return Number.isFinite(absolute) && index > 0 ? absolute / index : 0;
}

export function normalizeTicker(ticker = {}, receivedAt = Date.now()) {
  const indexPrice = Number(ticker.indexPrice ?? ticker.index);
  const markPrice = Number(ticker.markPrice);
  const lastPrice = Number(ticker.last ?? ticker.lastPrice);
  const relativeFundingRate = Number(ticker.relative_funding_rate);
  const relativeFundingPrediction = Number(ticker.relative_funding_rate_prediction);
  const premium = Number(ticker.premium);
  return {
    symbol: String(ticker.symbol ?? ticker.product_id ?? ""),
    lastPrice,
    bid: Number(ticker.bid),
    ask: Number(ticker.ask),
    bidSize: Number(ticker.bidSize ?? ticker.bid_size),
    askSize: Number(ticker.askSize ?? ticker.ask_size),
    markPrice,
    indexPrice,
    change24h: Number(ticker.change24h ?? ticker.change) || 0,
    volume24h: Number(ticker.vol24h ?? ticker.volume) || 0,
    volumeQuote: Number(ticker.volumeQuote) || 0,
    openInterest: Number(ticker.openInterest) || 0,
    fundingRate: Number.isFinite(relativeFundingRate)
      ? relativeFundingRate
      : derivedRelativeFunding(ticker.fundingRate, indexPrice),
    fundingRatePrediction: Number.isFinite(relativeFundingPrediction)
      ? relativeFundingPrediction
      : derivedRelativeFunding(ticker.fundingRatePrediction, indexPrice),
    premiumPct: Number.isFinite(premium)
      ? premium
      : indexPrice > 0 && markPrice > 0 ? ((markPrice - indexPrice) / indexPrice) * 100 : NaN,
    suspended: ticker.suspended === true,
    postOnly: ticker.postOnly === true || ticker.post_only === true,
    serverTime: Number(ticker.time) || Date.parse(ticker.lastTime) || receivedAt,
    receivedAt,
  };
}

export function rankTopMarkets(markets, tickers, limit = MARKET_LIMITS.topMarkets) {
  return markets
    .filter((market) => {
      const ticker = tickers.get(market.symbol);
      return market.tradeable && !ticker?.suspended;
    })
    .sort((left, right) => {
      const a = tickers.get(left.symbol) || {};
      const b = tickers.get(right.symbol) || {};
      return (Number(b.volumeQuote) || 0) - (Number(a.volumeQuote) || 0)
        || (Number(b.openInterest) || 0) - (Number(a.openInterest) || 0)
        || left.symbol.localeCompare(right.symbol);
    })
    .slice(0, limit);
}

export function normalizeCandle(row = {}) {
  return {
    start: Number(row.time),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  };
}

export function normalizeAnalytics(payload = {}) {
  const timestamps = payload?.result?.timestamp || [];
  const data = payload?.result?.data || {};
  const series = data.relativeRate || data.rate || data;
  const closeValue = (value) => Array.isArray(value) ? Number(value[3] ?? value.at(-1)) : Number(value);
  return timestamps.map((timestamp, index) => ({
    start: Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp),
    value: closeValue(series[index]),
  })).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.value));
}

export function normalizeSpreadAnalytics(payload = {}) {
  const timestamps = payload?.result?.timestamp || [];
  const bids = payload?.result?.data?.bid?.best_price || [];
  const asks = payload?.result?.data?.ask?.best_price || [];
  return timestamps.map((timestamp, index) => {
    const bid = Number(bids[index]);
    const ask = Number(asks[index]);
    const middle = (bid + ask) / 2;
    const start = Number(timestamp) < 1e12 ? Number(timestamp) * 1000 : Number(timestamp);
    return { start, value: middle > 0 ? ((ask - bid) / middle) * 100 : NaN };
  }).filter((row) => Number.isFinite(row.start) && Number.isFinite(row.value) && row.value >= 0);
}

export class KrakenClient {
  constructor({ timeout = 20_000, restBase = REST_BASE, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.timeout = timeout;
    this.restBase = restBase;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.closedIntentionally = false;
    this.currentSymbols = [];
    this.connectionGeneration = 0;
  }

  async request(path, parameters = {}) {
    const url = new URL(`${this.restBase}${path}`, globalThis.location?.origin || "http://localhost");
    Object.entries(parameters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error(`Kraken gaf HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Kraken reageerde niet op tijd");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getInstruments() {
    const payload = await this.request("/instruments");
    if (payload.result !== "success") throw new Error("Kraken-instrumenten konden niet worden geladen");
    return filterCryptoPerpetuals(payload.instruments || []);
  }

  async getTickers() {
    const payload = await this.request("/tickers");
    if (payload.result !== "success") throw new Error("Kraken-tickers konden niet worden geladen");
    const receivedAt = Date.now();
    return (payload.tickers || []).map((ticker) => normalizeTicker(ticker, receivedAt));
  }

  async getCandles(symbol, interval, count = MARKET_LIMITS.scanHistory, extra = {}) {
    const resolution = TIMEFRAMES[interval]?.resolution;
    if (!resolution) throw new Error("Ongeldig candle-timeframe");
    const payload = await this.request(`/charts/${encodeURIComponent(symbol)}/${resolution}`, {
      ...(count === null ? {} : { count }),
      ...extra,
    });
    return (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start);
  }

  async getHistory(symbol, interval, days) {
    const to = Math.floor(Date.now() / 1000);
    const from = to - days * 24 * 60 * 60;
    const rows = await this.getCandles(symbol, interval, null, { from, to });
    return rows.filter((row) => row.start >= from * 1000).sort((a, b) => a.start - b.start);
  }

  async getFundingHistory(symbol, days = 95) {
    const to = Math.floor(Date.now() / 1000);
    const since = to - days * 24 * 60 * 60;
    return normalizeAnalytics(await this.request(`/funding/${encodeURIComponent(symbol)}`, { since, to, interval: 3600 }));
  }

  async getSpreadHistory(symbol, days = 95) {
    const to = Math.floor(Date.now() / 1000);
    const since = to - days * 24 * 60 * 60;
    return normalizeSpreadAnalytics(await this.request(`/spreads/${encodeURIComponent(symbol)}`, { since, to, interval: 3600 }));
  }

  connectPublic(symbols, handlers = {}) {
    this.disconnect();
    const generation = ++this.connectionGeneration;
    this.currentSymbols = [...new Set(symbols)].filter(Boolean);
    this.closedIntentionally = false;
    const open = () => {
      if (generation !== this.connectionGeneration || this.closedIntentionally) return;
      handlers.onStatus?.("connecting");
      this.socket = new this.WebSocketImpl(WS_URL);
      this.socket.addEventListener("open", () => {
        if (generation !== this.connectionGeneration) return;
        this.reconnectAttempt = 0;
        handlers.onStatus?.("live");
        this.socket.send(JSON.stringify({ event: "subscribe", feed: "ticker", product_ids: this.currentSymbols }));
        this.socket.send(JSON.stringify({ event: "subscribe", feed: "heartbeat" }));
      });
      this.socket.addEventListener("message", (event) => {
        if (generation !== this.connectionGeneration) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.feed === "heartbeat") handlers.onHeartbeat?.(Number(message.time) || Date.now());
        if (message.feed === "ticker" && message.product_id) {
          handlers.onTicker?.(message.product_id, normalizeTicker(message, Date.now()));
        }
      });
      this.socket.addEventListener("close", () => {
        if (generation !== this.connectionGeneration) return;
        handlers.onStatus?.("offline");
        if (this.closedIntentionally) return;
        const delay = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempt);
        this.reconnectAttempt += 1;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(open, delay);
      });
      this.socket.addEventListener("error", () => handlers.onStatus?.("offline"));
    };
    open();
  }

  disconnect() {
    this.closedIntentionally = true;
    this.connectionGeneration += 1;
    clearTimeout(this.reconnectTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }
}

export function saveSnapshot(snapshot) {
  try {
    const entries = Object.entries(snapshot.candles || {})
      .sort(([, a], [, b]) => (Number(b?.savedAt) || 0) - (Number(a?.savedAt) || 0))
      .slice(0, MARKET_LIMITS.cachedMarkets);
    localStorage.setItem(STORAGE_KEYS.snapshot, JSON.stringify({ ...snapshot, candles: Object.fromEntries(entries) }));
  } catch {
    // Marktdata blijft werken wanneer opslag vol of uitgeschakeld is.
  }
}

export function loadSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot));
    return parsed?.version === 2 && parsed?.savedAt && parsed?.candles ? parsed : null;
  } catch {
    return null;
  }
}

export async function runPool(tasks, concurrency = 4, onProgress) {
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      await tasks[index]();
      completed += 1;
      onProgress?.(completed, tasks.length);
      if (completed % 12 === 0) await pause(40);
    }
  });
  await Promise.all(workers);
}
