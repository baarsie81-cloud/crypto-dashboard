import { SIGNAL_LIMITS, TRADE_DEFAULTS } from "./constants.js";

export const JOURNAL_STATUSES = Object.freeze(["voorbereid", "order geplaatst", "geopend", "gesloten"]);

const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const numberOrNull = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

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

function eligibilityReasons(signal, instrument) {
  const reasons = [];
  if (!signal || !["LONG", "SHORT"].includes(signal.status)) reasons.push("Alleen een actueel LONG- of SHORT-signaal kan worden voorbereid.");
  if ((Number(signal?.score) || 0) < SIGNAL_LIMITS.actionableScore) reasons.push("De score is lager dan 70.");
  if (!signal?.fresh) reasons.push("De marktdata is ouder dan 60 seconden.");
  if (!signal?.availability || instrument?.status !== "Trading" || instrument?.marginTrading === "none") reasons.push("Bybit EU meldt geen actuele publieke marginstatus.");
  if (!Number.isFinite(signal?.spreadPct) || signal.spreadPct < 0 || signal.spreadPct > SIGNAL_LIMITS.actionableSpreadPct) reasons.push("De spread is hoger dan 0,15% of ongeldig.");
  if (!signal?.higherTimeframeConfirmed) reasons.push("Het 4u-tijdframe bevestigt de richting niet.");
  if (signal?.dailyOpposes) reasons.push("Het 1d-tijdframe spreekt de richting sterk tegen.");
  if (!signal?.plan) reasons.push("Er is geen geldig tradeplan beschikbaar.");
  return [...new Set(reasons)];
}

function safeLeverage(signal, maxLeverage) {
  const suggestion = Math.floor(Number(signal?.plan?.leverage));
  const userCap = Math.floor(Number(maxLeverage));
  if (!finitePositive(suggestion) || !finitePositive(userCap)) return null;
  return Math.max(1, Math.min(10, suggestion, userCap));
}

function minimumChecks({ quantity, notional, minQty, minOrderAmt, maxQty }) {
  const failures = [];
  if (quantity < minQty) failures.push(`Hoeveelheid is lager dan Bybits minimum van ${minQty}.`);
  if (notional < minOrderAmt) failures.push(`Orderwaarde is lager dan Bybits minimum van ${minOrderAmt} USDC.`);
  if (finitePositive(maxQty) && quantity > maxQty) failures.push(`Hoeveelheid is hoger dan Bybits maximum van ${maxQty}.`);
  return failures;
}

function exitDistribution({ quantity, target1, target2, qtyStep, minQty, minOrderAmt }) {
  const firstHalf = floorToStep(quantity / 2, qtyStep);
  const secondHalf = floorToStep(quantity - firstHalf, qtyStep);
  const halvesValid = firstHalf >= minQty && secondHalf >= minQty
    && firstHalf * target1 >= minOrderAmt
    && secondHalf * target2 >= minOrderAmt;
  return halvesValid
    ? { mode: "50/50", target1Pct: 50, target2Pct: 50, target1Qty: firstHalf, target2Qty: secondHalf }
    : { mode: "100% doel 1", target1Pct: 100, target2Pct: 0, target1Qty: quantity, target2Qty: 0 };
}

