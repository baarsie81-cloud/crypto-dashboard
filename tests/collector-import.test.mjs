import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("collector wires Momentum Acceptance, high-beta persistence and alert persistence", async () => {
  const source = await readFile(new URL("../server/kraken-strategy-collector.js", import.meta.url), "utf8");
  assert.match(source, /evaluateMomentumAcceptance/);
  assert.match(source, /collectHighBetaLane/);
  assert.match(source, /recordSentTradeAlert/);
  assert.match(source, /recordHighBetaSetup/);
});
