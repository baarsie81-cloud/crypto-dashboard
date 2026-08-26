import test from "node:test";
import assert from "node:assert/strict";
import { evaluateMomentumAcceptance } from "../js/relative-strength.js";
import { evaluateHighBetaMomentum } from "../js/high-beta.js";
import { classifySignal } from "../js/strategy-engine.js";

const HOUR = 60 * 60 * 1000;
const now = 100 * HOUR;

function breakoutCandles({ rising = true } = {}) {
  const rows = [];
  for (let index = 0; index < 28; index += 1) {
    const base = rising ? 98.8 + index * 0.002 : 101.2 - index * 0.002;
    rows.push({ start: (index + 1) * HOUR, open: base, high: rising ? 100 : 102, low: rising ? 98 : 100, close: base, volume: 100 });
  }
  if (rising) {
    rows.push({ start: 29 * HOUR, open: 99.8, high: 101.0, low: 99.5, close: 100.7, volume: 190 });
    rows.push({ start: 30 * HOUR, open: 100.7, high: 101.8, low: 100.5, close: 101.5, volume: 220 });
  } else {
    rows.push({ start: 29 * HOUR, open: 100.2, high: 100.5, low: 99.0, close: 99.3, volume: 190 });
    rows.push({ start: 30 * HOUR, open: 99.3, high: 99.5, low: 98.2, close: 98.5, volume: 220 });
  }
  return rows;
}

function flatBtcCandles() {
  return Array.from({ length: 30 }, (_, index) => ({
    start: (index + 1) * HOUR,
    open: 100,
    high: 100.2,
    low: 99.8,
    close: 100,
    volume: 1000,
  }));
}

test("Momentum Acceptance valideert een gesloten breakout met acceptance zonder retest", () => {
  const result = evaluateMomentumAcceptance({
    direction: "LONG",
    coinCandles: breakoutCandles(),
    atrValue: 1,
    volumeRatio: 1.8,
    openInterestChangePct: 2.5,
    fundingPctPerHour: 0.01,
    executionScore: 90,
    now,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.plan.type, "MOMENTUM_ACCEPTANCE");
  assert.equal(result.plan.confirmed, true);
  assert.ok(result.plan.rr2 >= 2.5);
});

test("Momentum Acceptance blokkeert overheating", () => {
  const result = evaluateMomentumAcceptance({
    direction: "LONG",
    coinCandles: breakoutCandles(),
    atrValue: 1,
    volumeRatio: 1.8,
    openInterestChangePct: 22,
    fundingPctPerHour: 0.06,
    executionScore: 90,
    now,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("explosief")));
  assert.ok(result.reasons.some((reason) => reason.includes("Funding")));
});

test("82-84 Opportunity kan via Momentum Acceptance promoveren terwijl klassieke plan onbevestigd blijft", () => {
  const momentum = evaluateMomentumAcceptance({
    direction: "LONG",
    coinCandles: breakoutCandles(),
    atrValue: 1,
    volumeRatio: 1.8,
    openInterestChangePct: 2,
    fundingPctPerHour: 0.01,
    executionScore: 90,
    now,
  });
  const signal = {
    symbol: "PF_TESTUSD", status: "WATCH", bias: "LONG", score: 83,
    tradeQuality: "A", confidence: 90, setupConfidence: 86, executionScore: 90,
    availability: true, fresh: true, postOnly: false, futuresContext: true, spreadPct: 0.03,
    adverseFunding: false, adversePremium: false, higherTimeframeConfirmed: true, dailyOpposes: false,
    marketRegime: "BULLISH", componentScores: { execution: 90 },
    plan: { type: "BREAKOUT_RETEST", entry: 100, entryLow: 99.8, entryHigh: 100, stop: 99, target1: 101.5, target2: 102.4, rr2: 2.4, confirmed: false, waitFor: "Wacht op retest" },
  };
  const classification = classifySignal(signal, {
    symbol: signal.symbol,
    currentPrice: momentum.plan.entry,
    momentumAcceptance: momentum,
  });
  assert.equal(classification.signalTier, "OPPORTUNITY");
  assert.equal(classification.triggerSource, "MOMENTUM_ACCEPTANCE");
  assert.equal(classification.riskClass, 0.25);
});

test("High-Beta lane accepteert een liquide Kraken momentum-breakout met 0.05R-profiel", () => {
  const result = evaluateHighBetaMomentum({
    symbol: "PF_TESTUSD",
    market: { symbol: "PF_TESTUSD", tradeable: true },
    ticker: {
      suspended: false, postOnly: false, bookValidated: true,
      spreadPct: 0.03, buySlippagePct: 0.02, sellSlippagePct: 0.02,
      validatedDepthUSD: 12000, fundingRatePrediction: 0.00005,
    },
    coinCandles: breakoutCandles(),
    btcCandles: flatBtcCandles(),
    openInterestChangePct: 3,
    now,
  });
  assert.equal(result.direction, "LONG");
  assert.ok(result.score >= 68);
  assert.equal(result.eligible, true);
  assert.equal(result.plan.type, "HIGH_BETA_MOMENTUM_ACCEPTANCE");
  assert.ok(result.plan.rr2 >= 2.0);
});

test("High-Beta lane weigert explosieve OI en slechte execution", () => {
  const result = evaluateHighBetaMomentum({
    symbol: "PF_TESTUSD",
    market: { symbol: "PF_TESTUSD", tradeable: true },
    ticker: {
      suspended: false, postOnly: false, bookValidated: true,
      spreadPct: 0.18, buySlippagePct: 0.15, sellSlippagePct: 0.14,
      validatedDepthUSD: 1500, fundingRatePrediction: 0.0007,
    },
    coinCandles: breakoutCandles(),
    btcCandles: flatBtcCandles(),
    openInterestChangePct: 25,
    now,
  });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.some((reason) => reason.includes("Open interest")));
  assert.ok(result.reasons.some((reason) => reason.includes("Spread") || reason.includes("Slippage") || reason.includes("Orderboek")));
});
