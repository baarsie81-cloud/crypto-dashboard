import { KRAKEN_PRO_URL, SIGNAL_LIMITS, TRADE_DEFAULTS } from "./constants.js";

export const JOURNAL_STATUSES = Object.freeze(["voorbereid", "order geplaatst", "geopend", "gesloten"]);

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const numberOrNull = (value) => value === null || value === undefined || value === ""
  ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;

function stepDecimals(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]) || 0;
  return (text.split(".")[1] || "").length;
}

export function floorToStep(value, step) {
  const number = Number(value);
  const increment = Number(step);
  if (!Number.isFinite(number) || !finitePositive(increment)) return NaN;
  const decimals = stepDecimals(increment);
  const floored = Math.floor((number + increment * 1e-9) / increment) * increment;
  return Number(floored.toFixed(Math.min(decimals, 12)));
}

function eligibilityReasons(signal, market, ticker) {
  const reasons = [];
  if (!signal || !["LONG", "SHORT"].includes(signal.status)) reasons.push("Alleen een actueel LONG- of SHORT-signaal kan worden voorbereid.");
  if ((Number(signal?.score) || 0) < SIGNAL_LIMITS.actionableScore) reasons.push("De score is lager dan 70.");
  if (!signal?.fresh) reasons.push("De marktdata is ouder dan 60 seconden.");
  if (!signal?.availability || market?.tradeable !== true || ticker?.suspended === true) reasons.push("Kraken meldt deze markt niet als volledig verhandelbaar.");
  if (signal?.postOnly || market?.postOnly || ticker?.postOnly) reasons.push("De markt staat tijdelijk in post-only-modus.");
  if (!signal?.futuresContext) reasons.push("Markprijs, indexprijs of fundingcontext ontbreekt.");
  if (!Number.isFinite(signal?.spreadPct) || signal.spreadPct < 0 || signal.spreadPct > SIGNAL_LIMITS.actionableSpreadPct) reasons.push("De spread is hoger dan 0,15% of ongeldig.");
  if (!signal?.higherTimeframeConfirmed) reasons.push("Het 4u-tijdframe bevestigt de richting niet.");
  if (signal?.dailyOpposes) reasons.push("Het 1d-tijdframe spreekt de richting sterk tegen.");
  if (signal?.adverseFunding) reasons.push("De voorspelde funding is te ongunstig voor deze richting.");
  if (signal?.adversePremium) reasons.push("De mark/index-premium is te ongunstig voor deze richting.");
  if (!signal?.plan) reasons.push("Er is geen geldig tradeplan beschikbaar.");
  return [...new Set(reasons)];
}

function safeLeverage(signal, market, maxLeverage) {
  const suggestion = Math.floor(Number(signal?.plan?.leverage));
  const userCap = Math.floor(Number(maxLeverage));
  const exchangeCap = Math.floor(Number(market?.maxLeverage));
  if (![suggestion, userCap, exchangeCap].every(finitePositive)) return null;
  return Math.max(1, Math.min(10, suggestion, userCap, exchangeCap));
}

function exitDistribution({ quantity, qtyStep, minQty }) {
  const firstHalf = floorToStep(quantity / 2, qtyStep);
  const secondHalf = floorToStep(quantity - firstHalf, qtyStep);
  return firstHalf >= minQty && secondHalf >= minQty
    ? { mode: "50/50", target1Pct: 50, target2Pct: 50, target1Qty: firstHalf, target2Qty: secondHalf }
    : { mode: "100% doel 1", target1Pct: 100, target2Pct: 0, target1Qty: quantity, target2Qty: 0 };
}

