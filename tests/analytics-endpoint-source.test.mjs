import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("analytics endpoint exposes separate high-beta summary", async () => {
  const source = await readFile(new URL("../api/strategy/analytics.js", import.meta.url), "utf8");
  assert.match(source, /highBeta:/);
  assert.match(source, /HIGH_BETA_STRATEGY_VERSION/);
});
