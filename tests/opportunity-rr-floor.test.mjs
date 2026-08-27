import test from "node:test";
import assert from "node:assert/strict";
import { STRATEGY_LIMITS, RISK_CLASSES } from "../js/strategy-config.js";
import { HIGH_BETA_LIMITS } from "../js/high-beta.js";

test("OPPORTUNITY gebruikt minimum R/R 2.0", () => {
  assert.equal(STRATEGY_LIMITS.opportunityMinRR2, 2.0);
  assert.equal(RISK_CLASSES.OPPORTUNITY, 0.25);
});

test("HIGH_BETA blijft ongewijzigd op 2.0R en 0.05R", () => {
  assert.equal(HIGH_BETA_LIMITS.minRR2, 2.0);
  assert.equal(RISK_CLASSES.HIGH_BETA, 0.05);
});

test("OPPORTUNITY is fallback voor iedere score vanaf 82 die PRIME niet haalt", () => {
  assert.equal(STRATEGY_LIMITS.opportunityMinScore, 82);
  assert.equal(STRATEGY_LIMITS.opportunityMaxScore, 100);
});
