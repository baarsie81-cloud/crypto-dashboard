import test from "node:test";
import assert from "node:assert/strict";
import { strategyFlags } from "../js/strategy-config.js";

test("Momentum Acceptance and High-Beta are enabled by default and can be disabled explicitly", () => {
  assert.equal(strategyFlags({}).momentumAcceptanceEnabled, true);
  assert.equal(strategyFlags({}).highBetaSignalsEnabled, true);
  const disabled = strategyFlags({ MOMENTUM_ACCEPTANCE_ENABLED: "false", HIGH_BETA_SIGNALS_ENABLED: "0" });
  assert.equal(disabled.momentumAcceptanceEnabled, false);
  assert.equal(disabled.highBetaSignalsEnabled, false);
});
