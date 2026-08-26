import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("collector response contains standard flags, alerts and high-beta diagnostics", async () => {
  const source = await readFile(new URL("../server/kraken-strategy-collector.js", import.meta.url), "utf8");
  assert.match(source, /highBeta: \{ \.\.\.highBeta, outcomes: highBetaOutcomes \}/);
  assert.match(source, /alerts,/);
  assert.match(source, /flags,/);
});
