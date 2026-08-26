import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("setup lifecycle persists Momentum Acceptance trigger source", async () => {
  const source = await readFile(new URL("../js/setup-lifecycle.js", import.meta.url), "utf8");
  assert.match(source, /triggerSource/);
  assert.match(source, /momentumAcceptance/);
});
