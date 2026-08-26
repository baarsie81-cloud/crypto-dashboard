export const PAPER_EXECUTION_VERSION = "paper-execution-v1";
export const PAPER_DEFAULTS = Object.freeze({
  virtualEquityUsd: 1000,
  baseRiskPct: 1,
  maxNotionalMultiple: 3,
  makerFeeRate: 0.0002,
  takerFeeRate: 0.0005,
  fallbackSlippagePct: 0.05,
  maxSlippagePct: 0.15,
  tp1Fraction: 0.5,
});

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const n = (value) => Number(value);
const round = (value, digits = 8) => Number(Number(value).toFixed(digits));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function laneRiskClass(alert = {}) {
  if (alert.tier === "PRIME") return 1;
  if (alert.tier === "OPPORTUNITY") return 0.25;
  if (alert.tier === "HIGH_BETA") return 0.05;
  const parsed = Number.parseFloat(String(alert.riskClass || ""));
  return [1, 0.25, 0.05].includes(parsed) ? parsed : null;
}

function slippagePct(alert = {}, fallback = PAPER_DEFAULTS.fallbackSlippagePct) {
  const direct = alert?.metrics?.slippagePct;
  return clamp(finite(direct) && n(direct) >= 0 ? n(direct) : fallback, 0, PAPER_DEFAULTS.maxSlippagePct);
}

