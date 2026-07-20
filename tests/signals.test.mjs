import test from "node:test";
import assert from "node:assert/strict";
import { analyzeMarket, suggestedLeverage } from "../js/signals.js";

function risingCandles(count, interval, endTime, startPrice = 100) {
  const first = endTime - count * interval;
  return Array.from({ length: count }, (_, index) => {
    const open = startPrice + index * 0.25 + index ** 2 * 0.006;
    const close = open + 0.45 + Math.sin(index / 4) * 0.08;
    return { start: first + index * interval, open, high: close + 0.5, low: open - 0.35, close, volume: 1_000 + index * 12 };
  });
}

function strongContext(overrides = {}) {
  const now = Date.UTC(2026, 6, 19, 18);
  const candlesByTimeframe = {
    "60": risingCandles(120, 3_600_000, now),
    "240": risingCandles(120, 14_400_000, now),
    D: risingCandles(120, 86_400_000, now),
  };
  const last = candlesByTimeframe["60"].at(-1).close;
  return {
    symbol: "PF_XBTUSD",
    candlesByTimeframe,
    ticker: { lastPrice: last, bid: last - 0.01, ask: last + 0.01, volumeQuote: 20_000_000, serverTime: now, markPrice: last, indexPrice: last, premiumPct: 0, fundingRate: 0, fundingRatePrediction: 0 },
    instrument: { tradeable: true, maxLeverage: 10, postOnly: false },
    turnoverQuality: 1,
    dataAgeMs: 0,
    ...overrides,
  };
}

test("sterk bevestigde Kraken-markt wordt LONG", () => {
  const signal = analyzeMarket(strongContext());
  assert.equal(signal.status, "LONG");
  assert.ok(signal.score >= 70);
  assert.equal(signal.timeframeBias["240"], "LONG");
  assert.ok(signal.plan.leverage <= 10);
});

test("verouderde cachedata blokkeert een sterke setup", () => {
  assert.equal(analyzeMarket(strongContext({ dataAgeMs: 61_000 })).status, "GEEN TRADE");
});

test("geschorste of verdwenen markt wordt GEEN TRADE", () => {
  const suspended = strongContext();
  suspended.ticker = { ...suspended.ticker, suspended: true };
  assert.equal(analyzeMarket(suspended).status, "GEEN TRADE");
  assert.equal(analyzeMarket(strongContext({ instrument: { tradeable: false, maxLeverage: 10 } })).status, "GEEN TRADE");
});

for (const [name, tickerChange] of [
  ["post-only", { postOnly: true }],
  ["ontbrekende futurescontext", { markPrice: NaN }],
  ["ongunstige LONG-funding", { fundingRatePrediction: 0.0006 }],
  ["ongunstige LONG-premium", { premiumPct: 0.6 }],
]) {
  test(`${name} begrenst een sterk signaal op WATCH`, () => {
    const context = strongContext();
    context.ticker = { ...context.ticker, ...tickerChange };
    assert.equal(analyzeMarket(context).status, "WATCH");
  });
}

test("spread tussen 0,15 en 0,25 procent is maximaal WATCH", () => {
  const context = strongContext();
  const price = context.ticker.lastPrice;
  context.ticker = { ...context.ticker, bid: price * 0.999, ask: price * 1.001 };
  assert.equal(analyzeMarket(context).status, "WATCH");
});

test("ontbrekende candles leveren veilig GEEN TRADE op", () => {
  const context = strongContext({ candlesByTimeframe: { "60": [], "240": [], D: [] } });
  const signal = analyzeMarket(context);
  assert.equal(signal.status, "GEEN TRADE");
  assert.deepEqual(signal.reasons, ["Onvoldoende gesloten candles"]);
});

test("leverage respecteert stoprisico, confidencecap en limieten", () => {
  assert.equal(suggestedLeverage({ score: 75, entry: 100, stop: 97, maxLeverage: 10 }), 3);
  assert.equal(suggestedLeverage({ score: 95, entry: 100, stop: 99, maxLeverage: 5 }), 5);
  assert.equal(suggestedLeverage({ score: 50, entry: 100, stop: 98, maxLeverage: 10 }), null);
  assert.equal(suggestedLeverage({ score: 69, entry: 100, stop: 99, maxLeverage: 10 }), 2);
  assert.equal(suggestedLeverage({ score: 70, entry: 100, stop: 99, maxLeverage: 10 }), 4);
});
