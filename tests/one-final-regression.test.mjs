import test from "node:test";
import assert from "node:assert/strict";
import { HIGH_BETA_STRATEGY_VERSION, STRATEGY_VERSION } from "../js/strategy-config.js";

test("standard and high-beta strategy versions remain separately identifiable", () => {
  assert.notEqual(STRATEGY_VERSION, HIGH_BETA_STRATEGY_VERSION);
});
