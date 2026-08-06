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

function context(overrides = {}) {
  const now = Date.UTC(2026, 7, 6, 18);
  const candlesByTimeframe = {
    "60": risingCandles(120, 3_600_000, now),
    "240": risingCandles(120, 14_400_000, now),
    D: risingCandles(120, 86_400_000, now),
  };
  const last = candlesByTimeframe["60"].at(-1).close;
  return {
    symbol: "PF_XBTUSD",
    candlesByTimeframe,
    ticker: {
      lastPrice: last, bid: last - 0.01, ask: last + 0.01, volumeQuote: 20_000_000,
      serverTime: now, markPrice: last, indexPrice: last, premiumPct: 0,
      fundingRate: 0, fundingRatePrediction: 0, bookValidated: true,
      buySlippagePct: 0.01, sellSlippagePct: 0.01, bookDepthMultiple: 10,
    },
    instrument: { tradeable: true, maxLeverage: 10, postOnly: false },
    turnoverQuality: 1,
    dataAgeMs: 0,
    ...overrides,
  };
}

test("directionele scores, confidence en trade quality worden berekend", () => {
  const signal = analyzeMarket(context());
  assert.ok(signal.longScore > signal.shortScore);
  assert.ok(signal.confidence > 0);
  assert.match(signal.tradeQuality, /A\+|A|B|C|D/);
  assert.equal(signal.timeframeBias["240"], "LONG");
});

test("zonder gevalideerd L2-book wordt nooit een uitvoerbaar LONG/SHORT vrijgegeven", () => {
  const input = context();
  input.ticker = { ...input.ticker, bookValidated: false };
  const signal = analyzeMarket(input);
  assert.notEqual(signal.status, "LONG");
  assert.notEqual(signal.status, "SHORT");
  assert.equal(signal.executionScore, 0);
});

test("verouderde marktdata wordt niet uitvoerbaar", () => {
  const signal = analyzeMarket(context({ dataAgeMs: 61_000 }));
  assert.notEqual(signal.status, "LONG");
  assert.notEqual(signal.status, "SHORT");
});

test("ongunstige funding begrenst een bullish setup", () => {
  const input = context();
  input.ticker = { ...input.ticker, fundingRatePrediction: 0.0006 };
  assert.notEqual(analyzeMarket(input).status, "LONG");
});

test("ontbrekende candles leveren veilig GEEN TRADE", () => {
  const signal = analyzeMarket(context({ candlesByTimeframe: { "60": [], "240": [], D: [] } }));
  assert.equal(signal.status, "GEEN TRADE");
  assert.equal(signal.tradeQuality, "D");
});

test("leverage is hard begrensd en daalt bij brede stop of volatiliteit", () => {
  assert.equal(suggestedLeverage({ score: 95, setupConfidence: 95, entry: 100, stop: 99, maxLeverage: 10 }), 3);
  assert.equal(suggestedLeverage({ score: 85, setupConfidence: 82, entry: 100, stop: 97, maxLeverage: 10 }), 1);
  assert.equal(suggestedLeverage({ score: 95, setupConfidence: 95, entry: 100, stop: 99, maxLeverage: 10, atrPct: 3.5 }), 1);
});
