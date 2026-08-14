import { STRATEGY_VERSION } from "../js/strategy-config.js";

const activeStatuses = ["ACTIVE", "CHASE_BLOCKED", "MISSED_ENTRY"];

export async function recordSetup(sql, record) {
  if (!record?.dedupeKey || !record?.lifecycleKey) throw new Error("Ongeldig setuprecord");
  if (typeof sql?.transaction !== "function") throw new Error("Databaseclient ondersteunt geen transacties");
  const parameters = [
    record.createdAt, record.symbol, record.market, record.direction, record.score,
    record.signalTier, record.riskClass, record.tradeQuality, record.confidence,
    record.setupConfidence, record.setupType, record.entryLow, record.entryHigh,
    record.referenceEntry, record.stopPrice, record.target1, record.target2,
    record.rrTarget1, record.rrTarget2, record.btcRegime, record.btcOpposingPrime,
    record.technicalTrigger, record.triggerConfirmed, record.executionScore,
    record.liquidityScore, record.spread, record.slippage, record.orderbookDepth,
    record.openInterest, record.fundingRate, record.volume24h, record.lifecycleKey,
    record.dedupeKey, record.strategyVersion, record.status, JSON.stringify(record.metadata || {}),
  ];
  const results = await sql.transaction((transaction) => [
    transaction.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [record.lifecycleKey]),
    transaction.query(`
    INSERT INTO public.trade_setups (
      created_at, last_seen_at, symbol, market, direction, score, initial_score,
      signal_tier, risk_class, trade_quality, confidence, setup_confidence, setup_type,
      entry_low, entry_high, reference_entry, stop_price, target_1, target_2,
      rr_target_1, rr_target_2, btc_regime, btc_opposing_prime, technical_trigger,
      trigger_confirmed, execution_score, liquidity_score, spread, slippage,
      orderbook_depth, open_interest, funding_rate, volume_24h, lifecycle_key,
      dedupe_key, strategy_version, status, metadata
    ) VALUES (
      $1,$1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
      $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36::jsonb
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
    `, parameters),
    transaction.query(`
      WITH current_setup AS MATERIALIZED (
        SELECT * FROM public.trade_setups
        WHERE dedupe_key = $2 AND status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
        LIMIT 1
      ), previous_setup AS MATERIALIZED (
        SELECT previous.*
        FROM public.trade_setups previous
        CROSS JOIN current_setup current
        WHERE previous.lifecycle_key = $1
          AND previous.id <> current.id
          AND previous.status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
          AND CASE current.signal_tier WHEN 'SHADOW' THEN 1 WHEN 'OPPORTUNITY' THEN 2 WHEN 'PRIME' THEN 3 END
            > CASE previous.signal_tier WHEN 'SHADOW' THEN 1 WHEN 'OPPORTUNITY' THEN 2 WHEN 'PRIME' THEN 3 END
        ORDER BY previous.created_at DESC
        LIMIT 1
        FOR UPDATE
      )
      UPDATE public.trade_setups previous
      SET status = 'PROMOTED', promoted_at = $3
      FROM previous_setup candidate
      WHERE previous.id = candidate.id
      RETURNING previous.*
    `, [record.lifecycleKey, record.dedupeKey, record.createdAt]),
    transaction.query(`
      WITH current_setup AS MATERIALIZED (
        SELECT * FROM public.trade_setups
        WHERE dedupe_key = $2 AND status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
        LIMIT 1
      ), previous_setup AS MATERIALIZED (
        SELECT previous.*
        FROM public.trade_setups previous
        CROSS JOIN current_setup current
        WHERE previous.lifecycle_key = $1
          AND previous.status = 'PROMOTED'
          AND previous.promoted_at = $3
          AND CASE current.signal_tier WHEN 'SHADOW' THEN 1 WHEN 'OPPORTUNITY' THEN 2 WHEN 'PRIME' THEN 3 END
            > CASE previous.signal_tier WHEN 'SHADOW' THEN 1 WHEN 'OPPORTUNITY' THEN 2 WHEN 'PRIME' THEN 3 END
        ORDER BY previous.created_at DESC
        LIMIT 1
      )
      UPDATE public.trade_setups current
      SET parent_setup_id = previous.id,
          previous_tier = previous.signal_tier,
          promoted_at = $3
      FROM previous_setup previous
      WHERE current.id = (SELECT id FROM current_setup)
      RETURNING current.*
    `, [record.lifecycleKey, record.dedupeKey, record.createdAt]),
    transaction.query(`
      INSERT INTO public.setup_transitions (
        setup_id, previous_setup_id, previous_tier, new_tier,
        previous_score, new_score, promoted_at
      )
      SELECT current.id, previous.id, previous.signal_tier, current.signal_tier,
             previous.score, current.score, $2
      FROM public.trade_setups current
      JOIN public.trade_setups previous ON previous.id = current.parent_setup_id
      WHERE current.dedupe_key = $1 AND current.promoted_at = $2
      ON CONFLICT (setup_id, previous_tier, new_tier) DO NOTHING
      RETURNING *
    `, [record.dedupeKey, record.createdAt]),
    transaction.query(`
      SELECT * FROM public.trade_setups
      WHERE dedupe_key = $1 AND status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY')
      LIMIT 1
    `, [record.dedupeKey]),
    transaction.query(`
      SELECT transition.*
      FROM public.setup_transitions transition
      JOIN public.trade_setups setup ON setup.id = transition.setup_id
      WHERE setup.dedupe_key = $1 AND transition.promoted_at = $2
      LIMIT 1
    `, [record.dedupeKey, record.createdAt]),
  ]);
  const saved = results[5]?.[0];
  if (!saved) throw new Error("Setup kon niet atomair worden opgeslagen");
  const transitionRow = results[6]?.[0];
  const transition = transitionRow ? {
    previousTier: transitionRow.previous_tier,
    newTier: transitionRow.new_tier,
    previousScore: Number(transitionRow.previous_score),
    newScore: Number(transitionRow.new_score),
    promotedAt: new Date(transitionRow.promoted_at).toISOString(),
  } : null;
  return { setup: saved, transition };
}

