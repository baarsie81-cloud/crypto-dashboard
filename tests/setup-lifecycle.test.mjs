import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupRecord, promotionTransition, setupKeys } from "../js/setup-lifecycle.js";

test("dezelfde technische setup krijgt een deterministische dedupe key", () => {
  const input = { symbol: "PF_SOLUSD", direction: "LONG", setupType: "PULLBACK_SUPPORT", entryLow: 99, entryHigh: 101, stopPrice: 96, tickSize: 0.1, signalTier: "OPPORTUNITY" };
  assert.deepEqual(setupKeys(input), setupKeys({ ...input }));
  assert.notEqual(setupKeys(input).dedupeKey, setupKeys({ ...input, signalTier: "PRIME" }).dedupeKey);
  assert.equal(setupKeys(input).lifecycleKey, setupKeys({ ...input, signalTier: "PRIME" }).lifecycleKey);
});

test("82 Opportunity promoveert naar 86 PRIME zonder de vorige observatie te verliezen", () => {
  const previous = { lifecycleKey: "life", signalTier: "OPPORTUNITY", score: 82 };
  const next = { lifecycleKey: "life", signalTier: "PRIME", score: 86 };
  assert.deepEqual(promotionTransition(previous, next, 0), {
    previousTier: "OPPORTUNITY", newTier: "PRIME", previousScore: 82, newScore: 86, promotedAt: "1970-01-01T00:00:00.000Z",
  });
});

test("setuprecord bewaart risicoklasse, trigger en reproduceerbare marktcontext", () => {
  const record = buildSetupRecord({
    signal: { symbol: "PF_SOLUSD", score: 83, tradeQuality: "A", confidence: 80, setupConfidence: 82, executionScore: 80, spreadPct: 0.05, marketRegime: "BULLISH", componentScores: { execution: 80 } },
    classification: { signalTier: "OPPORTUNITY", riskClass: 0.25, direction: "LONG", status: "ACTIVE", strategyVersion: "prime-opportunity-shadow-v1", plan: { type: "PULLBACK_SUPPORT", entry: 100, entryLow: 99, entryHigh: 101, stop: 96, target1: 106, target2: 110, rr1: 1.5, rr2: 2.5, confirmed: true, waitFor: "trigger" }, reasons: [], gateReasons: [] },
    ticker: { openInterest: 10, fundingRatePrediction: 0.0001, volumeQuote: 1_000_000, buySlippagePct: 0.01, sellSlippagePct: 0.02, validatedDepthUSD: 50_000 },
    market: { symbol: "PF_SOLUSD", label: "SOL/USD Perp", tickSize: 0.1 }, observedAt: 0,
  });
  assert.equal(record.signalTier, "OPPORTUNITY");
  assert.equal(record.riskClass, 0.25);
  assert.equal(record.triggerConfirmed, true);
  assert.match(record.dedupeKey, /OPPORTUNITY$/);
});

test("ongeldige richting of prijsstructuur bereikt de database nooit", () => {
  const base = {
    signal: { symbol: "PF_SOLUSD", score: 80, tradeQuality: "A", confidence: 80, setupConfidence: 80 },
    classification: { signalTier: "SHADOW", riskClass: 0, direction: "NEUTRAAL", strategyVersion: "prime-opportunity-shadow-v1", plan: { type: "RESEARCH", entry: 100, entryLow: 99, entryHigh: 101, stop: 96, target1: 106, target2: 110 } },
    market: { symbol: "PF_SOLUSD", tickSize: 0.1 },
  };
  assert.equal(buildSetupRecord(base), null);
  assert.equal(buildSetupRecord({ ...base, classification: { ...base.classification, direction: "LONG", plan: { ...base.classification.plan, stop: 102 } } }), null);
});
