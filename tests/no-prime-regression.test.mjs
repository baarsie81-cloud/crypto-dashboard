import test from "node:test";
import assert from "node:assert/strict";
import { RISK_CLASSES, STRATEGY_LIMITS } from "../js/strategy-config.js";

test("PRIME risk stays unchanged while Opportunity uses the approved 2.0R floor", () => {
  assert.equal(RISK_CLASSES.PRIME, 1);
  assert.equal(RISK_CLASSES.OPPORTUNITY, 0.25);
  assert.equal(STRATEGY_LIMITS.opportunityMinScore, 82);
  assert.equal(STRATEGY_LIMITS.opportunityMaxScore, 84);
  assert.equal(STRATEGY_LIMITS.opportunityMinRR2, 2.0);
});