export function createManualTradePlan({
  pair,
  signal,
  instrument = {},
  budgetUSDC = TRADE_DEFAULTS.budgetUSDC,
  riskPct = TRADE_DEFAULTS.riskPct,
  maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage,
} = {}) {
  const blockedReasons = eligibilityReasons(signal, instrument);
  const budget = Number(budgetUSDC);
  const riskPercentage = Number(riskPct);
  if (!finitePositive(budget)) blockedReasons.push("Het handelsbudget is ongeldig.");
  if (!finitePositive(riskPercentage) || riskPercentage > 100) blockedReasons.push("Het risicopercentage moet tussen 0 en 100 liggen.");

  const tickSize = Number(instrument?.priceFilter?.tickSize);
  const qtyStep = Number(instrument?.lotSizeFilter?.qtyStep || instrument?.lotSizeFilter?.basePrecision);
  const minQty = Number(instrument?.lotSizeFilter?.minOrderQty) || qtyStep;
  const minOrderAmt = Number(instrument?.lotSizeFilter?.minOrderAmt);
  const maxQty = Number(instrument?.lotSizeFilter?.maxLimitOrderQty || instrument?.lotSizeFilter?.maxOrderQty);
  if (!finitePositive(tickSize)) blockedReasons.push("Bybits actuele tickgrootte ontbreekt.");
  if (!finitePositive(qtyStep)) blockedReasons.push("Bybits actuele hoeveelheidsstap ontbreekt.");
  if (!finitePositive(minQty) || !finitePositive(minOrderAmt)) blockedReasons.push("Bybits minimumordergegevens ontbreken.");

  const leverage = safeLeverage(signal, maxLeverage);
  if (!leverage) blockedReasons.push("Er is geen geldig leverageadvies.");

  const sourcePlan = signal?.plan || {};
  const entry = floorToStep(sourcePlan.entry, tickSize);
  const entryLow = floorToStep(sourcePlan.entryLow, tickSize);
  const entryHigh = floorToStep(sourcePlan.entryHigh, tickSize);
  const stop = floorToStep(sourcePlan.stop, tickSize);
  const target1 = floorToStep(sourcePlan.target1, tickSize);
  const target2 = floorToStep(sourcePlan.target2, tickSize);
  const direction = signal?.status;
  const stopDistance = Math.abs(entry - stop);
  if (![entry, entryLow, entryHigh, stop, target1, target2].every(finitePositive)) blockedReasons.push("Een of meer prijsniveaus zijn ongeldig.");
  if (!finitePositive(stopDistance)) blockedReasons.push("De stopafstand is ongeldig.");
  if (direction === "LONG" && stop >= entry) blockedReasons.push("De LONG-stop moet onder de instap liggen.");
  if (direction === "SHORT" && stop <= entry) blockedReasons.push("De SHORT-stop moet boven de instap liggen.");

  if (blockedReasons.length) {
    return {
      eligible: false,
      symbol: pair?.symbol || signal?.symbol || "",
      direction: direction || "GEEN TRADE",
      blockedReasons: [...new Set(blockedReasons)],
      warnings: [],
    };
  }

  const spreadFraction = signal.spreadPct / 100;
  const riskBudget = budget * riskPercentage / 100;
  const conservativeFeePrice = Math.max(entry, stop);
  const costPerUnit = conservativeFeePrice * TRADE_DEFAULTS.feeRatePerSide * 2 + entry * spreadFraction;
  const quantityByRisk = riskBudget / (stopDistance + costPerUnit);
  const quantityByMargin = budget * leverage / entry;
  const rawQuantity = Math.min(quantityByRisk, quantityByMargin, finitePositive(maxQty) ? maxQty : Infinity);
  const quantity = floorToStep(rawQuantity, qtyStep);
  const notional = quantity * entry;
  const ownMargin = notional / leverage;
  const tradingFees = quantity * conservativeFeePrice * TRADE_DEFAULTS.feeRatePerSide * 2;
  const spreadCost = notional * spreadFraction;
  const estimatedCosts = tradingFees + spreadCost;
  const priceLossAtStop = quantity * stopDistance;
  const maxPlannedLoss = priceLossAtStop + estimatedCosts;
  const minimumFailures = minimumChecks({ quantity, notional, minQty, minOrderAmt, maxQty });

  if (!finitePositive(quantity) || !finitePositive(notional)) minimumFailures.unshift("De berekende positie is niet geldig.");
  if (maxPlannedLoss > riskBudget + 1e-8) minimumFailures.push("Het geplande verlies overschrijdt het risicobudget.");
  if (quantity * stop < minOrderAmt || quantity * target1 < minOrderAmt) minimumFailures.push("De volledige stop- of doelorder haalt Bybits minimumwaarde niet.");

  const exits = exitDistribution({ quantity, target1, target2, qtyStep, minQty, minOrderAmt });
  const base = pair?.base || instrument.baseCoin || String(signal.symbol || "").replace(/USDC$/, "");
  return {
    eligible: minimumFailures.length === 0,
    symbol: pair?.symbol || signal.symbol,
    pairLabel: pair?.label || `${base}/USDC`,
    base,
    direction,
    score: Number(signal.score),
    reasons: Array.isArray(signal.reasons) ? signal.reasons.slice(0, 4) : [],
    timeframeBias: { ...signal.timeframeBias },
    spreadPct: Number(signal.spreadPct),
    budgetUSDC: budget,
    riskPct: riskPercentage,
    riskBudget,
    leverage,
    entry,
    entryLow,
    entryHigh,
    stop,
    target1,
    target2,
    tickSize,
    qtyStep,
    minQty,
    minOrderAmt,
    quantity,
    notional,
    ownMargin,
    tradingFees,
    spreadCost,
    estimatedCosts,
    priceLossAtStop,
    maxPlannedLoss,
    exits,
    instruction: direction === "LONG"
      ? `Leen USDC en koop ${base} met een limietorder.`
      : `Leen ${base} en verkoop deze met een limietorder.`,
    bybitUrl: `https://www.bybit.eu/trade/spot/${encodeURIComponent(base)}/USDC`,
    blockedReasons: minimumFailures,
    warnings: [
      "Controleer actuele leenbaarheid en borrowing rate handmatig; borrowing fees zijn niet meegerekend.",
      "Vulling, slippage, liquidatiekosten en terugbetaling zijn niet zichtbaar voor dit dashboard.",
    ],
  };
}

