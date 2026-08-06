import test from "node:test";
import assert from "node:assert/strict";
import { decisionCardModel, renderDecisionCard } from "../js/decision-ui.js";

const model = decisionCardModel({
  market: { symbol: "PF_XBTUSD", label: "BTC/USD Perp" },
  ticker: { lastPrice: 64000, bookValidated: true },
  signal: {
    longScore: 84, shortScore: 31, confidence: 79, setupConfidence: 82,
    marketRegime: "BULLISH", tradeQuality: "A", status: "WATCH", executionScore: 88,
    timeframeBias: { "60": "LONG", "240": "LONG", D: "NEUTRAAL" },
    structure: { nearestSupport: { low: 63000, high: 63200 }, nearestResistance: { low: 65000, high: 65200 } },
    plan: { type: "BREAKOUT_RETEST", entryLow: 65000, entryHigh: 65200, stop: 64500, target1: 66000, target2: 67000, rr2: 3.2, waitFor: "Wacht op breakout en retest." },
  },
});

test("decision model exposes separate long short confidence and horizons", () => {
  assert.equal(model.longScore, 84);
  assert.equal(model.shortScore, 31);
  assert.equal(model.confidence, 79);
  assert.equal(model.horizon24h, "Bullish");
  assert.equal(model.horizon30d, "Neutraal");
  assert.equal(model.bookValidated, true);
});

test("decision card renders setup levels and wait rule", () => {
  const html = renderDecisionCard(model);
  assert.match(html, /Long/);
  assert.match(html, /Short/);
  assert.match(html, /Confidence/);
  assert.match(html, /Steun/);
  assert.match(html, /Weerstand/);
  assert.match(html, /Wacht op breakout en retest/);
});
