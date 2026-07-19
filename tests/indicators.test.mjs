import test from "node:test";
import assert from "node:assert/strict";
import { atr, closedCandles, ema, macd, rsi } from "../js/indicators.js";

test("EMA gebruikt een SMA-seed en volgt daarna de multiplier", () => {
  const result = ema([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.slice(0, 2), [null, null]);
  assert.equal(result[2], 2);
  assert.equal(result[3], 3);
  assert.equal(result[4], 4);
});
test("RSI bereikt 100 bij een reeks zonder verliezen", () => {
  const result = rsi(Array.from({ length: 30 }, (_, index) => index + 1), 14);
  assert.equal(result.at(-1), 100);
});

test("MACD levert lijn, signaal en histogram met gelijke lengte", () => {
  const values = Array.from({ length: 80 }, (_, index) => 100 + index * 0.5);
  const result = macd(values);
  assert.equal(result.line.length, values.length);
  assert.equal(result.signal.length, values.length);
  assert.equal(result.histogram.length, values.length);
  assert.ok(Number.isFinite(result.histogram.at(-1)));
});

test("ATR verwerkt gaps via de vorige slotkoers", () => {
  const candles = [
    { high: 10, low: 8, close: 9 },
    { high: 13, low: 12, close: 12.5 },
    { high: 14, low: 11, close: 13 },
  ];
  const result = atr(candles, 2);
  assert.equal(result[1], 3);
  assert.equal(result[2], 3);
});

test("een actieve candle wordt uitgesloten", () => {
  const interval = 60_000;
  const candles = [{ start: 0 }, { start: interval }, { start: interval * 2 }];
  assert.deepEqual(closedCandles(candles, interval, interval * 2.5), candles.slice(0, 2));
});
