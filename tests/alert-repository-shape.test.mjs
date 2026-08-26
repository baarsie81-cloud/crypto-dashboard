import test from "node:test";
import assert from "node:assert/strict";
import { buildAlertPayload, classifySignal } from "../js/strategy-engine.js";

const plan = { type: "MOMENTUM_ACCEPTANCE", entry: 100, entryLow: 99.8, entryHigh: 100.1, stop: 98, target1: 103, target2: 105.4, rr1: 1.5, rr2: 2.7, confirmed: true, waitFor: "Momentum Acceptance bevestigd" };

test("Opportunity alert exposes triggerSource for push rendering", () => {
  const signal = {
    symbol: "PF_TESTUSD", status: "WATCH", bias: "LONG", score: 83,
    tradeQuality: "A", confidence: 90, setupConfidence: 86, executionScore: 90,
    availability: true, fresh: true, postOnly: false, futuresContext: true, spreadPct: 0.03,
    adverseFunding: false, adversePremium: false, higherTimeframeConfirmed: true, dailyOpposes: false,
    marketRegime: "BULLISH", componentScores: { execution: 90 },
    plan: { ...plan, confirmed: false, type: "BREAKOUT_RETEST", rr2: 2.3 },
  };
  const momentumAcceptance = { eligible: true, plan, volumeRatio: 1.7, openInterestChangePct: 2, oiConfirmation: true, fundingPctPerHour: 0.01, breakoutClosed: true, acceptanceConfirmed: true, breakoutLevel: 99.8 };
  const classification = classifySignal(signal, { symbol: signal.symbol, currentPrice: 100, momentumAcceptance });
  const payload = buildAlertPayload({ signal, classification, market: { label: "TEST/USD Perp" } });
  assert.equal(payload.triggerSource, "MOMENTUM_ACCEPTANCE");
  assert.equal(payload.riskClass, "0.25R");
  assert.equal(payload.triggerConfirmed, true);
});