export function paperOrderType(alert = {}) {
  const source = String(alert.triggerSource || "").toUpperCase();
  const setup = String(alert.setupType || "").toUpperCase();
  if (alert.tier === "HIGH_BETA") return "MARKET";
  if (["MOMENTUM_ACCEPTANCE", "RELATIVE_STRENGTH_CONTINUATION"].includes(source)) return "MARKET";
  if (setup.includes("CONTINUATION")) return "MARKET";
  return "LIMIT";
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
  const virtualEquityUsd = Number(options.virtualEquityUsd) || PAPER_DEFAULTS.virtualEquityUsd;
  const baseRiskPct = Number(options.baseRiskPct) || PAPER_DEFAULTS.baseRiskPct;
  const maxNotionalMultiple = Number(options.maxNotionalMultiple) || PAPER_DEFAULTS.maxNotionalMultiple;
  const orderType = paperOrderType(alert);
  const slipPct = orderType === "MARKET" ? slippagePct(alert, Number(options.fallbackSlippagePct) || PAPER_DEFAULTS.fallbackSlippagePct) : 0;
  const modeledFill = orderType === "MARKET" ? applyEntrySlippage(referenceEntry, direction, slipPct) : referenceEntry;
  const riskPerUnit = Math.abs(modeledFill - stop);
  if (!(riskPerUnit > 0)) return null;

  const riskBudgetUsd = virtualEquityUsd * (baseRiskPct / 100) * riskClass;
  const rawQty = riskBudgetUsd / riskPerUnit;
  const maxNotionalUsd = virtualEquityUsd * maxNotionalMultiple;
  const cappedQty = Math.min(rawQty, maxNotionalUsd / modeledFill);
  const notionalUsd = cappedQty * modeledFill;
  const actualRiskUsd = cappedQty * riskPerUnit;
  const entryFeeRate = orderType === "MARKET" ? PAPER_DEFAULTS.takerFeeRate : PAPER_DEFAULTS.makerFeeRate;
  const entryFeeUsd = orderType === "MARKET" ? notionalUsd * entryFeeRate : 0;
  const slippageUsd = orderType === "MARKET" ? Math.abs(modeledFill - referenceEntry) * cappedQty : 0;

  return {
    lane: alert.tier,
    direction,
    riskClass,
    virtualEquityUsd: round(virtualEquityUsd, 2),
    baseRiskPct: round(baseRiskPct, 4),
    riskBudgetUsd: round(riskBudgetUsd, 4),
    actualRiskUsd: round(actualRiskUsd, 4),
    orderType,
    status: orderType === "MARKET" ? "OPEN" : "PENDING",
    entryLow: round(entryLow),
    entryHigh: round(entryHigh),
    referenceEntry: round(referenceEntry),
    fillPrice: orderType === "MARKET" ? round(modeledFill) : null,
    stopPrice: round(stop),
    target1: round(target1),
    target2: round(target2),
    rrTarget2: finite(alert.rrTarget2) ? round(alert.rrTarget2, 4) : round(Math.abs(target2 - modeledFill) / riskPerUnit, 4),
    positionQty: round(cappedQty),
    notionalUsd: round(notionalUsd, 2),
    entryFeeUsd: round(entryFeeUsd, 4),
    slippageUsd: round(slippageUsd, 4),
    modeledSlippagePct: round(slipPct, 6),
    entryFeeRate,
    exitFeeRate: PAPER_DEFAULTS.takerFeeRate,
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

export function simulatePaperTrade(trade, candles = [], options = {}) {
  if (!trade || !["OPEN", "PENDING"].includes(trade.status)) return { trade, events: [] };
  const payloadPaper = trade.payload?.paper || {};
  const exitFeeRate = Number(options.takerFeeRate ?? payloadPaper.exitFeeRate ?? PAPER_DEFAULTS.takerFeeRate);
  const makerFeeRate = Number(options.makerFeeRate ?? PAPER_DEFAULTS.makerFeeRate);
  const slipPct = Number(options.fallbackSlippagePct ?? payloadPaper.modeledSlippagePct ?? PAPER_DEFAULTS.fallbackSlippagePct);
  const direction = trade.direction;
  const reference = n(trade.reference_entry ?? trade.referenceEntry);
  const totalQty = n(trade.position_qty ?? trade.positionQty);
  const tp1Fraction = PAPER_DEFAULTS.tp1Fraction;
  let fillPrice = finite(trade.fill_price ?? trade.fillPrice) ? n(trade.fill_price ?? trade.fillPrice) : null;
  let fillAt = trade.fill_at ?? trade.fillAt ?? null;
  let remainingQty = trade.t1_hit ? totalQty * (1 - tp1Fraction) : totalQty;
  let gross = n(trade.gross_result_usd) || 0;
  let fees = n(trade.fees_usd) || 0;
  let slippage = n(trade.slippage_usd) || 0;
  let t1Hit = trade.t1_hit === true;
  let t2Hit = trade.t2_hit === true;
  let stopHit = trade.stop_hit === true;
  let status = trade.status;
  let closePrice = finite(trade.close_price) ? n(trade.close_price) : null;
  let closeReason = trade.close_reason || null;
  let closedAt = trade.closed_at || null;
  const events = [];

  for (const candle of candles) {
    if (status === "PENDING") {
      if (!candleHits(candle, reference)) continue;
      fillPrice = reference;
      fillAt = new Date(Number(candle.start)).toISOString();
      fees += Math.abs(fillPrice * totalQty) * makerFeeRate;
      status = "OPEN";
      events.push({ eventType: "FILLED", eventAt: fillAt, price: fillPrice, quantity: totalQty, details: { orderType: "LIMIT", feeRate: makerFeeRate } });
    }
    if (status !== "OPEN" || !fillPrice) continue;

    const stop = n(trade.stop_price ?? trade.stopPrice);
    const target1 = n(trade.target_1 ?? trade.target1);
    const target2 = n(trade.target_2 ?? trade.target2);
    const stopTouched = candleHits(candle, stop);
    const t1Touched = !t1Hit && candleHits(candle, target1);
    const t2Touched = candleHits(candle, target2);

    // Conservatief bij intrabar-ambiguïteit: stop krijgt voorrang.
    if (stopTouched) {
      const exit = applyExitSlippage(stop, direction, slipPct);
      gross += pnl(direction, fillPrice, exit, remainingQty);
      fees += Math.abs(exit * remainingQty) * exitFeeRate;
      slippage += Math.abs(exit - stop) * remainingQty;
      stopHit = true;
      status = "CLOSED";
      closePrice = exit;
      closeReason = "STOP";
      closedAt = new Date(Number(candle.start)).toISOString();
      events.push({ eventType: "STOP", eventAt: closedAt, price: exit, quantity: remainingQty });
      remainingQty = 0;
      break;
    }
    if (t1Touched) {
      const qty = totalQty * tp1Fraction;
      const exit = applyExitSlippage(target1, direction, slipPct);
      gross += pnl(direction, fillPrice, exit, qty);
      fees += Math.abs(exit * qty) * exitFeeRate;
      slippage += Math.abs(exit - target1) * qty;
      t1Hit = true;
      remainingQty = totalQty - qty;
      const at = new Date(Number(candle.start)).toISOString();
      events.push({ eventType: "TP1", eventAt: at, price: exit, quantity: qty });
    }
    if (t1Hit && t2Touched && remainingQty > 0) {
      const exit = applyExitSlippage(target2, direction, slipPct);
      gross += pnl(direction, fillPrice, exit, remainingQty);
      fees += Math.abs(exit * remainingQty) * exitFeeRate;
      slippage += Math.abs(exit - target2) * remainingQty;
      t2Hit = true;
      status = "CLOSED";
      closePrice = exit;
      closeReason = "TP2";
      closedAt = new Date(Number(candle.start)).toISOString();
      events.push({ eventType: "TP2", eventAt: closedAt, price: exit, quantity: remainingQty });
      remainingQty = 0;
      break;
    }
  }

  const net = gross - fees;
  const actualRisk = n(trade.actual_risk_usd ?? trade.actualRiskUsd);
  return {
    trade: {
      ...trade,
      status,
      fill_price: fillPrice,
      fill_at: fillAt,
      t1_hit: t1Hit,
      t2_hit: t2Hit,
      stop_hit: stopHit,
      close_price: closePrice,
      close_reason: closeReason,
      closed_at: closedAt,
      gross_result_usd: round(gross, 4),
      fees_usd: round(fees, 4),
      slippage_usd: round(slippage, 4),
      net_result_usd: status === "CLOSED" ? round(net, 4) : null,
      result_r: status === "CLOSED" && actualRisk > 0 ? round(net / actualRisk, 4) : null,
    },
    events,
  };
}
