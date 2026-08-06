import { WS_URL } from "./constants.js";
import { KrakenClient } from "./kraken.js";

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;

function sortedLevels(levels, descending = false) {
  return [...levels.entries()]
    .map(([price, qty]) => ({ price: Number(price), qty: Number(qty) }))
    .filter((row) => row.price > 0 && row.qty > 0)
    .sort((a, b) => descending ? b.price - a.price : a.price - b.price);
}

export function calculateBookExecution({ bids = [], asks = [], contractSize = 1, targetNotionalUSD = 1000 } = {}) {
  const multiplier = finitePositive(contractSize) ? Number(contractSize) : 1;
  const target = Number(targetNotionalUSD);
  const bestBid = Number(bids[0]?.price);
  const bestAsk = Number(asks[0]?.price);
  if (!(bestBid > 0 && bestAsk > 0 && target > 0)) return null;
  const mid = (bestBid + bestAsk) / 2;
  const consume = (levels) => {
    let remaining = target;
    let filledNotional = 0;
    let filledUnits = 0;
    for (const level of levels) {
      const levelUnits = Number(level.qty) * multiplier;
      const levelNotional = levelUnits * Number(level.price);
      const usedNotional = Math.min(remaining, levelNotional);
      filledNotional += usedNotional;
      filledUnits += usedNotional / Number(level.price);
      remaining -= usedNotional;
      if (remaining <= 1e-8) break;
    }
    return remaining <= 1e-8 && filledUnits > 0 ? filledNotional / filledUnits : null;
  };
  const buyVwap = consume(asks);
  const sellVwap = consume(bids);
  const depthWithin = (levels, side, pct) => levels.reduce((sum, level) => {
    const inside = side === "ask"
      ? level.price <= mid * (1 + pct / 100)
      : level.price >= mid * (1 - pct / 100);
    return inside ? sum + level.qty * multiplier * level.price : sum;
  }, 0);
  const validatedDepthUSD = Math.min(depthWithin(bids, "bid", 0.1), depthWithin(asks, "ask", 0.1));
  return {
    bestBid,
    bestAsk,
    spreadPct: ((bestAsk - bestBid) / mid) * 100,
    buySlippagePct: buyVwap ? ((buyVwap - bestAsk) / bestAsk) * 100 : Infinity,
    sellSlippagePct: sellVwap ? ((bestBid - sellVwap) / bestBid) * 100 : Infinity,
    validatedDepthUSD,
    bookDepthMultiple: validatedDepthUSD / target,
  };
}

export class FuturesOrderBook {
  constructor(symbol) {
    this.symbol = symbol;
    this.reset();
  }

  reset() {
    this.bids = new Map();
    this.asks = new Map();
    this.seq = null;
    this.timestamp = 0;
    this.valid = false;
  }

  applySnapshot(message = {}) {
    this.reset();
    for (const row of message.bids || []) if (Number(row.qty) > 0) this.bids.set(Number(row.price), Number(row.qty));
    for (const row of message.asks || []) if (Number(row.qty) > 0) this.asks.set(Number(row.price), Number(row.qty));
    this.seq = Number(message.seq);
    this.timestamp = Number(message.timestamp) || Date.now();
    this.valid = Number.isInteger(this.seq) && this.bids.size > 0 && this.asks.size > 0;
    return this.valid;
  }

  applyDelta(message = {}) {
    const nextSeq = Number(message.seq);
    if (!this.valid || !Number.isInteger(nextSeq) || nextSeq !== this.seq + 1) {
      this.valid = false;
      return false;
    }
    const side = message.side === "buy" ? this.bids : message.side === "sell" ? this.asks : null;
    const price = Number(message.price);
    const qty = Number(message.qty);
    if (!side || !(price > 0) || !Number.isFinite(qty)) {
      this.valid = false;
      return false;
    }
    if (qty === 0) side.delete(price);
    else side.set(price, qty);
    this.seq = nextSeq;
    this.timestamp = Number(message.timestamp) || Date.now();
    return true;
  }

  metrics(options = {}) {
    if (!this.valid) return null;
    return calculateBookExecution({
      bids: sortedLevels(this.bids, true),
      asks: sortedLevels(this.asks),
      ...options,
    });
  }
}

const originalGetInstruments = KrakenClient.prototype.getInstruments;
KrakenClient.prototype.getInstruments = async function getInstrumentsWithBookOptions(...args) {
  const markets = await originalGetInstruments.apply(this, args);
  this.marketOptions = new Map(markets.map((market) => [market.symbol, {
    contractSize: market.contractSize,
    targetNotionalUSD: 1000,
  }]));
  return markets;
};

