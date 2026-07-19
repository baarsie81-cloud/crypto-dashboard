import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket, suggestedLeverage } from "../js/signals.js";

function risingCandles(count, interval, endTime, startPrice = 100) {
  const first = endTime - count * interval;
  return Array.from({ length: count }, (_, index) => {
    const open = startPrice + index * 0.25 + index ** 2 * 0.006;
    const close = open + 0.45 + Math.sin(index / 4) * 0.08;
    return {
      start: first + index * interval,
      open,
      high: close + 0.5,
      low: open - 0.35,
      close,
      volume: 1_000 + index * 12,
      turnover: (1_000 + index * 12) * close,
    };
  });
}

test("sterk bevestigde markt wordt LONG", () => {
  const now = Date.UTC(2026, 6, 19, 18);
  const candlesByTimeframe = {
    "60": risingCandles(120, 3_600_000, now),
    "240": risingCandles(120, 14_400_000, now),
    D: risingCandles(120, 86_400_000, now),
  };
  const last = candlesByTimeframe["60"].at(-1).close;
  const signal = analyzeMarket({
    symbol: "BTCUSDC",
    candlesByTimeframe,
    ticker: { lastPrice: last, bid1Price: last - 0.01, ask1Price: last + 0.01, turnover24h: 2_000_000, serverTime: now },
    instrument: { status: "Trading", marginTrading: "utaOnly" },
    turnoverQuality: 1,
    dataAgeMs: 0,
  });
  assert.equal(signal.status, "LONG");
  assert.ok(signal.score >= 70);
  assert.equal(signal.timeframeBias["240"], "LONG");
  assert.ok(signal.plan.leverage <= 10);
});

test("verouderde cachedata blokkeert een anders sterke setup", () => {
  const now = Date.UTC(2026, 6, 19, 18);
  const candles = {
    "60": risingCandles(120, 3_600_000, now),
    "240": risingCandles(120, 14_400_000, now),
    D: risingCandles(120, 86_400_000, now),
  };
  const signal = analyzeMarket({
    symbol: "BTCUSDC",
    candlesByTimeframe: candles,
    ticker: { lastPrice: 180, bid1Price: 179.99, ask1Price: 180.01, turnover24h: 2_000_000, serverTime: now },
    instrument: { status: "Trading", marginTrading: "utaOnly" },
    dataAgeMs: 61_000,
  });
  assert.equal(signal.status, "GEEN TRADE");
});

test("een tijdelijk verdwenen marginpaar wordt GEEN TRADE", () => {
  const now = Date.UTC(2026, 6, 19, 18);
  const candles = {
    "60": risingCandles(120, 3_600_000, now),
    "240": risingCandles(120, 14_400_000, now),
    D: risingCandles(120, 86_400_000, now),
  };
  const signal = analyzeMarket({
    symbol: "BTCUSDC",
    candlesByTimeframe: candles,
    ticker: { lastPrice: 180, bid1Price: 179.99, ask1Price: 180.01, turnover24h: 2_000_000, serverTime: now },
    instrument: { status: "Trading", marginTrading: "none" },
    dataAgeMs: 0,
  });
  assert.equal(signal.availability, false);
  assert.equal(signal.status, "GEEN TRADE");
  assert.equal(signal.plan, null);
});

test("ontbrekende candles leveren veilig GEEN TRADE op", () => {
  const signal = analyzeMarket({
    symbol: "BTCUSDC",
    candlesByTimeframe: { "60": [], "240": [], D: [] },
    ticker: { serverTime: Date.UTC(2026, 6, 19, 18) },
    instrument: { status: "Trading", marginTrading: "utaOnly" },
  });
  assert.equal(signal.status, "GEEN TRADE");
  assert.deepEqual(signal.reasons, ["Onvoldoende gesloten candles"]);
});

test("leverage respecteert stoprisico, confidencecap en gebruikerslimiet", () => {
  assert.equal(suggestedLeverage({ score: 75, entry: 100, stop: 97, maxLeverage: 10 }), 3);
  assert.equal(suggestedLeverage({ score: 95, entry: 100, stop: 99, maxLeverage: 5 }), 5);
  assert.equal(suggestedLeverage({ score: 50, entry: 100, stop: 98, maxLeverage: 10 }), null);
  assert.equal(suggestedLeverage({ score: 69, entry: 100, stop: 99, maxLeverage: 10 }), 2);
  assert.equal(suggestedLeverage({ score: 70, entry: 100, stop: 99, maxLeverage: 10 }), 4);
});
