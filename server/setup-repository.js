import { promotionTransition } from "../js/setup-lifecycle.js";
import { STRATEGY_VERSION } from "../js/strategy-config.js";

const activeStatuses = ["ACTIVE", "CHASE_BLOCKED", "MISSED_ENTRY"];

const value = (record, key) => record[key] ?? null;

export async function recordSetup(sql, record) {
  if (!record?.dedupeKey || !record?.lifecycleKey) throw new Error("Ongeldig setuprecord");
  const rows = await sql.query(`
    INSERT INTO trade_setups (
      created_at, last_seen_at, symbol, market, direction, score, initial_score,
      signal_tier, risk_class, trade_quality, confidence, setup_confidence, setup_type,
      entry_low, entry_high, reference_entry, stop_price, target_1, target_2,
      rr_target_1, rr_target_2, btc_regime, btc_opposing_prime, technical_trigger,
      trigger_confirmed, execution_score, liquidity_score, spread, slippage,
      orderbook_depth, open_interest, funding_rate, volume_24h, lifecycle_key,
      dedupe_key, strategy_version, status, metadata
    ) VALUES (
      $1,$1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37::jsonb
    )
    ON CONFLICT (dedupe_key) WHERE status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
    DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      score = EXCLUDED.score,
      trade_quality = EXCLUDED.trade_quality,
      confidence = EXCLUDED.confidence,
      setup_confidence = EXCLUDED.setup_confidence,
      execution_score = EXCLUDED.execution_score,
      liquidity_score = EXCLUDED.liquidity_score,
      spread = EXCLUDED.spread,
      slippage = EXCLUDED.slippage,
      orderbook_depth = EXCLUDED.orderbook_depth,
      open_interest = EXCLUDED.open_interest,
      funding_rate = EXCLUDED.funding_rate,
      volume_24h = EXCLUDED.volume_24h,
      status = EXCLUDED.status,
      metadata = EXCLUDED.metadata
    RETURNING *
  `, [
    record.createdAt, record.symbol, record.market, record.direction, record.score,
    record.signalTier, record.riskClass, record.tradeQuality, record.confidence,
    record.setupConfidence, record.setupType, record.entryLow, record.entryHigh,
    record.referenceEntry, record.stopPrice, record.target1, record.target2,
    record.rrTarget1, record.rrTarget2, record.btcRegime, record.btcOpposingPrime,
    record.technicalTrigger, record.triggerConfirmed, record.executionScore,
    record.liquidityScore, record.spread, record.slippage, record.orderbookDepth,
    record.openInterest, record.fundingRate, record.volume24h, record.lifecycleKey,
    record.dedupeKey, record.strategyVersion, record.status, JSON.stringify(record.metadata || {}),
  ]);
  const saved = rows[0];
  const previousRows = await sql.query(`
    SELECT * FROM trade_setups
    WHERE lifecycle_key = $1 AND id <> $2 AND signal_tier <> $3
      AND status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
    ORDER BY created_at DESC LIMIT 1
  `, [record.lifecycleKey, saved.id, record.signalTier]);
  const previous = previousRows[0];
  const transition = promotionTransition(previous ? {
    lifecycleKey: previous.lifecycle_key,
    signalTier: previous.signal_tier,
    score: previous.score,
  } : null, record, Date.parse(record.createdAt));
  if (previous && transition) {
    await sql.query(`UPDATE trade_setups SET status = 'PROMOTED', promoted_at = $2 WHERE id = $1`, [previous.id, transition.promotedAt]);
    await sql.query(`UPDATE trade_setups SET parent_setup_id = $2, previous_tier = $3, promoted_at = $4 WHERE id = $1`, [saved.id, previous.id, transition.previousTier, transition.promotedAt]);
    await sql.query(`
      INSERT INTO setup_transitions (setup_id, previous_setup_id, previous_tier, new_tier, previous_score, new_score, promoted_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (setup_id, previous_tier, new_tier) DO NOTHING
    `, [saved.id, previous.id, transition.previousTier, transition.newTier, transition.previousScore, transition.newScore, transition.promotedAt]);
  }
  return { setup: saved, transition };
}

export async function invalidateUnseenSetups(sql, { symbol, seenDedupeKeys = [], observedAt }) {
  return sql.query(`
    UPDATE trade_setups
    SET status = 'INVALIDATED', last_seen_at = $2
    WHERE symbol = $1
      AND strategy_version = $3
      AND status = ANY($4::text[])
      AND NOT (dedupe_key = ANY($5::text[]))
    RETURNING id, signal_tier, score
  `, [symbol, observedAt, STRATEGY_VERSION, activeStatuses, seenDedupeKeys]);
}

