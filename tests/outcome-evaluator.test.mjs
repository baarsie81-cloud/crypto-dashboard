import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSetupOutcome } from "../js/outcome-evaluator.js";

const HOUR = 60 * 60 * 1000;
const createdAt = Date.UTC(2026, 7, 14, 0);
const setup = (direction = "LONG") => ({
  id: "setup-1", createdAt: new Date(createdAt).toISOString(), direction,
  referenceEntry: 100, stopPrice: direction === "LONG" ? 95 : 105,
  target1: direction === "LONG" ? 107.5 : 92.5, target2: direction === "LONG" ? 112.5 : 87.5,
});
const candle = (hour, { open = 100, high = 101, low = 99, close = 100 } = {}) => ({ start: createdAt + hour * HOUR, open, high, low, close });

test("LONG en SHORT raken T1/T2 met raw en 50/50 resultaat", () => {
  const long = evaluateSetupOutcome(setup(), [candle(1, { high: 108 }), candle(2, { high: 113 })]);
  assert.equal(long.outcomeStatus, "T2_HIT");
  assert.equal(long.rawResultR, 2.5);
  assert.equal(long.splitResultR, 2);
  const short = evaluateSetupOutcome(setup("SHORT"), [candle(1, { low: 92 }), candle(2, { low: 87 })]);
  assert.equal(short.outcomeStatus, "T2_HIT");
  assert.equal(short.rawResultR, 2.5);
});

test("stop en T1 daarna stop houden de oorspronkelijke stop voor het restant", () => {
  const stopped = evaluateSetupOutcome(setup(), [candle(1, { low: 94 })]);
  assert.equal(stopped.outcomeStatus, "STOPPED");
  assert.equal(stopped.rawResultR, -1);
  const partial = evaluateSetupOutcome(setup(), [candle(1, { high: 108 }), candle(2, { low: 94 })]);
  assert.equal(partial.rawResultR, -1);
  assert.equal(partial.splitResultR, 0.25);
});

test("stop en target in dezelfde candle is AMBIGUOUS en niet optimistisch", () => {
  const result = evaluateSetupOutcome(setup(), [candle(1, { high: 113, low: 94 })]);
  assert.equal(result.outcomeStatus, "AMBIGUOUS");
  assert.equal(result.ambiguous, true);
  assert.equal(result.resultR, null);
});

test("24h expiry, MFE, MAE en R worden zonder candles na de horizon berekend", () => {
  const rows = [candle(1, { high: 104, low: 98, close: 102 }), candle(23, { high: 105, low: 97, close: 103 }), candle(24, { high: 120, low: 90, close: 115 })];
  const result = evaluateSetupOutcome(setup(), rows);
  assert.equal(result.outcomeStatus, "EXPIRED");
  assert.equal(result.closePrice24h, 103);
  assert.equal(result.mfeR, 1);
  assert.equal(result.maeR, -0.6);
  assert.equal(result.resultR, 0.6);
});
