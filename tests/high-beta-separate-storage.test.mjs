import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("high-beta persistence uses separate tables", async () => {
  const source = await readFile(new URL("../server/high-beta-repository.js", import.meta.url), "utf8");
  assert.match(source, /public\.high_beta_setups/);
  assert.match(source, /public\.high_beta_outcomes/);
  assert.doesNotMatch(source, /INSERT INTO public\.trade_setups/);
});
