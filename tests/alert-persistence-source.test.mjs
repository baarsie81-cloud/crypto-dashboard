import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("collector persists core and high-beta alerts with dedupe keys", async () => {
  const source = await readFile(new URL("../server/kraken-strategy-collector.js", import.meta.url), "utf8");
  assert.match(source, /alertKey: `core:\$\{setup\.dedupe_key\}`/);
  assert.match(source, /alertKey: `high-beta:\$\{dedupeKey\}`/);
});
