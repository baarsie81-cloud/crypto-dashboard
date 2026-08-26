import test from "node:test";
import assert from "node:assert/strict";
import { buildPaperOrderFromAlert, paperOrderType, simulatePaperTrade } from "../js/paper-execution.js";

function alert(tier = "PRIME", overrides = {}) {
  return {
    tier,
    riskClass: tier === "PRIME" ? "1R" : tier === "OPPORTUNITY" ? "0.25R" : "0.05R",
    symbol: "PF_TESTUSD",
    market: "TEST/USD",
    direction: "LONG",
    entry: { low: 99.5, high: 100.5, reference: 100 },
    stop: 95,
    target1: 107.5,
    target2: 112.5,
    rrTarget2: 2.5,
    setupType: "MOMENTUM_ACCEPTANCE",
    triggerSource: "MOMENTUM_ACCEPTANCE",
    observedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

test("paper sizing volgt PRIME 1R, OPPORTUNITY 0.25R en HIGH_BETA 0.05R", () => {
  const prime = buildPaperOrderFromAlert(alert("PRIME"));
  const opportunity = buildPaperOrderFromAlert(alert("OPPORTUNITY"));
  const highBeta = buildPaperOrderFromAlert(alert("HIGH_BETA"));
  assert.equal(prime.riskBudgetUsd, 10);
  assert.equal(opportunity.riskBudgetUsd, 2.5);
  assert.equal(highBeta.riskBudgetUsd, 0.5);
  assert.ok(prime.positionQty > opportunity.positionQty);
  assert.ok(opportunity.positionQty > highBeta.positionQty);
  assert.ok(prime.notionalUsd <= 3000);
});

test("ordertype blijft deterministisch per trigger-lane", () => {
  assert.equal(paperOrderType(alert("PRIME")), "MARKET");
  assert.equal(paperOrderType(alert("OPPORTUNITY", { setupType: "BREAKOUT_RETEST", triggerSource: "CLASSIC" })), "LIMIT");
  assert.equal(paperOrderType(alert("HIGH_BETA", { setupType: "BREAKOUT_RETEST", triggerSource: "CLASSIC" })), "MARKET");
});

test("momentum/high-beta paper order gebruikt MARKET met fee en slippage", () => {
  const order = buildPaperOrderFromAlert(alert("PRIME"), { fallbackSlippagePct: 0.1 });
  assert.ok(order.fillPrice > 100);
  assert.ok(order.entryFeeUsd > 0);
  assert.ok(order.slippageUsd > 0);
  assert.equal(order.orderType, "MARKET");
  assert.equal(order.status, "OPEN");
});

test("klassieke trigger gebruikt LIMIT en telt pas gevuld na prijs-touch", () => {
  const order = buildPaperOrderFromAlert(alert("OPPORTUNITY", { setupType: "BREAKOUT_RETEST", triggerSource: "CLASSIC" }));
  assert.equal(order.orderType, "LIMIT");
  assert.equal(order.status, "PENDING");
  assert.equal(order.fillPrice, null);
  assert.equal(order.entryFeeUsd, 0);

  const trade = {
    id: "limit",
    status: "PENDING",
    direction: "LONG",
    reference_entry: order.referenceEntry,
    fill_price: null,
    fill_at: null,
    stop_price: order.stopPrice,
    target_1: order.target1,
    target_2: order.target2,
    position_qty: order.positionQty,
    actual_risk_usd: order.actualRiskUsd,
    fees_usd: 0,
    slippage_usd: 0,
    gross_result_usd: 0,
    t1_hit: false,t2_hit: false,stop_hit: false,
    payload: { paper: order },
  };
  const untouched = simulatePaperTrade(trade, [{ start: Date.parse("2026-08-26T12:01:00Z"), low: 101, high: 103, close: 102 }]);
  assert.equal(untouched.trade.status, "PENDING");
  const touched = simulatePaperTrade(trade, [{ start: Date.parse("2026-08-26T12:02:00Z"), low: 99.8, high: 101, close: 100.5 }]);
  assert.equal(touched.trade.status, "OPEN");
  assert.equal(touched.trade.fill_price, 100);
  assert.ok(touched.trade.fill_at);
  assert.deepEqual(touched.events.map((event) => event.eventType), ["FILLED"]);
});

test("bij candle die stop en target tegelijk raakt telt conservatief de stop eerst", () => {
  const order = buildPaperOrderFromAlert(alert("PRIME"));
  const trade = {
    id: "x",status: "OPEN",direction: "LONG",fill_price: order.fillPrice,
    stop_price: order.stopPrice,target_1: order.target1,target_2: order.target2,
    position_qty: order.positionQty,actual_risk_usd: order.actualRiskUsd,fees_usd: order.entryFeeUsd,
    slippage_usd: order.slippageUsd,gross_result_usd: 0,t1_hit: false,t2_hit: false,stop_hit: false,
    payload: { paper: order },
  };
  const result = simulatePaperTrade(trade, [{ start: Date.parse("2026-08-26T12:01:00Z"), low: 94, high: 114, close: 100 }]);
  assert.equal(result.trade.status, "CLOSED");
  assert.equal(result.trade.close_reason, "STOP");
  assert.equal(result.trade.stop_hit, true);
  assert.equal(result.trade.t1_hit, false);
  assert.ok(result.trade.result_r < 0);
});

test("TP1 sluit helft en TP2 sluit restant", () => {
  const order = buildPaperOrderFromAlert(alert("PRIME"));
  const trade = {
    id: "x",status: "OPEN",direction: "LONG",fill_price: order.fillPrice,
    stop_price: order.stopPrice,target_1: order.target1,target_2: order.target2,
    position_qty: order.positionQty,actual_risk_usd: order.actualRiskUsd,fees_usd: order.entryFeeUsd,
    slippage_usd: order.slippageUsd,gross_result_usd: 0,t1_hit: false,t2_hit: false,stop_hit: false,
    payload: { paper: order },
  };
  const candles = [
    { start: Date.parse("2026-08-26T12:01:00Z"), low: 99, high: 108, close: 107 },
    { start: Date.parse("2026-08-26T12:02:00Z"), low: 106, high: 113, close: 112 },
  ];
  const result = simulatePaperTrade(trade, candles);
  assert.equal(result.trade.status, "CLOSED");
  assert.equal(result.trade.t1_hit, true);
  assert.equal(result.trade.t2_hit, true);
  assert.equal(result.trade.stop_hit, false);
  assert.equal(result.trade.close_reason, "TP2");
  assert.ok(result.trade.result_r > 0);
  assert.deepEqual(result.events.map((event) => event.eventType), ["TP1", "TP2"]);
});
