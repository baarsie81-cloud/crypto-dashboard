export const CONTEXT_SCHEMA_VERSION = 1;
export const CONTEXT_TTL_MS = 6 * 60 * 60 * 1000;

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const finite = (value) => Number.isFinite(Number(value));
const COMPONENTS = ["macro", "etf", "onchain", "stablecoins", "regulation", "security", "news"];
const WEIGHTS = Object.freeze({ macro: 0.22, etf: 0.22, onchain: 0.16, stablecoins: 0.10, regulation: 0.10, security: 0.10, news: 0.10 });

export function emptyContext(asset) {
  return { version: CONTEXT_SCHEMA_VERSION, asset, generatedAt: 0, expiresAt: 0, sourceCount: 0, components: Object.fromEntries(COMPONENTS.map((key) => [key, { score: 0, confidence: 0, available: false }])), events: [] };
}

function normalizeComponent(value = {}) {
  return {
    score: clamp(value.score, -100, 100),
    confidence: clamp(value.confidence, 0, 100),
    available: value.available === true && finite(value.score) && finite(value.confidence),
    summary: typeof value.summary === "string" ? value.summary.slice(0, 240) : "",
  };
}

export function normalizeContext(payload, asset, now = Date.now()) {
  if (!payload || Number(payload.version) !== CONTEXT_SCHEMA_VERSION || String(payload.asset).toUpperCase() !== String(asset).toUpperCase()) return emptyContext(asset);
  const generatedAt = Number(payload.generatedAt);
  const expiresAt = Number(payload.expiresAt);
  const fresh = generatedAt > 0 && expiresAt > now && generatedAt <= now + 60_000 && now - generatedAt <= CONTEXT_TTL_MS;
  const components = Object.fromEntries(COMPONENTS.map((key) => [key, normalizeComponent(payload.components?.[key])]));
  const events = Array.isArray(payload.events) ? payload.events.filter((event) => event && typeof event.title === "string").slice(0, 8).map((event) => ({ title: event.title.slice(0, 160), impact: clamp(event.impact, -100, 100), confidence: clamp(event.confidence, 0, 100), category: String(event.category || "news").slice(0, 40), observedAt: Number(event.observedAt) || generatedAt })) : [];
  return { version: CONTEXT_SCHEMA_VERSION, asset, generatedAt, expiresAt, sourceCount: Math.max(0, Number(payload.sourceCount) || 0), fresh, components, events };
}

export function contextScore(context) {
  if (!context?.fresh) return { directional: 0, confidence: 0, coverage: 0, available: false };
  let weighted = 0;
  let weightUsed = 0;
  let confidenceWeighted = 0;
  let availableCount = 0;
  for (const key of COMPONENTS) {
    const component = context.components?.[key];
    if (!component?.available) continue;
    const weight = WEIGHTS[key];
    const confidenceFactor = component.confidence / 100;
    weighted += component.score * weight * confidenceFactor;
    confidenceWeighted += component.confidence * weight;
    weightUsed += weight;
    availableCount += 1;
  }
  if (!weightUsed) return { directional: 0, confidence: 0, coverage: 0, available: false };
  return { directional: clamp(weighted / weightUsed, -100, 100), confidence: clamp(confidenceWeighted / weightUsed, 0, 100), coverage: availableCount / COMPONENTS.length, available: true };
}

export function blendSignalWithContext(signal, context) {
  if (!signal) return signal;
  const scored = contextScore(context);
  if (!scored.available) return { ...signal, context: scored, contextFresh: false };
  const contextWeight = Math.min(0.28, 0.28 * scored.coverage * scored.confidence / 100);
  const directionalDelta = scored.directional * contextWeight;
  const longScore = clamp((Number(signal.longScore) || 0) + directionalDelta, 0, 100);
  const shortScore = clamp((Number(signal.shortScore) || 0) - directionalDelta, 0, 100);
  const technicalConfidence = Number(signal.confidence) || 0;
  const confidence = clamp(technicalConfidence * (1 - contextWeight) + scored.confidence * contextWeight, 0, 100);
  const biasScore = signal.bias === "LONG" ? longScore : signal.bias === "SHORT" ? shortScore : Math.max(longScore, shortScore);
  const setupConfidence = clamp((Number(signal.setupConfidence) || 0) * 0.85 + confidence * 0.15, 0, 100);
  return { ...signal, longScore: Math.round(longScore), shortScore: Math.round(shortScore), score: Math.round(biasScore), confidence: Math.round(confidence), setupConfidence: Math.round(setupConfidence), context: scored, contextFresh: true, contextGeneratedAt: context.generatedAt, contextEvents: context.events };
}
