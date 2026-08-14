import test from "node:test";
import assert from "node:assert/strict";
import { summarizeStrategyRows } from "../js/strategy-analytics.js";

test("analytics houdt tiers en scorebanden strikt gescheiden", () => {
  const rows = [
    { signalTier: "PRIME", score: 86, resultR: 2, t1Hit: true, t2Hit: true, stopHit: false, mfeR: 3, maeR: -0.2 },
    { signalTier: "OPPORTUNITY", score: 83, resultR: -1, t1Hit: false, t2Hit: false, stopHit: true, mfeR: 0.4, maeR: -1 },
    { signalTier: "SHADOW", score: 83, resultR: 2, t1Hit: true, t2Hit: true, stopHit: false, mfeR: 2.2, maeR: -0.1 },
    { signalTier: "SHADOW", score: 80, resultR: 0.5, t1Hit: true, t2Hit: false, stopHit: false, mfeR: 1.6, maeR: -0.4 },
    { signalTier: "SHADOW", score: 78, resultR: null },
  ];
  const summary = summarizeStrategyRows(rows);
  assert.deepEqual(summary.tierCounts, { PRIME: 1, OPPORTUNITY: 1, SHADOW: 3 });
  assert.equal(summary.bands.find((band) => band.key === "82-84").sampleSize, 1);
  assert.equal(summary.bands.find((band) => band.key === "82-84").stopRate, 100);
  assert.equal(summary.bands.find((band) => band.key === "82-84-shadow").sampleSize, 1);
  assert.equal(summary.bands.find((band) => band.key === "82-84-shadow").winRate, 100);
  assert.equal(summary.bands.find((band) => band.key === "78-79").sampleSize, 0);
  assert.equal(summary.bands[0].sufficientSample, false);
});
