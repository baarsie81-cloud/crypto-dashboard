import test from "node:test";
import assert from "node:assert/strict";
import { passes85TradeGate } from "../js/trade-universe.js";
import { buildAlertPayload, classifySignal } from "../js/strategy-engine.js";

const plan = { type: "PULLBACK_SUPPORT", entry: 100, entryLow: 99, entryHigh: 101, stop: 96, target1: 106, target2: 110, rr1: 1.5, rr2: 2.5, confirmed: true, waitFor: "Trigger bevestigd" };
const signal = (overrides = {}) => ({
  symbol: "PF_XBTUSD", status: "LONG", bias: "LONG", score: 82, longScore: 82, shortScore: 24,
  tradeQuality: "A-", confidence: 75, setupConfidence: 80, executionScore: 75,
  availability: true, fresh: true, postOnly: false, futuresContext: true, spreadPct: 0.05,
  adverseFunding: false, adversePremium: false, higherTimeframeConfirmed: true, dailyOpposes: false,
  marketRegime: "BULLISH", plan, componentScores: { execution: 75 },
  ...overrides,
});

test("PRIME regression: bestaande core- en altcoinfixtures houden exact dezelfde gate-uitkomst", () => {
  const fixtures = [
    [signal({ score: 85, tradeQuality: "A", symbol: "PF_XBTUSD" }), true],
    [signal({ score: 84, tradeQuality: "A", symbol: "PF_XBTUSD" }), false],
    [signal({ score: 90, tradeQuality: "A+", symbol: "PF_SOLUSD", confidence: 79, setupConfidence: 90, executionScore: 90, plan: { ...plan, rr2: 3 } }), false],
    [signal({ score: 90, tradeQuality: "A+", symbol: "PF_SOLUSD", confidence: 80, setupConfidence: 85, executionScore: 85, plan: { ...plan, rr2: 2.5 } }), true],
  ];
  for (const [fixture, expected] of fixtures) {
    assert.equal(passes85TradeGate(fixture, { symbol: fixture.symbol }).eligible, expected);
    assert.equal(classifySignal(fixture, { symbol: fixture.symbol, currentPrice: 100 }).signalTier === "PRIME", expected);
  }
});

test("OPPORTUNITY accepteert alleen 82-84 en 85 blijft PRIME", () => {
  assert.equal(classifySignal(signal({ score: 82 }), { currentPrice: 100 }).signalTier, "OPPORTUNITY");
  assert.equal(classifySignal(signal({ score: 84 }), { currentPrice: 100 }).signalTier, "OPPORTUNITY");
  assert.equal(classifySignal(signal({ score: 81 }), { currentPrice: 100 }).signalTier, "SHADOW");
  assert.equal(classifySignal(signal({ score: 85, tradeQuality: "A" }), { currentPrice: 100 }).signalTier, "PRIME");
});

test("OPPORTUNITY grensgates degraderen naar SHADOW", () => {
  const blocked = [
    signal({ tradeQuality: "B+" }),
    signal({ confidence: 74 }),
    signal({ setupConfidence: 79 }),
    signal({ plan: { ...plan, rr2: 2.49, target2: 109.96 } }),
    signal({ executionScore: 74 }),
    signal({ spreadPct: null }),
  ];
  blocked.forEach((fixture) => assert.equal(classifySignal(fixture, { currentPrice: 100 }).signalTier, "SHADOW"));
  assert.equal(classifySignal(signal({ plan: { ...plan, rr2: 2.5 } }), { currentPrice: 100 }).signalTier, "OPPORTUNITY");
});

test("tegengestelde BTC PRIME en een gechasede entry blokkeren Opportunity", () => {
  const alt = signal({ symbol: "PF_SOLUSD", score: 83, confidence: 82, setupConfidence: 85, executionScore: 85 });
  const btc = signal({ symbol: "PF_XBTUSD", status: "SHORT", bias: "SHORT", score: 88, tradeQuality: "A", plan: { ...plan, stop: 104, target1: 94, target2: 90 } });
  const opposed = classifySignal(alt, { symbol: alt.symbol, btcSignal: btc, currentPrice: 100 });
  assert.equal(opposed.signalTier, "SHADOW");
  assert.ok(opposed.reasons.some((reason) => reason.includes("BTC")));
  const chased = classifySignal(alt, { symbol: alt.symbol, currentPrice: 104 });
  assert.equal(chased.signalTier, "SHADOW");
  assert.equal(chased.status, "CHASE_BLOCKED");
});

test("SHADOW verstuurt nooit een normale alert en Opportunity wel met 0.25R", () => {
  assert.equal(classifySignal(signal({ score: 78 }), { currentPrice: 100 }).signalTier, "SHADOW");
  assert.equal(classifySignal(signal({ score: 81 }), { currentPrice: 100 }).signalTier, "SHADOW");
  const shadow = classifySignal(signal({ score: 80 }), { currentPrice: 100 });
  assert.equal(shadow.signalTier, "SHADOW");
  assert.equal(shadow.riskClass, 0);
  assert.equal(buildAlertPayload({ signal: signal({ score: 80 }), classification: shadow }), null);
  const opportunity = classifySignal(signal(), { currentPrice: 100 });
  const payload = buildAlertPayload({ signal: signal(), classification: opportunity, market: { label: "BTC/USD Perp" } });
  assert.equal(payload.tier, "OPPORTUNITY");
  assert.equal(payload.riskClass, "0.25R");
  assert.ok(payload.notPrimeBecause.some((reason) => reason.includes("85")));
});

test("feature flags houden Opportunity en Shadow onafhankelijk", () => {
  const noOpportunity = classifySignal(signal(), { currentPrice: 100, flags: { opportunitySignalsEnabled: false, shadowTrackingEnabled: true } });
  assert.equal(noOpportunity.signalTier, "SHADOW");
  const disabled = classifySignal(signal(), { currentPrice: 100, flags: { opportunitySignalsEnabled: false, shadowTrackingEnabled: false } });
  assert.equal(disabled.signalTier, null);
});
