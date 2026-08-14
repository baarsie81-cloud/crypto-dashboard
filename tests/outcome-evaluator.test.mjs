import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSetupOutcome } from "../js/outcome-evaluator.js";

const MINUTE = 60 * 1000;
const HORIZON_MINUTES = 24 * 60;
const createdAt = Date.UTC(2026, 7, 14, 0);
const evaluatedAt = createdAt + HORIZON_MINUTES * MINUTE;
const setup = (direction = "LONG") => ({
  id: "setup-1", createdAt: new Date(createdAt).toISOString(), direction,
  referenceEntry: 100, stopPrice: direction === "LONG" ? 95 : 105,
  target1: direction === "LONG" ? 107.5 : 92.5, target2: direction === "LONG" ? 112.5 : 87.5,
});
const candle = (minute, { open = 100, high = 101, low = 99, close = 100 } = {}) => ({
  start: createdAt + minute * MINUTE, open, high, low, close,
});
const completeCandles = (overrides = new Map()) => Array.from(
  { length: HORIZON_MINUTES },
  (_, minute) => candle(minute, overrides.get(minute)),
);
const evaluate = (candidate, rows, options = {}) => evaluateSetupOutcome(candidate, rows, {
  evaluatedAt,
  candleIntervalMs: MINUTE,
  ...options,
});

test("LONG en SHORT raken T1/T2 pas definitief met volledige 24h-dekking", () => {
  const long = evaluate(setup(), completeCandles(new Map([
    [1, { high: 108 }],
    [2, { high: 113 }],
  ])));
  assert.equal(long.outcomeStatus, "T2_HIT");
  assert.equal(long.dataComplete, true);
  assert.equal(long.rawResultR, 2.5);
  assert.equal(long.splitResultR, 2);

  const short = evaluate(setup("SHORT"), completeCandles(new Map([
    [1, { low: 92 }],
    [2, { low: 87 }],
  ])));
  assert.equal(short.outcomeStatus, "T2_HIT");
  assert.equal(short.rawResultR, 2.5);
});

test("stop en T1 daarna stop houden de oorspronkelijke stop voor het restant", () => {
  const stopped = evaluate(setup(), completeCandles(new Map([[1, { low: 94 }]])));
  assert.equal(stopped.outcomeStatus, "STOPPED");
  assert.equal(stopped.rawResultR, -1);

  const partial = evaluate(setup(), completeCandles(new Map([
    [1, { high: 108 }],
    [2, { low: 94 }],
  ])));
  assert.equal(partial.rawResultR, -1);
  assert.equal(partial.splitResultR, 0.25);
});

test("stop en target in dezelfde candle is AMBIGUOUS en niet optimistisch", () => {
  const result = evaluate(setup(), completeCandles(new Map([[1, { high: 113, low: 94 }]])));
  assert.equal(result.outcomeStatus, "AMBIGUOUS");
  assert.equal(result.dataComplete, true);
  assert.equal(result.ambiguous, true);
  assert.equal(result.resultR, null);
});

test("24h expiry, MFE, MAE en R worden zonder candles na de horizon berekend", () => {
  const rows = completeCandles(new Map([
    [60, { high: 104, low: 98, close: 102 }],
    [HORIZON_MINUTES - 1, { high: 105, low: 97, close: 103 }],
  ]));
  const result = evaluate(setup(), rows);
  assert.equal(result.outcomeStatus, "EXPIRED");
  assert.equal(result.closePrice24h, 103);
  assert.equal(result.mfeR, 1);
  assert.equal(result.maeR, -0.6);
  assert.equal(result.resultR, 0.6);
});

test("alleen T1 geraakt krijgt na volledige horizon de definitieve T1_HIT-status", () => {
  const result = evaluate(setup(), completeCandles(new Map([[1, { high: 108 }]])));
  assert.equal(result.outcomeStatus, "T1_HIT");
  assert.equal(result.dataComplete, true);
});

test("ontbrekende candles en gaten blijven PENDING_DATA en leveren geen resultaat", () => {
  const complete = completeCandles();
  for (const [rows, reason] of [
    [complete.slice(1), "START_NOT_COVERED"],
    [complete.filter((_, index) => index !== 500), "CANDLE_GAP"],
    [complete.slice(0, -1), "END_NOT_COVERED"],
  ]) {
    const result = evaluate(setup(), rows);
    assert.equal(result.outcomeStatus, "PENDING_DATA");
    assert.equal(result.dataComplete, false);
    assert.equal(result.coverageReason, reason);
    assert.equal(result.resultR, null);
  }
});

test("een nog niet verstreken 24h-horizon blijft niet-definitief", () => {
  const result = evaluate(setup(), completeCandles(), { evaluatedAt: evaluatedAt - MINUTE });
  assert.equal(result.outcomeStatus, "PENDING_DATA");
  assert.equal(result.coverageReason, "HORIZON_NOT_COMPLETE");
});
