import test from "node:test";
import assert from "node:assert/strict";
import { SIGNAL_LIMITS, TRADE_DEFAULTS } from "../js/constants.js";

test("UI safety defaults match the engine", () => {
  assert.equal(TRADE_DEFAULTS.riskPct, 1);
  assert.equal(TRADE_DEFAULTS.maximumRiskPct, 2);
  assert.equal(SIGNAL_LIMITS.defaultMaxLeverage, 3);
  assert.equal(SIGNAL_LIMITS.absoluteMaxLeverage, 4);
});
