import test from "node:test";
import assert from "node:assert/strict";
import { ceilToStep, contractNotionalUSD, createManualTradePlan, floorToStep, roundTradePrice } from "../js/trade-planner.js";

const market = { symbol: "PF_XBTUSD", label: "BTC/USD Perp", base: "BTC", tickSize: 0.1, qtyStep: 0.001, minQty: 0.001, maxPositionSize: 100, maxLeverage: 10, contractSize: 0.1, tradeable: true, postOnly: false };
const ticker = { fundingRate: 0, fundingRatePrediction: 0, premiumPct: 0, suspended: false, postOnly: false, bookValidated: true, buySlippagePct: 0.01, sellSlippagePct: 0.01, validatedDepthUSD: 100_000 };

function signal(overrides = {}) {
  return {
    symbol: "PF_XBTUSD", status: "LONG", score: 88, longScore: 88, shortScore: 30,
    confidence: 82, setupConfidence: 86, tradeQuality: "A", executionScore: 88,
    fresh: true, availability: true, postOnly: false, futuresContext: true,
    adverseFunding: false, adversePremium: false, spreadPct: 0.02,
    timeframeBias: { "60": "LONG", "240": "LONG", D: "LONG" },
    plan: { entry: 100.09, entryLow: 99.8, entryHigh: 100.2, stop: 98.09, target1: 104.09, target2: 106.09, leverage: 3, confirmed: true },
    ...overrides,
  };
}

const planFor = (value = signal(), overrides = {}) => createManualTradePlan({ market, signal: value, ticker, eurUsd: 1.15, budgetEUR: 100, accountEquityEUR: 10_000, riskPct: 1, maxLeverage: 3, ...overrides });

test("notional verwerkt contract multiplier", () => {
  assert.equal(contractNotionalUSD({ contractSize: 0.1 }, 5, 100), 50);
});

test("long en short stops worden directioneel veilig afgerond", () => {
  assert.equal(roundTradePrice(98.09, 0.1, { direction: "LONG", role: "stop" }), 98);
  assert.equal(roundTradePrice(102.01, 0.1, { direction: "SHORT", role: "stop" }), 102.1);
  assert.equal(floorToStep(100.09, 0.1), 100);
  assert.equal(ceilToStep(100.01, 0.1), 100.1);
});

test("positie blijft binnen 1 procent account-risico inclusief execution costs", () => {
  const plan = planFor();
  assert.equal(plan.eligible, true);
  assert.equal(plan.riskBudgetEUR, 100);
  assert.ok(plan.maxPlannedLossEUR <= 100);
  assert.ok(plan.leverage <= 3);
});

test("meer dan 2 procent risico wordt geblokkeerd", () => {
  const plan = planFor(signal(), { riskPct: 2.5 });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /2%/);
});

test("ontbrekend gevalideerd orderboek blokkeert ordervoorbereiding", () => {
  const plan = planFor(signal(), { ticker: { ...ticker, bookValidated: false } });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /orderboek/i);
});

test("B-setup of onbevestigde setup wordt niet voorbereid", () => {
  assert.equal(planFor(signal({ tradeQuality: "B" })).eligible, false);
  assert.equal(planFor(signal({ plan: { ...signal().plan, confirmed: false, waitFor: "Wacht op retest" } })).eligible, false);
});

test("positie groter dan gevalideerde boekdiepte wordt geblokkeerd", () => {
  const shallow = { ...ticker, validatedDepthUSD: 10 };
  const plan = planFor(signal(), { ticker: shallow });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /orderboekdiepte/i);
});
