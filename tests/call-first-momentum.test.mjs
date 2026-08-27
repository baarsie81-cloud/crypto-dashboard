import test from "node:test";
import assert from "node:assert/strict";
import { classifySignal } from "../js/strategy-engine.js";

test("82+ non-PRIME kan via Momentum Acceptance OPPORTUNITY worden zonder volledige 4u-confirmatie", () => {
  const signal = {
    symbol: "PF_TESTUSD",
    status: "WATCH",
    bias: "LONG",
    score: 86,
    tradeQuality: "A",
    confidence: 80,
    setupConfidence: 84,
    executionScore: 82,
    availability: true,
    fresh: true,
    postOnly: false,
    futuresContext: true,
    spreadPct: 0.03,
    adverseFunding: false,
    adversePremium: false,
    higherTimeframeConfirmed: false,
    dailyOpposes: false,
    timeframeBias: { "240": "NEUTRAAL" },
    states: { "60": { close: 100 } },
    plan: null,
  };
  const momentumAcceptance = {
    eligible: true,
    plan: {
      confirmed: true,
      entryLow: 99.5,
      entryHigh: 100.5,
      entry: 100,
      stop: 98,
      target1: 102,
      target2: 104.5,
      rr2: 2.25,
      type: "MOMENTUM_ACCEPTANCE",
      waitFor: "Momentum bevestigd",
    },
  };
  const result = classifySignal(signal, {
    symbol: signal.symbol,
    currentPrice: 100,
    momentumAcceptance,
  });
  assert.equal(result.signalTier, "OPPORTUNITY");
  assert.equal(result.eligible, true);
  assert.equal(result.triggerSource, "MOMENTUM_ACCEPTANCE");
});

test("Momentum Acceptance wordt nog steeds geblokkeerd door tegengestelde 4u-trend", () => {
  const signal = {
    symbol: "PF_TESTUSD",
    status: "WATCH",
    bias: "LONG",
    score: 86,
    tradeQuality: "A",
    confidence: 80,
    setupConfidence: 84,
    executionScore: 82,
    availability: true,
    fresh: true,
    postOnly: false,
    futuresContext: true,
    spreadPct: 0.03,
    adverseFunding: false,
    adversePremium: false,
    higherTimeframeConfirmed: false,
    dailyOpposes: false,
    timeframeBias: { "240": "SHORT" },
    states: { "60": { close: 100 } },
    plan: null,
  };
  const momentumAcceptance = {
    eligible: true,
    plan: {
      confirmed: true,
      entryLow: 99.5,
      entryHigh: 100.5,
      entry: 100,
      stop: 98,
      target1: 102,
      target2: 104.5,
      rr2: 2.25,
      type: "MOMENTUM_ACCEPTANCE",
      waitFor: "Momentum bevestigd",
    },
  };
  const result = classifySignal(signal, {
    symbol: signal.symbol,
    currentPrice: 100,
    momentumAcceptance,
  });
  assert.equal(result.signalTier, "SHADOW");
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("4u-trend")));
});
