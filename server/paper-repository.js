import { buildPaperOrderFromAlert, PAPER_EXECUTION_VERSION } from "../js/paper-execution.js";

export async function createPaperTradeFromAlert(sql, { sourceAlertKey, alert, createdAt } = {}) {
  const order = buildPaperOrderFromAlert(alert);
  if (!sourceAlertKey || !order) return null;
  const payload = { alert, paper: order };
  const created = createdAt || alert.observedAt || new Date().toISOString();
  const rows = await sql.query(`
    INSERT INTO public.paper_trades (
      source_alert_key,created_at,updated_at,last_evaluated_at,symbol,market,lane,direction,
      risk_class,virtual_equity_usd,base_risk_pct,risk_budget_usd,actual_risk_usd,order_type,status,
      entry_low,entry_high,reference_entry,fill_price,fill_at,stop_price,target_1,target_2,rr_target_2,
      position_qty,notional_usd,fees_usd,slippage_usd,paper_version,payload
    ) VALUES (
      $1,$2,$2,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
      $23,$24,$25,$26,$27,$28::jsonb
    )
    ON CONFLICT(source_alert_key) DO NOTHING
    RETURNING *
  `, [
    sourceAlertKey, created, alert.symbol, alert.market || alert.symbol, order.lane, order.direction,
    order.riskClass, order.virtualEquityUsd, order.baseRiskPct, order.riskBudgetUsd, order.actualRiskUsd,
    order.orderType, order.status, order.entryLow, order.entryHigh, order.referenceEntry,
    order.fillPrice, order.status === "OPEN" ? created : null, order.stopPrice, order.target1, order.target2,
    order.rrTarget2, order.positionQty, order.notionalUsd, order.entryFeeUsd, order.slippageUsd,
    PAPER_EXECUTION_VERSION, JSON.stringify(payload),
  ]);
  const trade = rows[0] || null;
  if (!trade) return null;

  await sql.query(`
    INSERT INTO public.paper_trade_events (paper_trade_id,event_at,event_type,price,quantity,details)
    VALUES ($1,$2,'ORDER_PLACED',$3,$4,$5::jsonb)
  `, [
    trade.id, trade.created_at, trade.reference_entry, trade.position_qty,
    JSON.stringify({ orderType: trade.order_type, riskBudgetUsd: Number(trade.risk_budget_usd), lane: trade.lane }),
  ]);
  if (trade.status === "OPEN") {
    await sql.query(`
      INSERT INTO public.paper_trade_events (paper_trade_id,event_at,event_type,price,quantity,details)
      VALUES ($1,$2,'FILLED',$3,$4,$5::jsonb)
    `, [
      trade.id, trade.created_at, trade.fill_price, trade.position_qty,
      JSON.stringify({ modeledSlippagePct: order.modeledSlippagePct, entryFeeUsd: order.entryFeeUsd, orderType: "MARKET" }),
    ]);
  }
  return trade;
}

export async function listOpenPaperTrades(sql, limit = 12) {
  return sql.query(`
    SELECT * FROM public.paper_trades
    WHERE status IN ('PENDING','OPEN')
    ORDER BY last_evaluated_at ASC NULLS FIRST, created_at ASC
    LIMIT $1
  `, [limit]);
}

export async function updatePaperTrade(sql, trade, events = [], evaluatedAt = new Date().toISOString()) {
  const t1Event = events.find((event) => event.eventType === 'TP1');
  const t2Event = events.find((event) => event.eventType === 'TP2');
  const stopEvent = events.find((event) => event.eventType === 'STOP');
  const rows = await sql.query(`
    UPDATE public.paper_trades SET
      updated_at=$2,last_evaluated_at=$2,status=$3,fill_price=$4,fill_at=$5,
      t1_hit=$6,t2_hit=$7,stop_hit=$8,
      t1_hit_at=COALESCE(t1_hit_at,$17),t2_hit_at=COALESCE(t2_hit_at,$18),stop_hit_at=COALESCE(stop_hit_at,$19),
      close_price=$9,closed_at=$10,close_reason=$11,gross_result_usd=$12,fees_usd=$13,
      slippage_usd=$14,net_result_usd=$15,result_r=$16
    WHERE id=$1 RETURNING *
  `, [
    trade.id,evaluatedAt,trade.status,trade.fill_price ?? null,trade.fill_at ?? null,
    trade.t1_hit===true,trade.t2_hit===true,trade.stop_hit===true,
    trade.close_price,trade.closed_at,trade.close_reason,trade.gross_result_usd,trade.fees_usd,
    trade.slippage_usd,trade.net_result_usd,trade.result_r,
    t1Event?.eventAt || null,t2Event?.eventAt || null,stopEvent?.eventAt || null,
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
    SELECT lane,status,result_r,net_result_usd,fees_usd,slippage_usd,actual_risk_usd,
           t1_hit,t2_hit,stop_hit,created_at,closed_at,order_type
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
