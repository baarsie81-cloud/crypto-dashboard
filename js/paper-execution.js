export const PAPER_EXECUTION_VERSION = "paper-execution-v1";
export const PAPER_DEFAULTS = Object.freeze({
  virtualEquityEur: 1000,
  baseRiskPct: 1,
  maxNotionalMultiple: 3,
  takerFeeRate: 0.0005,
  fallbackSlippagePct: 0.05,
  tp1Fraction: 0.5,
});

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const n = (value) => Number(value);
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));

function laneRiskClass(alert = {}) {
  if (alert.tier === "PRIME") return 1;
  if (alert.tier === "OPPORTUNITY") return 0.25;
  if (alert.tier === "HIGH_BETA") return 0.05;
  const parsed = Number.parseFloat(String(alert.riskClass || ""));
  return [1, 0.25, 0.05].includes(parsed) ? parsed : null;
}

function slippagePct(alert = {}, fallback = PAPER_DEFAULTS.fallbackSlippagePct) {
  const direct = alert?.metrics?.slippagePct;
  return finite(direct) && n(direct) >= 0 ? n(direct) : fallback;
}

function applyEntrySlippage(price, direction, pct) {
  const factor = pct / 100;
  return direction === "LONG" ? price * (1 + factor) : price * (1 - factor);
}

function applyExitSlippage(price, direction, pct) {
  const factor = pct / 100;
  return direction === "LONG" ? price * (1 - factor) : price * (1 + factor);
}

export function buildPaperOrderFromAlert(alert, options = {}) {
  if (!alert || !["PRIME", "OPPORTUNITY", "HIGH_BETA"].includes(alert.tier)) return null;
  const direction = alert.direction;
  if (!["LONG", "SHORT"].includes(direction)) return null;
  const entryLow = n(alert?.entry?.low);
  const entryHigh = n(alert?.entry?.high);
  const referenceEntry = n(alert?.entry?.reference);
  const stop = n(alert.stop);
  const target1 = n(alert.target1);
  const target2 = n(alert.target2);
  if (![entryLow, entryHigh, referenceEntry, stop, target1, target2].every(Number.isFinite)) return null;
  const validGeometry = direction === "LONG"
    ? stop < referenceEntry && target1 > referenceEntry && target2 > referenceEntry
    : stop > referenceEntry && target1 < referenceEntry && target2 < referenceEntry;
  if (!validGeometry) return null;

  const riskClass = laneRiskClass(alert);
  if (!riskClass) return null;
  const virtualEquityEur = Number(options.virtualEquityEur) || PAPER_DEFAULTS.virtualEquityEur;
  const baseRiskPct = Number(options.baseRiskPct) || PAPER_DEFAULTS.baseRiskPct;
  const maxNotionalMultiple = Number(options.maxNotionalMultiple) || PAPER_DEFAULTS.maxNotionalMultiple;
  const feeRate = Number(options.takerFeeRate) || PAPER_DEFAULTS.takerFeeRate;
  const slipPct = slippagePct(alert, Number(options.fallbackSlippagePct) || PAPER_DEFAULTS.fallbackSlippagePct);
  const modeledFill = applyEntrySlippage(referenceEntry, direction, slipPct);
  const riskPerUnit = Math.abs(modeledFill - stop);
  if (!(riskPerUnit > 0)) return null;

  const riskBudgetEur = virtualEquityEur * (baseRiskPct / 100) * riskClass;
  const rawQty = riskBudgetEur / riskPerUnit;
  const maxNotionalEur = virtualEquityEur * maxNotionalMultiple;
  const cappedQty = Math.min(rawQty, maxNotionalEur / modeledFill);
  const notionalEur = cappedQty * modeledFill;
  const actualRiskEur = cappedQty * riskPerUnit;
  const entryFeeEur = notionalEur * feeRate;
  const slippageEur = Math.abs(modeledFill - referenceEntry) * cappedQty;

  return {
    lane: alert.tier,
    direction,
    riskClass,
    virtualEquityEur: round(virtualEquityEur, 2),
    baseRiskPct: round(baseRiskPct, 4),
    riskBudgetEur: round(riskBudgetEur, 4),
    actualRiskEur: round(actualRiskEur, 4),
    orderType: "MARKET",
    status: "OPEN",
    entryLow: round(entryLow),
    entryHigh: round(entryHigh),
    referenceEntry: round(referenceEntry),
    fillPrice: round(modeledFill),
    stopPrice: round(stop),
    target1: round(target1),
    target2: round(target2),
    rrTarget2: finite(alert.rrTarget2) ? round(alert.rrTarget2, 4) : round(Math.abs(target2 - modeledFill) / riskPerUnit, 4),
    positionQty: round(cappedQty),
    notionalEur: round(notionalEur, 2),
    entryFeeEur: round(entryFeeEur, 4),
    slippageEur: round(slippageEur, 4),
    modeledSlippagePct: round(slipPct, 6),
    takerFeeRate: feeRate,
    triggerSource: alert.triggerSource || alert.setupType || null,
    paperVersion: PAPER_EXECUTION_VERSION,
  };
}

