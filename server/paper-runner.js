import { normalizeCandle } from "../js/kraken.js";
import { PAPER_DEFAULTS, simulatePaperTrade } from "../js/paper-execution.js";
import { createPaperTradeFromAlert, listOpenPaperTrades, updatePaperTrade } from "./paper-repository.js";

const KRAKEN_BASE = "https://futures.kraken.com";
const MINUTE = 60 * 1000;
const HORIZON = 24 * 60 * 60 * 1000;

async function fetchJson(path, { fetchImpl = fetch, parameters = {}, timeout = 12_000 } = {}) {
  const url = new URL(path, KRAKEN_BASE);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "crypto-dashboard-paper-runner/1.0" } });
    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function backfillMissingPaperTrades(sql, limit = 10) {
  const rows = await sql.query(`
    SELECT a.alert_key,a.payload,a.sent_at
    FROM public.sent_trade_alerts a
    LEFT JOIN public.paper_trades p ON p.source_alert_key=a.alert_key
    WHERE p.id IS NULL
      AND COALESCE(a.payload->>'tier','') IN ('PRIME','OPPORTUNITY','HIGH_BETA')
    ORDER BY a.sent_at ASC
    LIMIT $1
  `, [limit]);
  const created = [];
  for (const row of rows) {
    const trade = await createPaperTradeFromAlert(sql, {
      sourceAlertKey: row.alert_key,
      alert: row.payload,
      createdAt: row.sent_at,
    });
    if (trade) created.push({ id: trade.id, sourceAlertKey: row.alert_key, symbol: trade.symbol, lane: trade.lane });
  }
  return created;
}

async function fetchOneMinuteCandles(symbol, fromMs, toMs, fetchImpl) {
  if (!(toMs > fromMs)) return [];
  const payload = await fetchJson(`/api/charts/v1/trade/${symbol}/1m`, {
    fetchImpl,
    parameters: {
      from: Math.floor(fromMs / 1000),
      to: Math.ceil(toMs / 1000),
    },
  });
  return (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start);
}

function applyExitSlippage(price, direction, pct) {
  const factor = pct / 100;
  return direction === "LONG" ? price * (1 - factor) : price * (1 + factor);
}

function pnl(direction, entry, exit, qty) {
  return direction === "LONG" ? (exit - entry) * qty : (entry - exit) * qty;
}

function closeAtHorizon(trade, candles, horizonAt) {
  if (trade.status !== "OPEN" || !candles.length) return { trade, event: null };
  const finalCandle = [...candles].reverse().find((candle) => Number(candle.start) <= horizonAt) || candles.at(-1);
  const rawExit = Number(finalCandle.close);
  if (!(rawExit > 0)) return { trade, event: null };
  const payloadPaper = trade.payload?.paper || {};
  const slipPct = Number(payloadPaper.modeledSlippagePct ?? PAPER_DEFAULTS.fallbackSlippagePct);
  const feeRate = Number(payloadPaper.takerFeeRate ?? PAPER_DEFAULTS.takerFeeRate);
  const exit = applyExitSlippage(rawExit, trade.direction, slipPct);
  const totalQty = Number(trade.position_qty);
  const remainingQty = trade.t1_hit ? totalQty * (1 - PAPER_DEFAULTS.tp1Fraction) : totalQty;
  const gross = Number(trade.gross_result_usd || 0) + pnl(trade.direction, Number(trade.fill_price), exit, remainingQty);
  const fees = Number(trade.fees_usd || 0) + Math.abs(exit * remainingQty) * feeRate;
  const slippage = Number(trade.slippage_usd || 0) + Math.abs(exit - rawExit) * remainingQty;
  const net = gross - fees;
  const risk = Number(trade.actual_risk_usd);
  const eventAt = new Date(horizonAt).toISOString();
  return {
    trade: {
      ...trade,
      status: "CLOSED",
      close_price: exit,
      closed_at: eventAt,
      close_reason: "CLOSED_24H",
      gross_result_usd: Number(gross.toFixed(4)),
      fees_usd: Number(fees.toFixed(4)),
      slippage_usd: Number(slippage.toFixed(4)),
      net_result_usd: Number(net.toFixed(4)),
      result_r: risk > 0 ? Number((net / risk).toFixed(4)) : null,
    },
    event: { eventType: "CLOSED_24H", eventAt, price: exit, quantity: remainingQty },
  };
}

export async function runPaperExecution({ sql, fetchImpl = fetch, now = Date.now(), tradeLimit = 8 } = {}) {
  const backfilled = await backfillMissingPaperTrades(sql);
  const open = await listOpenPaperTrades(sql, tradeLimit);
  const results = [];
  for (const source of open) {
    try {
      const createdMs = Date.parse(source.created_at);
      const horizonAt = createdMs + HORIZON;
      const lastEvaluatedMs = Date.parse(source.last_evaluated_at || source.fill_at || source.created_at);
      const evaluationEnd = Math.min(now, horizonAt);
      const fromMs = Math.max(createdMs, Number.isFinite(lastEvaluatedMs) ? lastEvaluatedMs - MINUTE : createdMs);
      const candles = await fetchOneMinuteCandles(source.symbol, fromMs, evaluationEnd, fetchImpl);
      const simulated = simulatePaperTrade(source, candles);
      let nextTrade = simulated.trade;
      const events = [...simulated.events];
      if (now >= horizonAt && nextTrade.status === "OPEN") {
        const closed = closeAtHorizon(nextTrade, candles, horizonAt);
        nextTrade = closed.trade;
        if (closed.event) events.push(closed.event);
      }
      const saved = await updatePaperTrade(sql, nextTrade, events, new Date(now).toISOString());
      results.push({ id: saved.id, symbol: saved.symbol, lane: saved.lane, status: saved.status, resultR: saved.result_r === null ? null : Number(saved.result_r), events: events.map((event) => event.eventType) });
    } catch (error) {
      results.push({ id: source.id, symbol: source.symbol, lane: source.lane, status: "ERROR", error: error.message });
    }
  }
  return { generatedAt: new Date(now).toISOString(), backfilled, evaluated: results.length, results };
}
