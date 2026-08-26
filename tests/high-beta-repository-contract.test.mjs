import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const source = fs.readFileSync(new URL("../server/high-beta-repository.js", import.meta.url), "utf8");

test("high-beta INSERT heeft evenveel doelkolommen als VALUES expressies", () => {
  const match = source.match(/INSERT INTO public\.high_beta_setups \(([\s\S]*?)\) VALUES \(([\s\S]*?)\)\s*ON CONFLICT/);
  assert.ok(match, "high-beta INSERT niet gevonden");
  const columns = match[1].split(",").map((v) => v.trim()).filter(Boolean);
  const values = match[2].split(",").map((v) => v.trim()).filter(Boolean);
  assert.equal(values.length, columns.length, `kolommen=${columns.length}, values=${values.length}`);
  const placeholders = [...match[2].matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  assert.equal(Math.max(...placeholders), 35, "recordHighBetaSetup verwacht exact 35 parameters");
});
