import test from "node:test";
import assert from "node:assert/strict";
import { buildPaperOrderFromAlert, simulatePaperTrade } from "../js/paper-execution.js";

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
    observedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

test("paper sizing volgt PRIME 1R, OPPORTUNITY 0.25R en HIGH_BETA 0.05R", () => {
  const prime = buildPaperOrderFromAlert(alert("PRIME"), { fallbackSlippagePct: 0.05 });
  const opportunity = buildPaperOrderFromAlert(alert("OPPORTUNITY"), { fallbackSlippagePct: 0.05 });
  const highBeta = buildPaperOrderFromAlert(alert("HIGH_BETA"), { fallbackSlippagePct: 0.05 });
  assert.equal(prime.riskBudgetUsd, 10);
  assert.equal(opportunity.riskBudgetUsd, 2.5);
  assert.equal(highBeta.riskBudgetUsd, 0.5);
  assert.ok(prime.positionQty > opportunity.positionQty);
  assert.ok(opportunity.positionQty > highBeta.positionQty);
  assert.ok(prime.notionalUsd <= 3000);
});

test("paper market order rekent entry fee en slippage mee", () => {
  const order = buildPaperOrderFromAlert(alert("PRIME"), { fallbackSlippagePct: 0.1, takerFeeRate: 0.0005 });
  assert.ok(order.fillPrice > 100);
  assert.ok(order.entryFeeUsd > 0);
  assert.ok(order.slippageUsd > 0);
  assert.equal(order.orderType, "MARKET");
});

test("bij candle die stop en target tegelijk raakt telt conservatief de stop eerst", () => {
  const order = buildPaperOrderFromAlert(alert("PRIME"), { fallbackSlippagePct: 0.05 });
  const trade = {
    id: "x",
    status: "OPEN",
    direction: "LONG",
    fill_price: order.fillPrice,
    stop_price: order.stopPrice,
    target_1: order.target1,
    target_2: order.target2,
    position_qty: order.positionQty,
    actual_risk_usd: order.actualRiskUsd,
    fees_usd: order.entryFeeUsd,
    slippage_usd: order.slippageUsd,
    gross_result_usd: 0,
    t1_hit: false,
    t2_hit: false,
    stop_hit: false,
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
  const order = buildPaperOrderFromAlert(alert("PRIME"), { fallbackSlippagePct: 0.05 });
  const trade = {
    id: "x",
    status: "OPEN",
    direction: "LONG",
    fill_price: order.fillPrice,
    stop_price: order.stopPrice,
    target_1: order.target1,
    target_2: order.target2,
    position_qty: order.positionQty,
    actual_risk_usd: order.actualRiskUsd,
    fees_usd: order.entryFeeUsd,
    slippage_usd: order.slippageUsd,
    gross_result_usd: 0,
    t1_hit: false,
    t2_hit: false,
    stop_hit: false,
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
