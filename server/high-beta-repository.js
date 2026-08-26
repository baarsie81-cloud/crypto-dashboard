const activeStatuses = ["WATCH", "ACTIVE", "CHASE_BLOCKED"];

function numberOrNull(value) {
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function highBetaDedupeKey({ symbol, direction, setupType, breakoutLevel, tickSize } = {}) {
  const step = Number(tickSize) > 0 ? Number(tickSize) : 1e-8;
  const bucket = Number.isFinite(Number(breakoutLevel)) ? Math.round(Number(breakoutLevel) / step) : "na";
  return `high-beta:${symbol}:${direction}:${setupType}:${bucket}`;
}

export async function recordHighBetaSetup(sql, record) {
  if (!record?.dedupeKey || !record?.plan) throw new Error("Ongeldig high-beta setuprecord");
  const plan = record.plan;
  const metrics = record.metrics || {};
  const rows = await sql.query(`
    INSERT INTO public.high_beta_setups (
      created_at,last_seen_at,symbol,market,direction,score,risk_class,trade_quality,
      confidence,setup_confidence,setup_type,entry_low,entry_high,reference_entry,
      stop_price,target_1,target_2,rr_target_1,rr_target_2,execution_score,spread,
      slippage,orderbook_depth,momentum_1h_pct,momentum_4h_pct,volume_ratio,
      open_interest_change_pct,funding_pct_per_hour,relative_1h_pct,relative_4h_pct,
      breakout_level,eligible,status,reasons,metadata,dedupe_key,strategy_version
    ) VALUES (
      $1,$1,$2,$3,$4,$5,0.05,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33::jsonb,$34::jsonb,$35,$36
    )
    ON CONFLICT (dedupe_key) WHERE status IN ('WATCH','ACTIVE','CHASE_BLOCKED')
    DO UPDATE SET
      last_seen_at=EXCLUDED.last_seen_at,
      score=EXCLUDED.score,
      trade_quality=EXCLUDED.trade_quality,
      confidence=EXCLUDED.confidence,
      setup_confidence=EXCLUDED.setup_confidence,
      execution_score=EXCLUDED.execution_score,
      spread=EXCLUDED.spread,
      slippage=EXCLUDED.slippage,
      orderbook_depth=EXCLUDED.orderbook_depth,
      momentum_1h_pct=EXCLUDED.momentum_1h_pct,
      momentum_4h_pct=EXCLUDED.momentum_4h_pct,
      volume_ratio=EXCLUDED.volume_ratio,
      open_interest_change_pct=EXCLUDED.open_interest_change_pct,
      funding_pct_per_hour=EXCLUDED.funding_pct_per_hour,
      relative_1h_pct=EXCLUDED.relative_1h_pct,
      relative_4h_pct=EXCLUDED.relative_4h_pct,
      eligible=EXCLUDED.eligible,
      status=EXCLUDED.status,
      reasons=EXCLUDED.reasons,
      metadata=EXCLUDED.metadata
    RETURNING *
  `, [
    record.observedAt, record.symbol, record.market, record.direction, record.score,
    record.tradeQuality, record.confidence, record.setupConfidence, plan.type,
    plan.entryLow, plan.entryHigh, plan.entry, plan.stop, plan.target1, plan.target2,
    plan.rr1, plan.rr2, record.executionScore, numberOrNull(metrics.spreadPct),
    numberOrNull(metrics.slippagePct), numberOrNull(metrics.orderbookDepthUSD),
    numberOrNull(metrics.momentum1hPct), numberOrNull(metrics.momentum4hPct),
    numberOrNull(metrics.volumeRatio), numberOrNull(metrics.openInterestChangePct),
    numberOrNull(metrics.fundingPctPerHour), numberOrNull(metrics.relative1hPct),
    numberOrNull(metrics.relative4hPct), numberOrNull(metrics.breakoutLevel),
    record.eligible === true, record.status, JSON.stringify(record.reasons || []),
    JSON.stringify(record.metadata || {}), record.dedupeKey, record.strategyVersion,
  ]);
  return rows[0];
}

export async function invalidateUnseenHighBetaSetups(sql, { symbol, seenDedupeKeys = [], observedAt, strategyVersion }) {
  return sql.query(`
    UPDATE public.high_beta_setups
    SET status='INVALIDATED', invalidated_at=$2
    WHERE symbol=$1 AND strategy_version=$3
      AND status=ANY($4::text[])
      AND NOT (dedupe_key=ANY($5::text[]))
    RETURNING id,score,status
  `, [symbol, observedAt, strategyVersion, activeStatuses, seenDedupeKeys]);
}

export async function dueHighBetaOutcomes(sql, now = Date.now(), limit = 3) {
  return sql.query(`
    SELECT s.* FROM public.high_beta_setups s
    LEFT JOIN public.high_beta_outcomes o ON o.setup_id=s.id AND o.evaluation_horizon='24h'
    WHERE s.created_at <= $1::timestamptz - interval '24 hours'
      AND o.id IS NULL
    ORDER BY s.created_at ASC
    LIMIT $2
  `, [new Date(now).toISOString(), limit]);
}

export async function saveHighBetaOutcome(sql, setupId, outcome) {
  if (outcome?.dataComplete !== true || ["OPEN", "PENDING_DATA", "INCOMPLETE"].includes(outcome?.outcomeStatus)) return null;
  const rows = await sql.query(`
    INSERT INTO public.high_beta_outcomes (
      setup_id,evaluation_horizon,evaluated_at,mfe_price,mae_price,mfe_pct,mae_pct,
      mfe_r,mae_r,t1_hit,t1_hit_at,t2_hit,t2_hit_at,stop_hit,stop_hit_at,
      close_price_24h,raw_result_r,split_result_r,result_r,outcome_status,ambiguous,ambiguity_reason
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    ON CONFLICT(setup_id,evaluation_horizon) DO UPDATE SET
      evaluated_at=EXCLUDED.evaluated_at,mfe_price=EXCLUDED.mfe_price,mae_price=EXCLUDED.mae_price,
      mfe_pct=EXCLUDED.mfe_pct,mae_pct=EXCLUDED.mae_pct,mfe_r=EXCLUDED.mfe_r,mae_r=EXCLUDED.mae_r,
      t1_hit=EXCLUDED.t1_hit,t1_hit_at=EXCLUDED.t1_hit_at,t2_hit=EXCLUDED.t2_hit,t2_hit_at=EXCLUDED.t2_hit_at,
      stop_hit=EXCLUDED.stop_hit,stop_hit_at=EXCLUDED.stop_hit_at,close_price_24h=EXCLUDED.close_price_24h,
      raw_result_r=EXCLUDED.raw_result_r,split_result_r=EXCLUDED.split_result_r,result_r=EXCLUDED.result_r,
      outcome_status=EXCLUDED.outcome_status,ambiguous=EXCLUDED.ambiguous,ambiguity_reason=EXCLUDED.ambiguity_reason
    RETURNING *
  `, [
    setupId,outcome.evaluationHorizon,outcome.evaluatedAt,outcome.mfePrice,outcome.maePrice,
    outcome.mfePct,outcome.maePct,outcome.mfeR,outcome.maeR,outcome.t1Hit,outcome.t1HitAt,
    outcome.t2Hit,outcome.t2HitAt,outcome.stopHit,outcome.stopHitAt,outcome.closePrice24h,
    outcome.rawResultR,outcome.splitResultR,outcome.resultR,outcome.outcomeStatus,
    outcome.ambiguous,outcome.ambiguityReason,
  ]);
  return rows[0];
}

export async function highBetaAnalyticsRows(sql) {
  return sql.query(`
    SELECT s.score,s.eligible,s.trade_quality,s.setup_type,
      o.result_r,o.split_result_r,o.mfe_r,o.mae_r,o.t1_hit,o.t2_hit,o.stop_hit,o.ambiguous
    FROM public.high_beta_setups s
    LEFT JOIN public.high_beta_outcomes o ON o.setup_id=s.id AND o.evaluation_horizon='24h'
    ORDER BY s.created_at DESC
  `);
}
