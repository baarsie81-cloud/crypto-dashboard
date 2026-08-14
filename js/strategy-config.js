export const STRATEGY_VERSION = "prime-opportunity-shadow-v1";

export const SIGNAL_TIERS = Object.freeze({
  PRIME: "PRIME",
  OPPORTUNITY: "OPPORTUNITY",
  SHADOW: "SHADOW",
});

export const RISK_CLASSES = Object.freeze({
  PRIME: 1,
  OPPORTUNITY: 0.25,
  SHADOW: 0,
});

export const STRATEGY_LIMITS = Object.freeze({
  opportunityMinScore: 82,
  opportunityMaxScore: 84,
  shadowMinScore: 78,
  shadowMaxScore: 84,
  opportunityMinConfidence: 75,
  opportunityMinSetupConfidence: 80,
  opportunityMinRR2: 2.5,
  opportunityMinExecutionScore: 75,
  relativeStrengthMinVolumeRatio: 1.4,
  relativeStrengthMinOiChangePct: 0.25,
  relativeStrengthMaxAdverseFundingPctPerHour: 0.05,
  minimumAnalyticsSample: 20,
});

export const DEFAULT_STRATEGY_FLAGS = Object.freeze({
  opportunitySignalsEnabled: true,
  shadowTrackingEnabled: true,
});

function enabled(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1" || value === 1;
}

export function strategyFlags(source = {}) {
  return {
    opportunitySignalsEnabled: enabled(
      source.OPPORTUNITY_SIGNALS_ENABLED ?? source.opportunitySignalsEnabled,
      DEFAULT_STRATEGY_FLAGS.opportunitySignalsEnabled,
    ),
    shadowTrackingEnabled: enabled(
      source.SHADOW_TRACKING_ENABLED ?? source.shadowTrackingEnabled,
      DEFAULT_STRATEGY_FLAGS.shadowTrackingEnabled,
    ),
  };
}