export async function acquireCollectorRunLock(sql, ownerToken, ttlSeconds = 120) {
  const rows = await sql.query(`
    INSERT INTO public.strategy_collector_locks (lock_name, owner_token, acquired_at, expires_at)
    VALUES ('strategy-collector', $1, now(), now() + make_interval(secs => $2))
    ON CONFLICT (lock_name) DO UPDATE SET
      owner_token = EXCLUDED.owner_token,
      acquired_at = EXCLUDED.acquired_at,
      expires_at = EXCLUDED.expires_at
    WHERE public.strategy_collector_locks.expires_at <= now()
       OR public.strategy_collector_locks.owner_token = EXCLUDED.owner_token
    RETURNING owner_token
  `, [ownerToken, ttlSeconds]);
  return rows[0]?.owner_token === ownerToken;
}

export async function releaseCollectorRunLock(sql, ownerToken) {
  const rows = await sql.query(`
    DELETE FROM public.strategy_collector_locks
    WHERE lock_name = 'strategy-collector' AND owner_token = $1
    RETURNING lock_name
  `, [ownerToken]);
  return rows.length === 1;
}

export async function invalidateUnseenSetups(sql, { symbol, seenDedupeKeys = [], observedAt }) {
  return sql.query(`
    UPDATE public.trade_setups
    SET status = 'INVALIDATED', invalidated_at = $2
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
    INSERT INTO public.strategy_market_snapshots (symbol, observed_hour, last_price, open_interest, funding_rate, volume_24h)
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
    SELECT open_interest FROM public.strategy_market_snapshots
    WHERE symbol = $1 AND observed_hour <= $2::timestamptz - interval '1 hour'
    ORDER BY observed_hour DESC LIMIT 1
  `, [symbol, observedAt]);
  const previous = Number(rows[0]?.open_interest);
  const current = Number(currentOpenInterest);
  return previous > 0 && Number.isFinite(current) ? ((current - previous) / previous) * 100 : null;
}

export async function dueOutcomes(sql, now = Date.now(), limit = 25) {
  return sql.query(`
    SELECT s.* FROM public.trade_setups s
    LEFT JOIN public.setup_outcomes o ON o.setup_id = s.id AND o.evaluation_horizon = '24h'
    WHERE s.created_at <= $1::timestamptz - interval '24 hours'
      AND s.strategy_version = $2
      AND o.id IS NULL
    ORDER BY s.created_at ASC
    LIMIT $3
  `, [new Date(now).toISOString(), STRATEGY_VERSION, limit]);
}

export async function saveOutcome(sql, setupId, outcome) {
  if (outcome?.dataComplete !== true || ["OPEN", "PENDING_DATA", "INCOMPLETE"].includes(outcome?.outcomeStatus)) {
    throw new Error("Onvolledige 24-uursuitkomst wordt niet opgeslagen");
  }
  return sql.query(`
    INSERT INTO public.setup_outcomes (
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
    FROM public.trade_setups s
    LEFT JOIN public.setup_outcomes o ON o.setup_id = s.id AND o.evaluation_horizon = '24h'
    WHERE s.strategy_version = $1
    ORDER BY s.created_at DESC
  `, [STRATEGY_VERSION]);
}
