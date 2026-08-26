import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("high-beta migration creates separate tables without dropping existing strategy tables", async () => {
  const sql = await readFile(new URL("../migrations/0002_high_beta_momentum.sql", import.meta.url), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.high_beta_setups/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.high_beta_outcomes/);
  assert.doesNotMatch(sql, /DROP TABLE/i);
});
