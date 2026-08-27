import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRelativeStrengthContinuation } from "../js/relative-strength.js";

const HOUR = 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 14, 12);
function candles({ breakout = true, coin = true } = {}) {
  const start = now - 32 * HOUR;
  return Array.from({ length: 30 }, (_, index) => {
    const base = coin ? 100 + index * 0.08 : 100 + index * 0.01;
    const jump = coin && breakout && index >= 28 ? 5 + (index - 28) : 0;
    const close = base + jump;
    return { start: start + index * HOUR, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 1000 };
  });
}
const context = (overrides = {}) => ({
  symbol: "PF_SOLUSD", direction: "LONG", coinCandles: candles(), btcCandles: candles({ coin: false }),
  atrValue: 1, volumeRatio: 1.8, openInterestChangePct: 1.2, fundingPctPerHour: 0.01,
  executionScore: 85, now, ...overrides,
});

test("Relative Strength Continuation vereist outperformance, volume, OI, funding en gesloten acceptatie", () => {
  const result = evaluateRelativeStrengthContinuation(context());
  assert.equal(result.eligible, true);
  assert.equal(result.plan.type, "RELATIVE_STRENGTH_CONTINUATION");
  assert.ok(result.plan.rr2 >= 2.0);
});

test("alleen sterke prijs zonder volume wordt geblokkeerd", () => {
  const result = evaluateRelativeStrengthContinuation(context({ volumeRatio: 1.1 }));
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("Volume")));
});

test("ontbrekende OI is optioneel maar ontbrekende funding nooit", () => {
  const withoutOi = evaluateRelativeStrengthContinuation(context({ openInterestChangePct: null }));
  assert.equal(withoutOi.oiConfirmation, null);
  assert.equal(withoutOi.reasons.some((reason) => reason.includes("Open interest")), false);
  const withoutFunding = evaluateRelativeStrengthContinuation(context({ fundingPctPerHour: null }));
  assert.equal(withoutFunding.eligible, false);
  assert.ok(withoutFunding.reasons.some((reason) => reason.includes("Fundingcontext")));
});

test("extreme funding, ontbrekende breakout-close en R/R onder 2.0 blokkeren", () => {
  assert.equal(evaluateRelativeStrengthContinuation(context({ fundingPctPerHour: 0.06 })).eligible, false);
  assert.equal(evaluateRelativeStrengthContinuation(context({ coinCandles: candles({ breakout: false }) })).eligible, false);
  assert.equal(evaluateRelativeStrengthContinuation(context({ targetRR2: 1.99 })).eligible, false);
});
