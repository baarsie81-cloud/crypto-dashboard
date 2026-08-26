import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("env example contains enabled Momentum Acceptance and High-Beta flags", async () => {
  const source = await readFile(new URL("../.env.example", import.meta.url), "utf8");
  assert.match(source, /MOMENTUM_ACCEPTANCE_ENABLED=true/);
  assert.match(source, /HIGH_BETA_SIGNALS_ENABLED=true/);
  assert.match(source, /HIGH_BETA_SCAN_LIMIT=20/);
});