export function createManualTradePlan({
  market,
  pair = market,
  signal,
  ticker = {},
  eurUsd,
  budgetEUR = TRADE_DEFAULTS.budgetEUR,
  riskPct = TRADE_DEFAULTS.riskPct,
  maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage,
} = {}) {
  market ||= pair || {};
  const blockedReasons = eligibilityReasons(signal, market, ticker);
  const budget = Number(budgetEUR);
  const riskPercentage = Number(riskPct);
  const exchangeRate = Number(eurUsd);
  if (!finitePositive(budget)) blockedReasons.push("Het handelsbudget in EUR is ongeldig.");
  if (!finitePositive(riskPercentage) || riskPercentage > 100) blockedReasons.push("Het risicopercentage moet tussen 0 en 100 liggen.");
  if (!finitePositive(exchangeRate)) blockedReasons.push("De actuele EUR/USD-index ontbreekt.");

  const tickSize = Number(market?.tickSize);
  const qtyStep = Number(market?.qtyStep);
  const minQty = Number(market?.minQty) || qtyStep;
  const maxQty = Number(market?.maxPositionSize);
  if (!finitePositive(tickSize)) blockedReasons.push("Krakens actuele tickgrootte ontbreekt.");
  if (!finitePositive(qtyStep) || !finitePositive(minQty)) blockedReasons.push("Krakens minimale contracthoeveelheid ontbreekt.");

  const leverage = safeLeverage(signal, market, maxLeverage);
  if (!leverage) blockedReasons.push("Er is geen geldig leverageadvies.");

  const source = signal?.plan || {};
  const entry = floorToStep(source.entry, tickSize);
  const entryLow = floorToStep(source.entryLow, tickSize);
  const entryHigh = floorToStep(source.entryHigh, tickSize);
  const stop = floorToStep(source.stop, tickSize);
  const target1 = floorToStep(source.target1, tickSize);
  const target2 = floorToStep(source.target2, tickSize);
  const direction = signal?.status;
  const stopDistance = Math.abs(entry - stop);
  if (![entry, entryLow, entryHigh, stop, target1, target2].every(finitePositive)) blockedReasons.push("Een of meer prijsniveaus zijn ongeldig.");
  if (!finitePositive(stopDistance)) blockedReasons.push("De stopafstand is ongeldig.");
  if (direction === "LONG" && stop >= entry) blockedReasons.push("De LONG-stop moet onder de instap liggen.");
  if (direction === "SHORT" && stop <= entry) blockedReasons.push("De SHORT-stop moet boven de instap liggen.");

  if (blockedReasons.length) {
    return {
      eligible: false,
      symbol: market?.symbol || signal?.symbol || "",
      pairLabel: market?.label || "Geselecteerde markt",
      direction: direction || "GEEN TRADE",
      blockedReasons: [...new Set(blockedReasons)],
      warnings: [],
    };
  }

  const budgetUSD = budget * exchangeRate;
  const riskBudgetEUR = budget * riskPercentage / 100;
  const riskBudgetUSD = riskBudgetEUR * exchangeRate;
  const spreadFraction = signal.spreadPct / 100;
  const conservativeFeePrice = Math.max(entry, stop);
  const costPerUnit = conservativeFeePrice * TRADE_DEFAULTS.takerFeeRatePerSide * 2 + entry * spreadFraction;
  const quantityByRisk = riskBudgetUSD / (stopDistance + costPerUnit);
  const quantityByMargin = budgetUSD * leverage / entry;
  const rawQuantity = Math.min(quantityByRisk, quantityByMargin, finitePositive(maxQty) ? maxQty : Infinity);
  const quantity = floorToStep(rawQuantity, qtyStep);
  const notionalUSD = quantity * entry;
  const ownMarginUSD = notionalUSD / leverage;
  const ownMarginEUR = ownMarginUSD / exchangeRate;
  const tradingFeesUSD = quantity * conservativeFeePrice * TRADE_DEFAULTS.takerFeeRatePerSide * 2;
  const makerFeesUSD = quantity * conservativeFeePrice * TRADE_DEFAULTS.makerFeeRatePerSide * 2;
  const spreadCostUSD = notionalUSD * spreadFraction;
  const estimatedCostsUSD = tradingFeesUSD + spreadCostUSD;
  const priceLossAtStopUSD = quantity * stopDistance;
  const maxPlannedLossUSD = priceLossAtStopUSD + estimatedCostsUSD;
  const maxPlannedLossEUR = maxPlannedLossUSD / exchangeRate;
  const minimumFailures = [];
  if (!finitePositive(quantity) || !finitePositive(notionalUSD)) minimumFailures.push("De berekende positie is niet geldig.");
  if (quantity < minQty) minimumFailures.push(`Hoeveelheid is lager dan Krakens minimum van ${minQty}.`);
  if (finitePositive(maxQty) && quantity > maxQty) minimumFailures.push(`Hoeveelheid is hoger dan Krakens maximum van ${maxQty}.`);
  if (maxPlannedLossUSD > riskBudgetUSD + 1e-8) minimumFailures.push("Het geplande verlies overschrijdt het risicobudget.");

  const exits = exitDistribution({ quantity, qtyStep, minQty });
  const base = market.base || String(signal.symbol || "").replace(/^PF_/, "").replace(/USD$/, "");
  const relativeFunding = Number(ticker.fundingRate) || 0;
  const fundingEffectUSDPerHour = notionalUSD * relativeFunding * (direction === "LONG" ? -1 : 1);
  return {
    eligible: minimumFailures.length === 0,
    venue: "Kraken Pro",
    productType: "linear perpetual",
    symbol: market.symbol || signal.symbol,
    pairLabel: market.label || `${base}/USD Perp`,
    base,
    direction,
    score: Number(signal.score),
    reasons: Array.isArray(signal.reasons) ? signal.reasons.slice(0, 5) : [],
    timeframeBias: { ...signal.timeframeBias },
    spreadPct: Number(signal.spreadPct),
    premiumPct: Number(ticker.premiumPct),
    fundingRate: relativeFunding,
    fundingRatePrediction: Number(ticker.fundingRatePrediction) || 0,
    fundingEffectUSDPerHour,
    budgetEUR: budget,
    eurUsd: exchangeRate,
    budgetUSD,
    riskPct: riskPercentage,
    riskBudgetEUR,
    riskBudgetUSD,
    leverage,
    entry, entryLow, entryHigh, stop, target1, target2,
    tickSize, qtyStep, minQty, quantity,
    notionalUSD,
    ownMarginUSD,
    ownMarginEUR,
    takerFeesUSD: tradingFeesUSD,
    makerFeesUSD,
    spreadCostUSD,
    estimatedCostsUSD,
    priceLossAtStopUSD,
    maxPlannedLossUSD,
    maxPlannedLossEUR,
    exits,
    instruction: direction === "LONG"
      ? `Open een LONG door ${quantity} ${base}-perpetualcontracten te kopen.`
      : `Open een SHORT door ${quantity} ${base}-perpetualcontracten te verkopen.`,
    marketUrl: `https://futures.kraken.com/trade/futures/${encodeURIComponent(market.symbol)}`,
    krakenProUrl: KRAKEN_PRO_URL,
    blockedReasons: minimumFailures,
    warnings: [
      "Kies handmatig isolated margin en controleer Krakens getoonde liquidatieprijs.",
      "Funding verandert continu en is niet opgenomen in het maximale geplande verlies.",
      "Plaats stop en doelen reduce-only; dit dashboard kan vulling of posities niet controleren.",
    ],
  };
}

