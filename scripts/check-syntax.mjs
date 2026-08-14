import { readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const ignored = new Set([".git", "node_modules", ".playwright-cli", "output"]);

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    if (ignored.has(name)) return [];
    const path = resolve(directory, name);
    return statSync(path).isDirectory() ? files(path) : /\.(?:js|mjs)$/.test(name) ? [path] : [];
  });
}

const failures = [];
for (const file of files(root)) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) failures.push({ file, output: result.stderr || result.stdout });
}
if (failures.length) {
  failures.forEach(({ file, output }) => console.error(file, output));
  process.exitCode = 1;
} else {
  console.log("Syntaxcontrole geslaagd.");
}