export async function saveMarketSnapshot(sql, { symbol, observedAt, lastPrice, openInterest, fundingRate, volume24h }) {
  const observedHour = new Date(Math.floor(Date.parse(observedAt) / 3_600_000) * 3_600_000).toISOString();
  await sql.query(`
    INSERT INTO strategy_market_snapshots (symbol, observed_hour, last_price, open_interest, funding_rate, volume_24h)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (symbol, observed_hour) DO UPDATE SET
      last_price = EXCLUDED.last_price,
      open_interest = EXCLUDED.open_interest,
      funding_rate = EXCLUDED.funding_rate,
      volume_24h = EXCLUDED.volume_24h
  `, [symbol, observedHour, lastPrice, openInterest, fundingRate, volume24h]);
}

export async function openInterestChange(sql, symbol, currentOpenInterest, observedAt) {
  const rows = await sql.query(`
    SELECT open_interest FROM strategy_market_snapshots
    WHERE symbol = $1 AND observed_hour <= $2::timestamptz - interval '1 hour'
    ORDER BY observed_hour DESC LIMIT 1
  `, [symbol, observedAt]);
  const previous = Number(rows[0]?.open_interest);
  const current = Number(currentOpenInterest);
  return previous > 0 && Number.isFinite(current) ? ((current - previous) / previous) * 100 : null;
}

export async function dueOutcomes(sql, now = Date.now(), limit = 25) {
  return sql.query(`
    SELECT s.* FROM trade_setups s
    LEFT JOIN setup_outcomes o ON o.setup_id = s.id AND o.evaluation_horizon = '24h'
    WHERE s.created_at <= $1::timestamptz - interval '24 hours'
      AND s.strategy_version = $2
      AND o.id IS NULL
    ORDER BY s.created_at ASC
    LIMIT $3
  `, [new Date(now).toISOString(), STRATEGY_VERSION, limit]);
}

export async function saveOutcome(sql, setupId, outcome) {
  return sql.query(`
    INSERT INTO setup_outcomes (
      setup_id, evaluation_horizon, evaluated_at, mfe_price, mae_price, mfe_pct, mae_pct,
      mfe_r, mae_r, t1_hit, t1_hit_at, t2_hit, t2_hit_at, stop_hit, stop_hit_at,
      close_price_24h, raw_result_r, split_result_r, result_r, outcome_status,
      ambiguous, ambiguity_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT (setup_id, evaluation_horizon) DO UPDATE SET
      evaluated_at = EXCLUDED.evaluated_at,
      mfe_price = EXCLUDED.mfe_price,
      mae_price = EXCLUDED.mae_price,
      mfe_pct = EXCLUDED.mfe_pct,
      mae_pct = EXCLUDED.mae_pct,
      mfe_r = EXCLUDED.mfe_r,
      mae_r = EXCLUDED.mae_r,
      t1_hit = EXCLUDED.t1_hit,
      t1_hit_at = EXCLUDED.t1_hit_at,
      t2_hit = EXCLUDED.t2_hit,
      t2_hit_at = EXCLUDED.t2_hit_at,
      stop_hit = EXCLUDED.stop_hit,
      stop_hit_at = EXCLUDED.stop_hit_at,
      close_price_24h = EXCLUDED.close_price_24h,
      raw_result_r = EXCLUDED.raw_result_r,
      split_result_r = EXCLUDED.split_result_r,
      result_r = EXCLUDED.result_r,
      outcome_status = EXCLUDED.outcome_status,
      ambiguous = EXCLUDED.ambiguous,
      ambiguity_reason = EXCLUDED.ambiguity_reason
    RETURNING *
  `, [
    setupId, outcome.evaluationHorizon, outcome.evaluatedAt, outcome.mfePrice,
    outcome.maePrice, outcome.mfePct, outcome.maePct, outcome.mfeR, outcome.maeR,
    outcome.t1Hit, outcome.t1HitAt, outcome.t2Hit, outcome.t2HitAt, outcome.stopHit,
    outcome.stopHitAt, outcome.closePrice24h, outcome.rawResultR, outcome.splitResultR,
    outcome.resultR, outcome.outcomeStatus, outcome.ambiguous, outcome.ambiguityReason,
  ]);
}

export async function analyticsRows(sql) {
  return sql.query(`
    SELECT
      s.signal_tier, s.score,
      o.result_r, o.split_result_r, o.raw_result_r,
      o.mfe_r, o.mae_r, o.t1_hit, o.t2_hit, o.stop_hit, o.ambiguous
    FROM trade_setups s
    LEFT JOIN setup_outcomes o ON o.setup_id = s.id AND o.evaluation_horizon = '24h'
    WHERE s.strategy_version = $1
    ORDER BY s.created_at DESC
  `, [STRATEGY_VERSION]);
}