KrakenClient.prototype.connectPublic = function connectPublicWithBooks(symbols, handlers = {}) {
  this.disconnect();
  const generation = ++this.connectionGeneration;
  this.currentSymbols = [...new Set(symbols)].filter(Boolean);
  this.closedIntentionally = false;
  this.books = new Map(this.currentSymbols.map((symbol) => [symbol, new FuturesOrderBook(symbol)]));
  this.lastHeartbeatAt = 0;

  const resubscribeBook = (symbol) => {
    this.books.get(symbol)?.reset();
    if (this.socket?.readyState !== 1) return;
    this.socket.send(JSON.stringify({ event: "unsubscribe", feed: "book", product_ids: [symbol] }));
    this.socket.send(JSON.stringify({ event: "subscribe", feed: "book", product_ids: [symbol] }));
  };

  const open = () => {
    if (generation !== this.connectionGeneration || this.closedIntentionally) return;
    handlers.onStatus?.("connecting");
    this.socket = new this.WebSocketImpl(WS_URL);
    this.socket.addEventListener("open", () => {
      if (generation !== this.connectionGeneration) return;
      this.reconnectAttempt = 0;
      this.lastHeartbeatAt = Date.now();
      handlers.onStatus?.("live");
      this.socket.send(JSON.stringify({ event: "subscribe", feed: "ticker", product_ids: this.currentSymbols }));
      this.socket.send(JSON.stringify({ event: "subscribe", feed: "book", product_ids: this.currentSymbols }));
      this.socket.send(JSON.stringify({ event: "subscribe", feed: "heartbeat" }));
      clearInterval(this.bookHeartbeatTimer);
      this.bookHeartbeatTimer = setInterval(() => {
        if (Date.now() - this.lastHeartbeatAt > 20_000) {
          handlers.onStatus?.("offline");
          this.socket?.close();
        }
      }, 5_000);
    });
    this.socket.addEventListener("message", (event) => {
      if (generation !== this.connectionGeneration) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.event === "error" || String(message.event || "").endsWith("_failed")) {
        handlers.onError?.(message);
        return;
      }
      if (message.feed === "heartbeat") {
        this.lastHeartbeatAt = Date.now();
        handlers.onHeartbeat?.(Number(message.time) || Date.now());
        return;
      }
      if (message.feed === "ticker" && message.product_id) {
        handlers.onTicker?.(message.product_id, {
          symbol: message.product_id,
          lastPrice: Number(message.last),
          bid: Number(message.bid),
          ask: Number(message.ask),
          bidSize: Number(message.bid_size),
          askSize: Number(message.ask_size),
          markPrice: Number(message.markPrice),
          indexPrice: Number(message.index),
          change24h: Number(message.change) || 0,
          volume24h: Number(message.volume) || 0,
          volumeQuote: Number(message.volume) * Number(message.markPrice || message.last) || 0,
          openInterest: Number(message.openInterest) || 0,
          fundingRate: Number(message.relative_funding_rate) || 0,
          fundingRatePrediction: Number(message.relative_funding_rate_prediction) || 0,
          premiumPct: Number(message.premium),
          suspended: message.suspended === true,
          postOnly: message.post_only === true,
          serverTime: Number(message.time) || Date.now(),
          receivedAt: Date.now(),
        });
        return;
      }
      if (!["book_snapshot", "book"].includes(message.feed) || !message.product_id) return;
      const book = this.books.get(message.product_id) || new FuturesOrderBook(message.product_id);
      this.books.set(message.product_id, book);
      const valid = message.feed === "book_snapshot"
        ? book.applySnapshot(message)
        : book.applyDelta(message);
      if (!valid) {
        handlers.onBookInvalid?.(message.product_id, "sequence_gap");
        handlers.onTicker?.(message.product_id, {
          symbol: message.product_id,
          bookValidated: false,
          bookTimestamp: Number(message.timestamp) || Date.now(),
          receivedAt: Date.now(),
        });
        resubscribeBook(message.product_id);
        return;
      }
      const options = handlers.getBookOptions?.(message.product_id)
        || this.marketOptions?.get(message.product_id)
        || { targetNotionalUSD: 1000 };
      const metrics = book.metrics(options);
      if (!metrics) return;
      const normalized = {
        symbol: message.product_id,
        ...metrics,
        bookValidated: true,
        bookTimestamp: book.timestamp,
        bookSeq: book.seq,
        receivedAt: Date.now(),
      };
      handlers.onBookMetrics?.(message.product_id, normalized);
      handlers.onTicker?.(message.product_id, normalized);
    });
    this.socket.addEventListener("close", () => {
      if (generation !== this.connectionGeneration) return;
      clearInterval(this.bookHeartbeatTimer);
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
};
