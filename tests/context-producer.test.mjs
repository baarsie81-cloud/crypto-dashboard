import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("context producer is server-side and bounded",()=>{
  const source=fs.readFileSync(new URL("../api/context/[asset].js",import.meta.url),"utf8");
  assert.match(source,/ALLOWED/);
  assert.match(source,/macro: component\(0, 0/);
  assert.match(source,/etf: component\(0, 0/);
  assert.match(source,/expiresAt: generatedAt \+ 10 \* 60 \* 1000/);
  assert.match(source,/Alternative\.me/);
  assert.doesNotMatch(source,/OPENAI|API_KEY|secret/i);
});

test("decision runtime requests dynamic API context",()=>{
  const source=fs.readFileSync(new URL("../js/decision-ui-runtime.js",import.meta.url),"utf8");
  assert.match(source,/\/api\/context\//);
  assert.match(source,/5\*60\*1000/);
  assert.doesNotMatch(source,/\.\/context\/\$\{asset\.toLowerCase\(\)\}\.json/);
});
