import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { databaseConfigured, isAuthorizedCollector } from "../server/database.js";
import analyticsHandler from "../api/strategy/analytics.js";
import collectHandler from "../api/strategy/collect.js";

function responseRecorder() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    end(value) { this.body = String(value || ""); },
  };
}

test("Neon migration bevat setup, outcome, promotion, dedupe en kostenbewuste snapshots", async () => {
  const sql = await readFile(new URL("../migrations/0001_prime_opportunity_shadow_v1.sql", import.meta.url), "utf8");
  for (const expected of [
    "CREATE TABLE IF NOT EXISTS trade_setups",
    "CREATE TABLE IF NOT EXISTS setup_outcomes",
    "CREATE TABLE IF NOT EXISTS setup_transitions",
    "CREATE TABLE IF NOT EXISTS strategy_market_snapshots",
    "trade_setups_active_dedupe_unique",
    "raw_result_r",
    "split_result_r",
    "AMBIGUOUS",
    "strategy_version",
  ]) assert.match(sql, new RegExp(expected));
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test("collector vereist een server-side geheim en accepteert geen ontbrekende configuratie", () => {
  assert.equal(databaseConfigured({}), false);
  assert.equal(isAuthorizedCollector({ headers: {} }, { CRON_SECRET: "secret" }), false);
  assert.equal(isAuthorizedCollector({ headers: { authorization: "Bearer secret" } }, { CRON_SECRET: "secret" }), true);
});

test("collector onthult databaseconfiguratie niet zonder autorisatie", async () => {
  const previousDatabase = process.env.DATABASE_URL;
  const previousSecret = process.env.CRON_SECRET;
  delete process.env.DATABASE_URL;
  process.env.CRON_SECRET = "test-secret";
  try {
    const response = responseRecorder();
    await collectHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 401);
    assert.doesNotMatch(response.body, /DATABASE_URL/);
  } finally {
    if (previousDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabase;
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
  }
});

test("publieke analyticsroute lekt geen fout wanneer Neon nog niet is geconfigureerd", async () => {
  const previous = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    const response = responseRecorder();
    await analyticsHandler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.configured, false);
    assert.deepEqual(payload.tierCounts, { PRIME: 0, OPPORTUNITY: 0, SHADOW: 0 });
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  }
});
