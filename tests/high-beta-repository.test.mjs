import test from "node:test";
import assert from "node:assert/strict";
import { highBetaDedupeKey } from "../server/high-beta-repository.js";

test("high-beta dedupe key is stable for same setup and changes by direction", () => {
  const base = { symbol: "PF_TESTUSD", setupType: "HIGH_BETA_MOMENTUM_ACCEPTANCE", breakoutLevel: 1.234, tickSize: 0.001 };
  const first = highBetaDedupeKey({ ...base, direction: "LONG" });
  const second = highBetaDedupeKey({ ...base, direction: "LONG" });
  const short = highBetaDedupeKey({ ...base, direction: "SHORT" });
  assert.equal(first, second);
  assert.notEqual(first, short);
});
