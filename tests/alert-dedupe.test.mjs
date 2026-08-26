import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("sent alerts use ON CONFLICT dedupe", async () => {
  const source = await readFile(new URL("../server/alert-repository.js", import.meta.url), "utf8");
  assert.match(source, /ON CONFLICT\(alert_key\) DO NOTHING/);
});
