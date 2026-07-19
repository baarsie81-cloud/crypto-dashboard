import test from "node:test";
import assert from "node:assert/strict";
import { BybitClient } from "../js/bybit.js";

test("Bybit API-fouten krijgen een duidelijke foutmelding", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  try {
    const client = new BybitClient({ timeout: 100 });
    await assert.rejects(client.request("/v5/market/tickers"), /HTTP 503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("publieke WebSocket plant automatisch een herverbinding", async () => {
  const originalWebSocket = globalThis.WebSocket;
  const originalSetTimeout = globalThis.setTimeout;
  const sockets = [];

  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.listeners = new Map();
      this.readyState = 0;
      sockets.push(this);
    }

    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    }

    emit(type, payload = {}) {
      this.listeners.get(type)?.(payload);
    }

    send() {}

    close() {
      this.emit("close");
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  globalThis.setTimeout = (handler, delay, ...args) => originalSetTimeout(handler, Math.min(delay, 5), ...args);
  const client = new BybitClient();
  try {
    client.connectPublic(["BTCUSDC"]);
    assert.equal(sockets.length, 1);
    sockets[0].emit("close");
    await new Promise((resolve) => originalSetTimeout(resolve, 20));
    assert.equal(sockets.length, 2);
  } finally {
    client.disconnect();
    globalThis.WebSocket = originalWebSocket;
    globalThis.setTimeout = originalSetTimeout;
  }
});
