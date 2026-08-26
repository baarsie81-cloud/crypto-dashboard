import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHighBetaRows } from "../js/strategy-analytics.js";

test("high-beta analytics counts only eligible evaluated setups for expectancy", () => {
  const summary = summarizeHighBetaRows([
    { eligible: true, result_r: 1.2, split_result_r: 1.2, mfe_r: 2, mae_r: -0.4, t1_hit: true, t2_hit: false, stop_hit: false, ambiguous: false },
    { eligible: false, result_r: -1, split_result_r: -1, mfe_r: 0.3, mae_r: -1, t1_hit: false, t2_hit: false, stop_hit: true, ambiguous: false },
  ]);
  assert.equal(summary.setupCount, 2);
  assert.equal(summary.eligibleSetupCount, 1);
  assert.equal(summary.eligibleSampleSize, 1);
  assert.equal(summary.expectancyR, 1.2);
});
