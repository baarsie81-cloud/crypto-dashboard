import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("decision UI loader references existing module and stylesheet", async () => {
  const loader = await readFile(new URL("../decision-ui-loader.js", import.meta.url), "utf8");
  const css = await readFile(new URL("../styles-decision.css", import.meta.url), "utf8");
  const bootstrap = await readFile(new URL("../js/ui-bootstrap.js", import.meta.url), "utf8");
  assert.match(loader, /styles-decision\.css/);
  assert.match(loader, /ui-bootstrap\.js/);
  assert.match(css, /decision-card/);
  assert.match(bootstrap, /decision-ui-runtime/);
});
