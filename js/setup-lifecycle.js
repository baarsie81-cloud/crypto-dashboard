import { STRATEGY_VERSION } from "./strategy-config.js";

const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));

function normalizeNumber(value, precision = 8) {
  return finite(value) ? Number(Number(value).toFixed(precision)) : null;
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function setupKeys({ symbol, direction, setupType, entryLow, entryHigh, stopPrice, tickSize, signalTier, strategyVersion = STRATEGY_VERSION } = {}) {
  const step = finite(tickSize) && Number(tickSize) > 0 ? Number(tickSize) : 1e-8;
  const bucket = (value) => finite(value) ? Math.round(Number(value) / step) : null;
  const identity = [symbol, direction, setupType, bucket(entryLow), bucket(entryHigh), bucket(stopPrice), strategyVersion].join("|");
  const lifecycleKey = `${strategyVersion}:${fnv1a(identity)}`;
  return { lifecycleKey, dedupeKey: `${lifecycleKey}:${signalTier}` };
}

export function buildSetupRecord({ signal, classification, ticker = {}, market = {}, observedAt = Date.now() } = {}) {
  if (!signal || !classification?.signalTier || !classification?.plan) return null;
  const plan = classification.plan;
  const direction = classification.direction;
  const referenceEntry = Number(plan.entry ?? ((Number(plan.entryLow) + Number(plan.entryHigh)) / 2));
  const risk = Math.abs(referenceEntry - Number(plan.stop));
  const levels = [plan.entryLow, plan.entryHigh, referenceEntry, plan.stop, plan.target1, plan.target2];
  if (!["LONG", "SHORT"].includes(direction) || !levels.every(finite) || !(risk > 0)) return null;
  if (direction === "LONG" && !(Number(plan.stop) < referenceEntry && Number(plan.target1) > referenceEntry && Number(plan.target2) > referenceEntry)) return null;
  if (direction === "SHORT" && !(Number(plan.stop) > referenceEntry && Number(plan.target1) < referenceEntry && Number(plan.target2) < referenceEntry)) return null;
  const rr = (target) => risk > 0 ? Math.abs(Number(target) - referenceEntry) / risk : null;
  const keys = setupKeys({
    symbol: signal.symbol || market.symbol,
    direction,
    setupType: plan.type,
    entryLow: plan.entryLow,
    entryHigh: plan.entryHigh,
    stopPrice: plan.stop,
    tickSize: market.tickSize,
    signalTier: classification.signalTier,
    strategyVersion: classification.strategyVersion,
  });
  return {
    createdAt: new Date(observedAt).toISOString(),
    symbol: signal.symbol || market.symbol,
    market: market.label || market.symbol || signal.symbol,
    direction,
    score: Math.round(Number(signal.score)),
    signalTier: classification.signalTier,
    riskClass: Number(classification.riskClass),
    tradeQuality: signal.tradeQuality,
    confidence: Math.round(Number(signal.confidence)),
    setupConfidence: Math.round(Number(signal.setupConfidence)),
    setupType: plan.type,
    entryLow: normalizeNumber(plan.entryLow),
    entryHigh: normalizeNumber(plan.entryHigh),
    referenceEntry: normalizeNumber(referenceEntry),
    stopPrice: normalizeNumber(plan.stop),
    target1: normalizeNumber(plan.target1),
    target2: normalizeNumber(plan.target2),
    rrTarget1: normalizeNumber(plan.rr1 ?? rr(plan.target1), 4),
    rrTarget2: normalizeNumber(plan.rr2 ?? rr(plan.target2), 4),
    btcRegime: signal.marketRegime || null,
    btcOpposingPrime: classification.btcOpposingPrime === true,
    technicalTrigger: plan.waitFor || null,
    triggerConfirmed: plan.confirmed === true,
    executionScore: normalizeNumber(signal.executionScore, 2),
    liquidityScore: normalizeNumber(signal.componentScores?.execution, 2),
    spread: normalizeNumber(signal.spreadPct, 6),
    slippage: normalizeNumber(Math.max(Number(ticker.buySlippagePct), Number(ticker.sellSlippagePct)), 6),
    orderbookDepth: normalizeNumber(ticker.validatedDepthUSD, 2),
    openInterest: normalizeNumber(ticker.openInterest, 8),
    fundingRate: normalizeNumber(ticker.fundingRatePrediction ?? ticker.fundingRate, 10),
    volume24h: normalizeNumber(ticker.volumeQuote, 2),
    lifecycleKey: keys.lifecycleKey,
    dedupeKey: keys.dedupeKey,
    strategyVersion: classification.strategyVersion,
    status: classification.status,
    metadata: {
      classificationReasons: classification.reasons,
      gateReasons: classification.gateReasons,
      triggerSource: classification.triggerSource || "CLASSIC",
      momentumAcceptance: classification.momentumAcceptance || null,
      relativeStrength: classification.relativeStrength || null,
      chase: classification.chase || null,
    },
  };
}

export function promotionTransition(previous, next, promotedAt = Date.now()) {
  const order = { SHADOW: 1, OPPORTUNITY: 2, PRIME: 3 };
  if (!previous || !next || previous.lifecycleKey !== next.lifecycleKey || order[next.signalTier] <= order[previous.signalTier]) return null;
  return {
    previousTier: previous.signalTier,
    newTier: next.signalTier,
    previousScore: Number(previous.score),
    newScore: Number(next.score),
    promotedAt: new Date(promotedAt).toISOString(),
  };
}
