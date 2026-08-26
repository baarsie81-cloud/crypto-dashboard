import { isCoreSymbol, passes85TradeGate } from "./trade-universe.js";
import { SIGNAL_LIMITS } from "./constants.js";
import {
  RISK_CLASSES,
  SIGNAL_TIERS,
  STRATEGY_LIMITS,
  STRATEGY_VERSION,
  strategyFlags,
} from "./strategy-config.js";

const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
const gradeRank = Object.freeze({ "A+": 4, A: 3, "A-": 2, "B+": 1 });

export function hasOpposingBtcPrime(signal, btcSignal) {
  if (!signal || !btcSignal || !["LONG", "SHORT"].includes(signal.bias || signal.status)) return false;
  const btcGate = passes85TradeGate(btcSignal, { symbol: "PF_XBTUSD" });
  return btcGate.eligible && btcSignal.status !== (signal.status === "LONG" || signal.status === "SHORT" ? signal.status : signal.bias);
}

export function evaluateChase({ direction, currentPrice, plan, minimumRR2 = STRATEGY_LIMITS.opportunityMinRR2 } = {}) {
  const reasons = [];
  const entryLow = Number(plan?.entryLow);
  const entryHigh = Number(plan?.entryHigh);
  const referenceEntry = Number(plan?.entry ?? ((entryLow + entryHigh) / 2));
  const stop = Number(plan?.stop);
  const target1 = Number(plan?.target1);
  const target2 = Number(plan?.target2);
  const current = Number(currentPrice);
  if (![entryLow, entryHigh, referenceEntry, stop, target1, target2, current].every(finite) || !(entryHigh >= entryLow)) {
    return { blocked: true, status: "INVALID_SETUP", reasons: ["Entry-, stop- of targetniveaus zijn ongeldig"], effectiveRR2: 0 };
  }
  const referenceRisk = Math.abs(referenceEntry - stop);
  const currentRisk = Math.abs(current - stop);
  if (!(referenceRisk > 0) || !(currentRisk > 0)) reasons.push("Stopafstand is ongeldig");
  const effectiveRR2 = currentRisk > 0 ? Math.abs(target2 - current) / currentRisk : 0;
  const beyondZone = direction === "LONG" ? current > entryHigh : current < entryLow;
  const missedByR = referenceRisk > 0
    ? (direction === "LONG" ? current - entryHigh : entryLow - current) / referenceRisk
    : Infinity;
  const distanceToT1 = Math.abs(target1 - current);
  if (effectiveRR2 < minimumRR2) reasons.push(`Actuele R/R naar T2 is ${effectiveRR2.toFixed(2)} en lager dan ${minimumRR2}`);
  if (referenceRisk > 0 && currentRisk > referenceRisk * 1.25) reasons.push("Actuele stopafstand is meer dan 25% ongunstiger");
  if (beyondZone && missedByR > 0.25) reasons.push("De technische entryzone is gemist");
  if (referenceRisk > 0 && distanceToT1 < referenceRisk * 0.35) reasons.push("De koers staat al te dicht bij Target 1");
  return {
    blocked: reasons.length > 0,
    status: reasons.length ? "CHASE_BLOCKED" : "CLEAR",
    reasons,
    effectiveRR2,
    missedByR,
  };
}

