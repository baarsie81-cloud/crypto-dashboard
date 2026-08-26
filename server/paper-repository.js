import { buildPaperOrderFromAlert, PAPER_EXECUTION_VERSION } from "../js/paper-execution.js";

export async function createPaperTradeFromAlert(sql, { sourceAlertKey, alert, createdAt } = {}) {
  const order = buildPaperOrderFromAlert(alert);
  if (!sourceAlertKey || !order) return null;
  const payload = { alert, paper: order };
  const rows = await sql.query(`
    INSERT INTO public.paper_trades (
      source_alert_key,created_at,updated_at,last_evaluated_at,symbol,market,lane,direction,
      risk_class,virtual_equity_eur,base_risk_pct,risk_budget_eur,actual_risk_eur,order_type,status,
      entry_low,entry_high,reference_entry,fill_price,fill_at,stop_price,target_1,target_2,rr_target_2,
      position_qty,notional_eur,fees_eur,slippage_eur,paper_version,payload
    ) VALUES (
      $1,$2,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'OPEN',$13,$14,$15,$16,$2,$17,$18,$19,$20,
      $21,$22,$23,$24,$25,$26::jsonb
    )
    ON CONFLICT(source_alert_key) DO NOTHING
    RETURNING *
  `, [
    sourceAlertKey,
    createdAt || alert.observedAt || new Date().toISOString(),
    alert.symbol,
    alert.market || alert.symbol,
    order.lane,
    order.direction,
    order.riskClass,
    order.virtualEquityEur,
    order.baseRiskPct,
    order.riskBudgetEur,
    order.actualRiskEur,
    order.orderType,
    order.entryLow,
    order.entryHigh,
    order.referenceEntry,
    order.fillPrice,
    order.stopPrice,
    order.target1,
    order.target2,
    order.rrTarget2,
    order.positionQty,
    order.notionalEur,
    order.entryFeeEur,
    order.slippageEur,
    PAPER_EXECUTION_VERSION,
    JSON.stringify(payload),
  ]);
  const trade = rows[0] || null;
  if (!trade) return null;
  await sql.query(`
    INSERT INTO public.paper_trade_events (paper_trade_id,event_at,event_type,price,quantity,details)
    VALUES
      ($1,$2,'ORDER_PLACED',$3,$4,$5::jsonb),
      ($1,$2,'FILLED',$6,$4,$7::jsonb)
  `, [
    trade.id,
    trade.created_at,
    trade.reference_entry,
    trade.position_qty,
    JSON.stringify({ orderType: trade.order_type, riskBudgetEur: Number(trade.risk_budget_eur), lane: trade.lane }),
    trade.fill_price,
    JSON.stringify({ modeledSlippagePct: order.modeledSlippagePct, entryFeeEur: order.entryFeeEur }),
  ]);
  return trade;
}

export async function listOpenPaperTrades(sql, limit = 12) {
  return sql.query(`
    SELECT * FROM public.paper_trades
    WHERE status='OPEN'
    ORDER BY last_evaluated_at ASC NULLS FIRST, created_at ASC
    LIMIT $1
  `, [limit]);
}

export async function updatePaperTrade(sql, trade, events = [], evaluatedAt = new Date().toISOString()) {
  const rows = await sql.query(`
    UPDATE public.paper_trades SET
      updated_at=$2,last_evaluated_at=$2,status=$3,t1_hit=$4,t2_hit=$5,stop_hit=$6,
      close_price=$7,closed_at=$8,close_reason=$9,gross_result_eur=$10,fees_eur=$11,
      slippage_eur=$12,net_result_eur=$13,result_r=$14
    WHERE id=$1 RETURNING *
  `, [
    trade.id,evaluatedAt,trade.status,trade.t1_hit===true,trade.t2_hit===true,trade.stop_hit===true,
    trade.close_price,trade.closed_at,trade.close_reason,trade.gross_result_eur,trade.fees_eur,
    trade.slippage_eur,trade.net_result_eur,trade.result_r,
  ]);
  for (const event of events) {
    await sql.query(`
      INSERT INTO public.paper_trade_events (paper_trade_id,event_at,event_type,price,quantity,details)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [trade.id,event.eventAt,event.eventType,event.price ?? null,event.quantity ?? null,JSON.stringify(event.details || {})]);
  }
  return rows[0] || null;
}

export async function paperAnalyticsRows(sql) {
  return sql.query(`
    SELECT lane,status,result_r,net_result_eur,fees_eur,slippage_eur,actual_risk_eur,
           t1_hit,t2_hit,stop_hit,created_at,closed_at
    FROM public.paper_trades
    ORDER BY created_at DESC
  `);
}

export async function recentPaperOrders(sql, sinceMinutes = 70, limit = 20) {
  return sql.query(`
    SELECT * FROM public.paper_trades
    WHERE created_at >= now() - make_interval(mins => $1)
    ORDER BY created_at DESC LIMIT $2
  `, [sinceMinutes, limit]);
}
