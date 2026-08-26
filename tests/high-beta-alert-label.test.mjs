import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("high-beta call keeps its own explicit push header", async () => {
  const source = await readFile(new URL("../server/kraken-strategy-collector.js", import.meta.url), "utf8");
  assert.match(source, /⚡ HIGH-BETA MOMENTUM CALL/);
  assert.match(source, /riskClass: "0\.05R"/);
});
