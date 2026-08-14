import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SIGNAL_LIMITS, TRADE_DEFAULTS } from "../js/constants.js";
import { DEFAULT_STRATEGY_FLAGS, RISK_CLASSES } from "../js/strategy-config.js";

test("UI safety defaults match the engine", () => {
  assert.equal(TRADE_DEFAULTS.riskPct, 1);
  assert.equal(TRADE_DEFAULTS.maximumRiskPct, 2);
  assert.equal(SIGNAL_LIMITS.defaultMaxLeverage, 3);
  assert.equal(SIGNAL_LIMITS.absoluteMaxLeverage, 4);
});

test("new strategy layers retain explicit safety defaults", () => {
  assert.equal(RISK_CLASSES.PRIME, 1);
  assert.equal(RISK_CLASSES.OPPORTUNITY, 0.25);
  assert.equal(RISK_CLASSES.SHADOW, 0);
  assert.equal(DEFAULT_STRATEGY_FLAGS.opportunitySignalsEnabled, true);
  assert.equal(DEFAULT_STRATEGY_FLAGS.shadowTrackingEnabled, true);
});

test("dashboard copy distinguishes research from actionable tiers", async () => {
  const [html, runtime] = await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../js/decision-ui-runtime.js", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Crypto Strategy Decision Desk/);
  assert.match(html, /PRIME blijft 85\+/);
  assert.match(runtime, /Experimental \/ lower confidence than PRIME/);
  assert.match(runtime, /SHADOW RESEARCH · 0R · geen alert/);
});