function safeSignalSnapshot(value = {}) {
  return {
    score: numberOrNull(value.score),
    spreadPct: numberOrNull(value.spreadPct),
    premiumPct: numberOrNull(value.premiumPct),
    fundingRate: numberOrNull(value.fundingRate),
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((item) => typeof item === "string").slice(0, 5) : [],
    timeframeBias: {
      "60": typeof value.timeframeBias?.["60"] === "string" ? value.timeframeBias["60"] : "NEUTRAAL",
      "240": typeof value.timeframeBias?.["240"] === "string" ? value.timeframeBias["240"] : "NEUTRAAL",
      D: typeof value.timeframeBias?.D === "string" ? value.timeframeBias.D : "NEUTRAAL",
    },
  };
}

function safeOrderSnapshot(value = {}) {
  const fields = [
    "budgetEUR", "eurUsd", "budgetUSD", "riskPct", "riskBudgetEUR", "riskBudgetUSD", "leverage",
    "entry", "entryLow", "entryHigh", "stop", "target1", "target2", "quantity", "notionalUSD",
    "ownMarginUSD", "ownMarginEUR", "estimatedCostsUSD", "maxPlannedLossUSD", "maxPlannedLossEUR",
    "fundingEffectUSDPerHour",
  ];
  return Object.fromEntries(fields.map((field) => [field, numberOrNull(value[field])]));
}

export function createJournalEntry(plan, { id, now = Date.now() } = {}) {
  if (!plan?.eligible) return null;
  const generatedId = id || globalThis.crypto?.randomUUID?.() || `trade-${now}-${Math.random().toString(16).slice(2)}`;
  return {
    version: 2,
    id: String(generatedId),
    venue: "Kraken Pro",
    productType: "linear perpetual",
    symbol: String(plan.symbol),
    pairLabel: String(plan.pairLabel),
    direction: plan.direction,
    status: "voorbereid",
    preparedAt: Number(now),
    updatedAt: Number(now),
    signal: safeSignalSnapshot(plan),
    order: safeOrderSnapshot(plan),
    actualExit: null,
    actualPnlEUR: null,
    closedAt: null,
  };
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.version !== 2 || entry.venue !== "Kraken Pro") return null;
  if (typeof entry.id !== "string" || !entry.id || typeof entry.symbol !== "string") return null;
  if (!["LONG", "SHORT"].includes(entry.direction) || !JOURNAL_STATUSES.includes(entry.status)) return null;
  const preparedAt = Number(entry.preparedAt);
  if (!Number.isFinite(preparedAt)) return null;
  return {
    version: 2,
    id: entry.id.slice(0, 120),
    venue: "Kraken Pro",
    productType: "linear perpetual",
    symbol: entry.symbol.slice(0, 40),
    pairLabel: typeof entry.pairLabel === "string" ? entry.pairLabel.slice(0, 50) : entry.symbol.slice(0, 40),
    direction: entry.direction,
    status: entry.status,
    preparedAt,
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : preparedAt,
    signal: safeSignalSnapshot(entry.signal),
    order: safeOrderSnapshot(entry.order),
    actualExit: numberOrNull(entry.actualExit),
    actualPnlEUR: numberOrNull(entry.actualPnlEUR),
    closedAt: numberOrNull(entry.closedAt),
  };
}

export function normalizeJournal(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeJournalEntry).filter(Boolean).slice(0, 500);
}

export function journalSummary(entries, warningLimit = TRADE_DEFAULTS.cumulativeRiskWarningEUR) {
  const normalized = normalizeJournal(entries);
  const active = normalized.filter((entry) => entry.status !== "gesloten");
  const cumulativePlannedRiskEUR = active.reduce((sum, entry) => sum + Math.max(0, Number(entry.order.maxPlannedLossEUR) || 0), 0);
  const closedPnlEUR = normalized.filter((entry) => entry.status === "gesloten").reduce((sum, entry) => sum + (Number(entry.actualPnlEUR) || 0), 0);
  return {
    total: normalized.length,
    activeCount: active.length,
    cumulativePlannedRiskEUR,
    closedPnlEUR,
    overRiskLimit: cumulativePlannedRiskEUR > Number(warningLimit),
  };
}
