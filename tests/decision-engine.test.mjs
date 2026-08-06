import test from "node:test";
import assert from "node:assert/strict";
import { buildStructureSetup } from "../js/market-structure.js";
import { suggestedLeverage } from "../js/signals.js";

test("high score does not unlock high leverage", () => {
  assert.equal(suggestedLeverage({ score: 99, setupConfidence: 99, entry: 100, stop: 99, maxLeverage: 10, atrPct: 1 }), 3);
});

test("long directly below resistance waits for breakout and retest", () => {
  const structure = { nearestSupport: { low: 90, high: 92 }, nearestResistance: { low: 100.4, high: 101 } };
  const setup = buildStructureSetup({ bias: "LONG", price: 100, atrValue: 1, structure, volumeRatio: 1 });
  assert.equal(setup.type, "BREAKOUT_RETEST");
  assert.equal(setup.confirmed, false);
  assert.match(setup.waitFor, /close boven/i);
});

test("short directly above support waits for breakdown and retest", () => {
  const structure = { nearestSupport: { low: 99, high: 99.6 }, nearestResistance: { low: 108, high: 110 } };
  const setup = buildStructureSetup({ bias: "SHORT", price: 100, atrValue: 1, structure, volumeRatio: 1 });
  assert.equal(setup.type, "BREAKDOWN_RETEST");
  assert.equal(setup.confirmed, false);
});