function opportunityGate(signal, { symbol, btcSignal, currentPrice, relativeStrength, momentumAcceptance } = {}) {
  const reasons = [];
  const score = Number(signal?.score);
  const direction = ["LONG", "SHORT"].includes(signal?.status) ? signal.status : signal?.bias;
  if (!["LONG", "SHORT"].includes(direction)) reasons.push("Geen geldige LONG/SHORT-richting");
  if (score < STRATEGY_LIMITS.opportunityMinScore || score > STRATEGY_LIMITS.opportunityMaxScore) reasons.push("Score valt niet in 82–84");
  if ((gradeRank[signal?.tradeQuality] || 0) < gradeRank["A-"]) reasons.push("Trade Quality is lager dan A-");
  if (Number(signal?.confidence) < STRATEGY_LIMITS.opportunityMinConfidence) reasons.push("Confidence is lager dan 75");
  if (Number(signal?.setupConfidence) < STRATEGY_LIMITS.opportunityMinSetupConfidence) reasons.push("Setup Confidence is lager dan 80");
  if (Number(signal?.executionScore) < STRATEGY_LIMITS.opportunityMinExecutionScore) reasons.push("Execution/liquiditeit is onvoldoende");
  if (signal?.availability !== true) reasons.push("Markt is niet volledig verhandelbaar");
  if (signal?.fresh !== true) reasons.push("Marktdata is verouderd");
  if (signal?.postOnly === true) reasons.push("Markt staat in post-only-modus");
  if (signal?.futuresContext !== true) reasons.push("Futurescontext ontbreekt");
  if (!finite(signal?.spreadPct) || Number(signal.spreadPct) > SIGNAL_LIMITS.actionableSpreadPct) reasons.push("Spread is te hoog of ongeldig");
  if (signal?.adverseFunding === true) reasons.push("Funding is ongunstig voor deze richting");
  if (signal?.adversePremium === true) reasons.push("Premium is ongunstig voor deze richting");
  if (signal?.higherTimeframeConfirmed !== true) reasons.push("4u-bevestiging ontbreekt");
  if (signal?.dailyOpposes === true) reasons.push("1d-trend spreekt de setup sterk tegen");
  const btcOpposingPrime = !isCoreSymbol(symbol) && hasOpposingBtcPrime({ ...signal, bias: direction }, btcSignal);
  if (btcOpposingPrime) reasons.push("Tegengestelde BTC 85+ PRIME setup is actief");

  const triggerSource = relativeStrength?.eligible
    ? "RELATIVE_STRENGTH_CONTINUATION"
    : momentumAcceptance?.eligible
      ? "MOMENTUM_ACCEPTANCE"
      : "CLASSIC";
  const basePlan = relativeStrength?.eligible
    ? relativeStrength.plan
    : momentumAcceptance?.eligible
      ? momentumAcceptance.plan
      : signal?.plan;
  if (!basePlan?.confirmed) reasons.push(basePlan?.waitFor || "Technische trigger is niet bevestigd");
  if (Number(basePlan?.rr2) < STRATEGY_LIMITS.opportunityMinRR2) reasons.push("R/R naar T2 is lager dan 2,5");
  const chase = evaluateChase({ direction, currentPrice, plan: basePlan });
  if (chase.blocked) reasons.push(...chase.reasons);

  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    direction,
    plan: basePlan,
    chase,
    btcOpposingPrime,
    relativeStrength: relativeStrength || null,
    momentumAcceptance: momentumAcceptance || null,
    triggerSource,
  };
}

export function classifySignal(signal, {
  symbol = signal?.symbol,
  btcSignal = null,
  currentPrice = signal?.states?.["60"]?.close,
  relativeStrength = null,
  momentumAcceptance = null,
  flags = strategyFlags(),
} = {}) {
  const prime = passes85TradeGate(signal, { symbol, btcSignal });
  if (prime.eligible) {
    return {
      signalTier: SIGNAL_TIERS.PRIME,
      riskClass: RISK_CLASSES.PRIME,
      eligible: true,
      alertEligible: true,
      status: "ACTIVE",
      reasons: [],
      gateReasons: prime.reasons,
      plan: signal.plan,
      direction: signal.status,
      strategyVersion: STRATEGY_VERSION,
      experimental: false,
      btcOpposingPrime: false,
      triggerSource: "CLASSIC",
    };
  }

  const opportunity = opportunityGate(signal, { symbol, btcSignal, currentPrice, relativeStrength, momentumAcceptance });
  if (flags.opportunitySignalsEnabled && opportunity.eligible) {
    return {
      signalTier: SIGNAL_TIERS.OPPORTUNITY,
      riskClass: RISK_CLASSES.OPPORTUNITY,
      eligible: true,
      alertEligible: true,
      status: "ACTIVE",
      reasons: ["Score is lager dan de PRIME-drempel van 85"],
      gateReasons: prime.reasons,
      plan: opportunity.plan,
      direction: opportunity.direction,
      strategyVersion: STRATEGY_VERSION,
      experimental: true,
      btcOpposingPrime: opportunity.btcOpposingPrime,
      chase: opportunity.chase,
      relativeStrength: opportunity.relativeStrength,
      momentumAcceptance: opportunity.momentumAcceptance,
      triggerSource: opportunity.triggerSource,
    };
  }

  const score = Number(signal?.score);
  if (flags.shadowTrackingEnabled && score >= STRATEGY_LIMITS.shadowMinScore && score <= STRATEGY_LIMITS.shadowMaxScore) {
    const chaseBlocked = opportunity.chase?.blocked === true;
    return {
      signalTier: SIGNAL_TIERS.SHADOW,
      riskClass: RISK_CLASSES.SHADOW,
      eligible: false,
      alertEligible: false,
      status: chaseBlocked ? "CHASE_BLOCKED" : "ACTIVE",
      reasons: [...new Set([...prime.reasons, ...opportunity.reasons])],
      gateReasons: prime.reasons,
      plan: opportunity.plan || signal?.plan,
      direction: opportunity.direction || signal?.bias,
      strategyVersion: STRATEGY_VERSION,
      experimental: true,
      btcOpposingPrime: opportunity.btcOpposingPrime,
      chase: opportunity.chase,
      relativeStrength: opportunity.relativeStrength,
      momentumAcceptance: opportunity.momentumAcceptance,
      triggerSource: opportunity.triggerSource,
    };
  }

  return {
    signalTier: null,
    riskClass: null,
    eligible: false,
    alertEligible: false,
    status: "IGNORED",
    reasons: [...new Set([...prime.reasons, ...opportunity.reasons])],
    gateReasons: prime.reasons,
    plan: signal?.plan || null,
    direction: opportunity.direction || signal?.bias || "NEUTRAAL",
    strategyVersion: STRATEGY_VERSION,
    experimental: false,
    btcOpposingPrime: opportunity.btcOpposingPrime,
    triggerSource: opportunity.triggerSource,
  };
}

