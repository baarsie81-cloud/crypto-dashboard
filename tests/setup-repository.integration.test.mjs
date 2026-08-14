import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import {
  acquireCollectorRunLock,
  recordSetup,
  releaseCollectorRunLock,
} from "../server/setup-repository.js";

const connectionString = process.env.TEST_DATABASE_URL;

function setupRecord({ lifecycleKey, tier = "OPPORTUNITY", observedAt, suffix }) {
  const prime = tier === "PRIME";
  return {
    createdAt: observedAt,
    symbol: `PF_TEST_${suffix}`,
    market: `Fictieve testmarkt ${suffix}`,
    direction: "LONG",
    score: prime ? 86 : 82,
    signalTier: tier,
    riskClass: prime ? 1 : 0.25,
    tradeQuality: "TEST",
    confidence: 80,
    setupConfidence: 80,
    setupType: "INTEGRATION_TEST",
    entryLow: 99,
    entryHigh: 101,
    referenceEntry: 100,
    stopPrice: 95,
    target1: 107.5,
    target2: 112.5,
    rrTarget1: 1.5,
    rrTarget2: 2.5,
    btcRegime: "TEST",
    btcOpposingPrime: false,
    technicalTrigger: "TEST",
    triggerConfirmed: true,
    executionScore: 80,
    liquidityScore: 80,
    spread: 0.01,
    slippage: 0.01,
    orderbookDepth: 10_000,
    openInterest: 1_000,
    fundingRate: 0.0001,
    volume24h: 1_000_000,
    lifecycleKey,
    dedupeKey: `${lifecycleKey}:${tier}`,
    strategyVersion: "prime-opportunity-shadow-v1",
    status: "ACTIVE",
    metadata: { fixture: true, suffix },
  };
}

async function applyMigration(sql) {
  const source = await readFile(new URL("../migrations/0001_prime_opportunity_shadow_v1.sql", import.meta.url), "utf8");
  const statements = source
    .replace(/^\s*BEGIN\s*;/i, "")
    .replace(/COMMIT\s*;\s*$/i, "")
    .replace(/--.*$/gm, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await sql.transaction(statements.map((statement) => sql.query(statement)));
}

test("repository INSERT, rollback, lifecycle en collectorlock werken tegen echte Postgres", {
  skip: connectionString ? false : "TEST_DATABASE_URL ontbreekt; gebruik een tijdelijke Neon-branch",
  timeout: 60_000,
}, async () => {
  const sql = neon(connectionString);
  await applyMigration(sql);
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const prefix = `integration:${suffix}`;
  const firstAt = "2026-08-14T12:00:00.000Z";
  const secondAt = "2026-08-14T12:01:00.000Z";
  const triggerName = `fail_transition_${suffix}`;
  const functionName = `${triggerName}_fn`;

  try {
    const concurrent = setupRecord({ lifecycleKey: `${prefix}:concurrent`, observedAt: firstAt, suffix });
    const concurrentResults = await Promise.all([
      recordSetup(sql, concurrent),
      recordSetup(sql, concurrent),
    ]);
    assert.equal(concurrentResults[0].setup.id, concurrentResults[1].setup.id);
    const concurrentRows = await sql.query(`
      SELECT count(*)::int AS count FROM public.trade_setups WHERE dedupe_key = $1
    `, [concurrent.dedupeKey]);
    assert.equal(concurrentRows[0].count, 1);

    const lifecycleKey = `${prefix}:promotion`;
    const opportunity = await recordSetup(sql, setupRecord({ lifecycleKey, observedAt: firstAt, suffix }));
    const prime = await recordSetup(sql, setupRecord({ lifecycleKey, tier: "PRIME", observedAt: secondAt, suffix }));
    assert.equal(prime.transition.previousTier, "OPPORTUNITY");
    assert.equal(prime.transition.newTier, "PRIME");
    const lifecycleRows = await sql.query(`
      SELECT id, status, parent_setup_id, previous_tier
      FROM public.trade_setups WHERE lifecycle_key = $1 ORDER BY created_at
    `, [lifecycleKey]);
    assert.equal(lifecycleRows[0].id, opportunity.setup.id);
    assert.equal(lifecycleRows[0].status, "PROMOTED");
    assert.equal(lifecycleRows[1].parent_setup_id, lifecycleRows[0].id);
    assert.equal(lifecycleRows[1].previous_tier, "OPPORTUNITY");

    const rollbackKey = `${prefix}:rollback`;
    const rollbackPrevious = await recordSetup(sql, setupRecord({ lifecycleKey: rollbackKey, observedAt: firstAt, suffix }));
    await sql.query(`
      CREATE OR REPLACE FUNCTION public.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''forced transition failure''; END'
    `);
    await sql.query(`
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON public.setup_transitions
      FOR EACH ROW EXECUTE FUNCTION public.${functionName}()
    `);
    await assert.rejects(
      recordSetup(sql, setupRecord({ lifecycleKey: rollbackKey, tier: "PRIME", observedAt: secondAt, suffix })),
      /forced transition failure/,
    );
    const rollbackRows = await sql.query(`
      SELECT dedupe_key, status FROM public.trade_setups WHERE lifecycle_key = $1 ORDER BY created_at
    `, [rollbackKey]);
    assert.deepEqual(rollbackRows, [{ dedupe_key: `${rollbackKey}:OPPORTUNITY`, status: "ACTIVE" }]);
    assert.equal(rollbackPrevious.setup.status, "ACTIVE");
    await sql.query(`DROP TRIGGER ${triggerName} ON public.setup_transitions`);
    await sql.query(`DROP FUNCTION public.${functionName}()`);

    const firstOwner = `owner:${suffix}:1`;
    const secondOwner = `owner:${suffix}:2`;
    assert.equal(await acquireCollectorRunLock(sql, firstOwner), true);
    assert.equal(await acquireCollectorRunLock(sql, secondOwner), false);
    assert.equal(await releaseCollectorRunLock(sql, firstOwner), true);
    assert.equal(await acquireCollectorRunLock(sql, secondOwner), true);
    assert.equal(await releaseCollectorRunLock(sql, secondOwner), true);
  } finally {
    await sql.query(`DROP TRIGGER IF EXISTS ${triggerName} ON public.setup_transitions`);
    await sql.query(`DROP FUNCTION IF EXISTS public.${functionName}()`);
    await sql.query(`DELETE FROM public.trade_setups WHERE lifecycle_key LIKE $1`, [`${prefix}%`]);
    await sql.query(`DELETE FROM public.strategy_collector_locks WHERE owner_token LIKE $1`, [`owner:${suffix}:%`]);
  }
});