function pnl(direction, entry, exit, qty) {
  return direction === "LONG" ? (exit - entry) * qty : (entry - exit) * qty;
}

function candleHits(candle, price) {
  return n(candle.low) <= price && n(candle.high) >= price;
}

function adverseFirstEvents(trade, candle) {
  const stopHit = candleHits(candle, n(trade.stop_price ?? trade.stopPrice));
  const t1Hit = !trade.t1_hit && candleHits(candle, n(trade.target_1 ?? trade.target1));
  const t2Hit = candleHits(candle, n(trade.target_2 ?? trade.target2));
  if (stopHit) return ["STOP"];
  const events = [];
  if (t1Hit) events.push("TP1");
  if (t2Hit) events.push("TP2");
  return events;
}

export function simulatePaperTrade(trade, candles = [], options = {}) {
  if (!trade || !["OPEN", "PENDING"].includes(trade.status)) return { trade, events: [] };
  const feeRate = Number(options.takerFeeRate ?? trade.payload?.paper?.takerFeeRate ?? PAPER_DEFAULTS.takerFeeRate);
  const slipPct = Number(options.fallbackSlippagePct ?? trade.payload?.paper?.modeledSlippagePct ?? PAPER_DEFAULTS.fallbackSlippagePct);
  const direction = trade.direction;
  const entry = n(trade.fill_price ?? trade.fillPrice ?? trade.reference_entry ?? trade.referenceEntry);
  const totalQty = n(trade.position_qty ?? trade.positionQty);
  const tp1Fraction = PAPER_DEFAULTS.tp1Fraction;
  let remainingQty = trade.t1_hit ? totalQty * (1 - tp1Fraction) : totalQty;
  let gross = n(trade.gross_result_eur) || 0;
  let fees = n(trade.fees_eur) || n(trade.entryFeeEur) || 0;
  let slippage = n(trade.slippage_eur) || n(trade.slippageEur) || 0;
  let t1Hit = trade.t1_hit === true;
  let t2Hit = trade.t2_hit === true;
  let stopHit = trade.stop_hit === true;
  let status = trade.status === "PENDING" ? "OPEN" : trade.status;
  let closePrice = finite(trade.close_price) ? n(trade.close_price) : null;
  let closeReason = trade.close_reason || null;
  let closedAt = trade.closed_at || null;
  const events = [];

  for (const candle of candles) {
    if (status !== "OPEN") break;
    for (const event of adverseFirstEvents({ ...trade, t1_hit: t1Hit }, candle)) {
      if (event === "STOP") {
        const exit = applyExitSlippage(n(trade.stop_price ?? trade.stopPrice), direction, slipPct);
        gross += pnl(direction, entry, exit, remainingQty);
        fees += Math.abs(exit * remainingQty) * feeRate;
        slippage += Math.abs(exit - n(trade.stop_price ?? trade.stopPrice)) * remainingQty;
        stopHit = true;
        status = "CLOSED";
        closePrice = exit;
        closeReason = "STOP";
        closedAt = new Date(Number(candle.start)).toISOString();
        events.push({ eventType: "STOP", eventAt: closedAt, price: exit, quantity: remainingQty });
        remainingQty = 0;
        break;
      }
      if (event === "TP1" && !t1Hit) {
        const qty = totalQty * tp1Fraction;
        const exit = applyExitSlippage(n(trade.target_1 ?? trade.target1), direction, slipPct);
        gross += pnl(direction, entry, exit, qty);
        fees += Math.abs(exit * qty) * feeRate;
        slippage += Math.abs(exit - n(trade.target_1 ?? trade.target1)) * qty;
        t1Hit = true;
        remainingQty = totalQty - qty;
        const at = new Date(Number(candle.start)).toISOString();
        events.push({ eventType: "TP1", eventAt: at, price: exit, quantity: qty });
      }
      if (event === "TP2" && t1Hit && remainingQty > 0) {
        const exit = applyExitSlippage(n(trade.target_2 ?? trade.target2), direction, slipPct);
        gross += pnl(direction, entry, exit, remainingQty);
        fees += Math.abs(exit * remainingQty) * feeRate;
        slippage += Math.abs(exit - n(trade.target_2 ?? trade.target2)) * remainingQty;
        t2Hit = true;
        status = "CLOSED";
        closePrice = exit;
        closeReason = "TP2";
        closedAt = new Date(Number(candle.start)).toISOString();
        events.push({ eventType: "TP2", eventAt: closedAt, price: exit, quantity: remainingQty });
        remainingQty = 0;
      }
    }
  }

  const net = gross - fees;
  const actualRisk = n(trade.actual_risk_eur ?? trade.actualRiskEur);
  return {
    trade: {
      ...trade,
      status,
      t1_hit: t1Hit,
      t2_hit: t2Hit,
      stop_hit: stopHit,
      close_price: closePrice,
      close_reason: closeReason,
      closed_at: closedAt,
      gross_result_eur: round(gross, 4),
      fees_eur: round(fees, 4),
      slippage_eur: round(slippage, 4),
      net_result_eur: round(net, 4),
      result_r: actualRisk > 0 ? round(net / actualRisk, 4) : null,
    },
    events,
  };
}
