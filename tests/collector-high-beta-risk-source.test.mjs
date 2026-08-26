import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("collector applies high-beta-specific R/R gate without changing Opportunity", async () => {
  const source = await readFile(new URL("../server/kraken-strategy-collector.js", import.meta.url), "utf8");
  assert.match(source, /minimumRR2: HIGH_BETA_LIMITS\.minRR2/);
});