function safeSignalSnapshot(value = {}) {
  return {
    score: numberOrNull(value.score),
    spreadPct: numberOrNull(value.spreadPct),
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((item) => typeof item === "string").slice(0, 4) : [],
    timeframeBias: {
      "60": typeof value.timeframeBias?.["60"] === "string" ? value.timeframeBias["60"] : "NEUTRAAL",
      "240": typeof value.timeframeBias?.["240"] === "string" ? value.timeframeBias["240"] : "NEUTRAAL",
      D: typeof value.timeframeBias?.D === "string" ? value.timeframeBias.D : "NEUTRAAL",
    },
  };
}

function safeOrderSnapshot(value = {}) {
  const fields = ["budgetUSDC", "riskPct", "riskBudget", "leverage", "entry", "entryLow", "entryHigh", "stop", "target1", "target2", "quantity", "notional", "ownMargin", "estimatedCosts", "maxPlannedLoss"];
  return Object.fromEntries(fields.map((field) => [field, numberOrNull(value[field])]));
}

export function createJournalEntry(plan, { id, now = Date.now() } = {}) {
  if (!plan?.eligible) return null;
  const generatedId = id || globalThis.crypto?.randomUUID?.() || `trade-${now}-${Math.random().toString(16).slice(2)}`;
  return {
    id: String(generatedId),
    symbol: String(plan.symbol),
    direction: plan.direction,
    status: "voorbereid",
    preparedAt: Number(now),
    updatedAt: Number(now),
    signal: safeSignalSnapshot(plan),
    order: safeOrderSnapshot(plan),
    actualExit: null,
    actualPnl: null,
    closedAt: null,
  };
}

function normalizeJournalEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.id !== "string" || !entry.id || typeof entry.symbol !== "string") return null;
  if (!["LONG", "SHORT"].includes(entry.direction) || !JOURNAL_STATUSES.includes(entry.status)) return null;
  const preparedAt = Number(entry.preparedAt);
  if (!Number.isFinite(preparedAt)) return null;
  return {
    id: entry.id.slice(0, 120),
    symbol: entry.symbol.slice(0, 30),
    direction: entry.direction,
    status: entry.status,
    preparedAt,
    updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : preparedAt,
    signal: safeSignalSnapshot(entry.signal),
    order: safeOrderSnapshot(entry.order),
    actualExit: numberOrNull(entry.actualExit),
    actualPnl: numberOrNull(entry.actualPnl),
    closedAt: numberOrNull(entry.closedAt),
  };
}

export function normalizeJournal(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeJournalEntry).filter(Boolean).slice(0, 500);
}

export function journalSummary(entries, warningLimit = TRADE_DEFAULTS.cumulativeRiskWarningUSDC) {
  const normalized = normalizeJournal(entries);
  const active = normalized.filter((entry) => entry.status !== "gesloten");
  const cumulativePlannedRisk = active.reduce((sum, entry) => sum + Math.max(0, Number(entry.order.maxPlannedLoss) || 0), 0);
  const closedPnl = normalized.filter((entry) => entry.status === "gesloten").reduce((sum, entry) => sum + (Number(entry.actualPnl) || 0), 0);
  return {
    total: normalized.length,
    activeCount: active.length,
    cumulativePlannedRisk,
    closedPnl,
    overRiskLimit: cumulativePlannedRisk > Number(warningLimit),
  };
}