export function applyClassification(signal, classification) {
  if (!signal || !classification) return signal;
  const tradable = [SIGNAL_TIERS.PRIME, SIGNAL_TIERS.OPPORTUNITY].includes(classification.signalTier) && classification.eligible;
  const status = tradable ? classification.direction : ["LONG", "SHORT"].includes(signal.status) ? "WATCH" : signal.status;
  return {
    ...signal,
    status,
    plan: classification.plan || signal.plan,
    signalTier: classification.signalTier,
    riskClass: classification.riskClass,
    strategyVersion: classification.strategyVersion,
    alertEligible: classification.alertEligible,
    tierStatus: classification.status,
    classification,
  };
}

export function buildAlertPayload({ signal, classification, ticker = {}, market = {}, observedAt = Date.now() } = {}) {
  if (!signal || !classification?.alertEligible || classification.signalTier === SIGNAL_TIERS.SHADOW) return null;
  const plan = classification.plan || signal.plan || {};
  const payload = {
    strategyVersion: STRATEGY_VERSION,
    tier: classification.signalTier,
    riskClass: `${classification.riskClass}R`,
    experimental: classification.experimental,
    symbol: signal.symbol || market.symbol,
    market: market.label || market.symbol,
    direction: classification.direction,
    score: Number(signal.score),
    quality: signal.tradeQuality,
    confidence: Number(signal.confidence),
    setupConfidence: Number(signal.setupConfidence),
    setupType: plan.type,
    entry: { low: Number(plan.entryLow), high: Number(plan.entryHigh), reference: Number(plan.entry) },
    stop: Number(plan.stop),
    target1: Number(plan.target1),
    target2: Number(plan.target2),
    rrTarget2: Number(plan.rr2),
    trigger: plan.waitFor,
    triggerConfirmed: plan.confirmed === true,
    triggerSource: classification.triggerSource || "CLASSIC",
    executionScore: Number(signal.executionScore),
    btcRegime: signal.marketRegime,
    observedAt: new Date(observedAt).toISOString(),
  };
  if (classification.signalTier === SIGNAL_TIERS.OPPORTUNITY) {
    payload.notPrimeBecause = classification.gateReasons;
    payload.relativeStrength = classification.relativeStrength ? {
      windows: classification.relativeStrength.windows,
      volumeRatio: classification.relativeStrength.volumeRatio,
      oiConfirmation: classification.relativeStrength.oiConfirmation,
      fundingPctPerHour: classification.relativeStrength.fundingPctPerHour,
    } : null;
    payload.momentumAcceptance = classification.momentumAcceptance ? {
      volumeRatio: classification.momentumAcceptance.volumeRatio,
      openInterestChangePct: classification.momentumAcceptance.openInterestChangePct,
      oiConfirmation: classification.momentumAcceptance.oiConfirmation,
      fundingPctPerHour: classification.momentumAcceptance.fundingPctPerHour,
      breakoutClosed: classification.momentumAcceptance.breakoutClosed,
      acceptanceConfirmed: classification.momentumAcceptance.acceptanceConfirmed,
      breakoutLevel: classification.momentumAcceptance.breakoutLevel,
    } : null;
  }
  return payload;
}
