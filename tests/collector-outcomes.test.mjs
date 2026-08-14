import test from "node:test";
import assert from "node:assert/strict";
import { evaluateDueStrategyOutcomes } from "../server/kraken-strategy-collector.js";

const MINUTE = 60 * 1000;
const createdAt = Date.UTC(2026, 7, 14, 0);
const now = createdAt + 24 * 60 * MINUTE;
const dueSetup = {
  id: "00000000-0000-4000-8000-000000000001",
  created_at: new Date(createdAt).toISOString(),
  symbol: "PF_TESTUSD",
  direction: "LONG",
  reference_entry: 100,
  stop_price: 95,
  target_1: 107.5,
  target_2: 112.5,
};

const candles = () => Array.from({ length: 24 * 60 }, (_, minute) => ({
  time: createdAt + minute * MINUTE,
  open: "100",
  high: "101",
  low: "99",
  close: "100",
  volume: "1",
}));

function databaseRecorder() {
  const saved = [];
  return {
    saved,
    async query(query, parameters) {
      if (query.includes("SELECT s.* FROM public.trade_setups")) return [dueSetup];
      if (query.includes("INSERT INTO public.setup_outcomes")) {
        saved.push(parameters);
        return [{ id: "outcome-1" }];
      }
      throw new Error(`Onverwachte testquery: ${query}`);
    },
  };
}

const responseWith = (rows) => async () => ({
  ok: true,
  async json() { return { candles: rows }; },
});

test("collectorflow bewaart geen outcome als Kraken een candle-gap bevat", async () => {
  const sql = databaseRecorder();
  const incomplete = candles().filter((_, index) => index !== 500);
  const results = await evaluateDueStrategyOutcomes({ sql, fetchImpl: responseWith(incomplete), now });
  assert.equal(results[0].status, "PENDING_DATA");
  assert.equal(sql.saved.length, 0);
});

test("collectorflow bewaart een 24h-outcome alleen bij volledige candledekking", async () => {
  const sql = databaseRecorder();
  const results = await evaluateDueStrategyOutcomes({ sql, fetchImpl: responseWith(candles()), now });
  assert.equal(results[0].status, "EXPIRED");
  assert.equal(sql.saved.length, 1);
  assert.equal(sql.saved[0][1], "24h");
  assert.equal(sql.saved[0][19], "EXPIRED");
});
