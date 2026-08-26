import test from "node:test";
import assert from "node:assert/strict";
import { RISK_CLASSES } from "../js/strategy-config.js";

test("high-beta risk class remains 0.05R", () => {
  assert.equal(RISK_CLASSES.HIGH_BETA, 0.05);
});
