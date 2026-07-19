import { API_BASE, STORAGE_KEYS, TIMEFRAMES, WS_URL } from "./constants.js";

const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function normalizeKline(row) {
  return {
    start: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    turnover: Number(row[6]),
  };
}
export class BybitClient {
  constructor({ timeout = 15_000 } = {}) {
    this.timeout = timeout;
    this.socket = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempt = 0;
    this.closedIntentionally = false;
  }

  async request(path, parameters = {}) {
    const url = new URL(`${API_BASE}${path}`);
    Object.entries(parameters).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Bybit EU gaf HTTP ${response.status}`);
      const payload = await response.json();
      if (payload.retCode !== 0) throw new Error(payload.retMsg || `Bybit fout ${payload.retCode}`);
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("Bybit EU reageerde niet op tijd");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async getInstruments() {
    const payload = await this.request("/v5/market/instruments-info", { category: "spot" });
    return { list: payload.result.list || [], serverTime: Number(payload.time) || Date.now() };
  }

  async getTickers() {
    const payload = await this.request("/v5/market/tickers", { category: "spot" });
    const serverTime = Number(payload.time) || Date.now();
    return {
      list: (payload.result.list || []).map((ticker) => ({ ...ticker, serverTime, receivedAt: Date.now() })),
      serverTime,
    };
  }

  async getKlines(symbol, interval, limit = TIMEFRAMES[interval]?.history || 260, extra = {}) {
    const payload = await this.request("/v5/market/kline", {
      category: "spot",
      symbol,
      interval,
      limit: Math.min(limit, 1000),
      ...extra,
    });
    return (payload.result.list || []).map(normalizeKline).sort((a, b) => a.start - b.start);
  }

  async getHistory(symbol, interval, days) {
    const startBoundary = Date.now() - days * 24 * 60 * 60 * 1000;
    const rows = [];
    let end = Date.now();
    for (let page = 0; page < 10; page += 1) {
      const batch = await this.getKlines(symbol, interval, 1000, { end });
      if (!batch.length) break;
      rows.push(...batch);
      const earliest = batch[0].start;
      if (earliest <= startBoundary || batch.length < 1000) break;
      end = earliest - 1;
      await pause(90);
    }
    const unique = new Map(rows.map((row) => [row.start, row]));
    return [...unique.values()].sort((a, b) => a.start - b.start);
  }

  connectPublic(symbols, handlers = {}) {
    this.disconnect();
    this.closedIntentionally = false;
    const open = () => {
      handlers.onStatus?.("connecting");
      this.socket = new WebSocket(WS_URL);
      this.socket.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        handlers.onStatus?.("live");
        const topics = [
          ...symbols.map((symbol) => `tickers.${symbol}`),
          ...symbols.map((symbol) => `kline.60.${symbol}`),
        ];
        for (let index = 0; index < topics.length; index += 10) {
          this.socket.send(JSON.stringify({ op: "subscribe", args: topics.slice(index, index + 10) }));
        }
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            this.socket.send(JSON.stringify({ op: "ping", req_id: `ping-${Date.now()}` }));
          }
        }, 20_000);
      });

      this.socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.op === "pong" || message.op === "ping") handlers.onHeartbeat?.(Date.now());
        if (!message.topic) return;
        if (message.topic.startsWith("tickers.")) {
          const symbol = message.topic.split(".").at(-1);
          const data = Array.isArray(message.data) ? message.data[0] : message.data;
          if (data) handlers.onTicker?.(symbol, { ...data, receivedAt: Date.now(), serverTime: Number(message.ts) || Date.now() });
        }
        if (message.topic.startsWith("kline.")) {
          const symbol = message.topic.split(".").at(-1);
          const data = Array.isArray(message.data) ? message.data[0] : message.data;
          if (data) {
            handlers.onKline?.(symbol, {
              start: Number(data.start),
              open: Number(data.open),
              high: Number(data.high),
              low: Number(data.low),
              close: Number(data.close),
              volume: Number(data.volume),
              turnover: Number(data.turnover),
              confirm: Boolean(data.confirm),
            });
          }
        }
      });

      this.socket.addEventListener("close", () => {
        clearInterval(this.pingTimer);
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
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.close();
      this.socket = null;
    }
  }
}

export function saveSnapshot(snapshot) {
  try {
    localStorage.setItem(STORAGE_KEYS.snapshot, JSON.stringify(snapshot));
  } catch {
    // A full or disabled storage area must never break live market data.
  }
}

export function loadSnapshot() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.snapshot));
    return parsed?.savedAt && parsed?.candles ? parsed : null;
  } catch {
    return null;
  }
}
