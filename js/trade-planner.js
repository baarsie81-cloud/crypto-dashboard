import { KRAKEN_PRO_URL, SIGNAL_LIMITS, TRADE_DEFAULTS } from "./constants.js";

export const JOURNAL_STATUSES = Object.freeze(["voorbereid", "order geplaatst", "geopend", "gesloten"]);
const finitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const numberOrNull = (value) => value === null || value === undefined || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function stepDecimals(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Number(text.split("e-")[1]) || 0;
  return (text.split(".")[1] || "").length;
}
export function floorToStep(value, step) {
  const n = Number(value); const s = Number(step);
  if (!Number.isFinite(n) || !finitePositive(s)) return NaN;
  return Number((Math.floor((n + s * 1e-9) / s) * s).toFixed(Math.min(stepDecimals(s), 12)));
}
export function ceilToStep(value, step) {
  const n = Number(value); const s = Number(step);
  if (!Number.isFinite(n) || !finitePositive(s)) return NaN;
  return Number((Math.ceil((n - s * 1e-9) / s) * s).toFixed(Math.min(stepDecimals(s), 12)));
}
export function roundTradePrice(value, step, { direction, role }) {
  if (role === "stop") return direction === "SHORT" ? ceilToStep(value, step) : floorToStep(value, step);
  if (role === "target") return direction === "LONG" ? floorToStep(value, step) : ceilToStep(value, step);
  return direction === "SHORT" ? ceilToStep(value, step) : floorToStep(value, step);
}
export function contractNotionalUSD(market, quantity, price) {
  const multiplier = finitePositive(market?.contractSize) ? Number(market.contractSize) : 1;
  return Number(quantity) * multiplier * Number(price);
}

function eligibilityReasons(signal, market, ticker) {
  const reasons = [];
  if (!["PRIME", "OPPORTUNITY"].includes(signal?.signalTier)) reasons.push("Alleen een vrijgegeven PRIME- of OPPORTUNITY-signaal kan worden voorbereid.");
  if (!signal || !["LONG", "SHORT"].includes(signal.status)) reasons.push("Alleen een actueel LONG- of SHORT-signaal kan worden voorbereid.");
  if ((Number(signal?.score) || 0) < SIGNAL_LIMITS.actionableScore) reasons.push(`De richtingsscore is lager dan ${SIGNAL_LIMITS.actionableScore}.`);
  if ((Number(signal?.confidence) || 0) < SIGNAL_LIMITS.actionableConfidence) reasons.push(`Confidence is lager dan ${SIGNAL_LIMITS.actionableConfidence}.`);
  if ((Number(signal?.setupConfidence) || 0) < SIGNAL_LIMITS.actionableSetupConfidence) reasons.push(`Setup Confidence is lager dan ${SIGNAL_LIMITS.actionableSetupConfidence}.`);
  if (!["A-", "A", "A+"].includes(signal?.tradeQuality)) reasons.push("Trade Quality moet minimaal A- zijn.");
  if (!signal?.plan?.confirmed) reasons.push(signal?.plan?.waitFor || "De technische setup wacht nog op bevestiging.");
  if (!signal?.fresh) reasons.push("De marktdata is ouder dan 60 seconden.");
  if (!signal?.availability || market?.tradeable !== true || ticker?.suspended === true) reasons.push("Kraken meldt deze markt niet als volledig verhandelbaar.");
  if (signal?.postOnly || market?.postOnly || ticker?.postOnly) reasons.push("De markt staat tijdelijk in post-only-modus.");
  if (!signal?.futuresContext) reasons.push("Markprijs, indexprijs of fundingcontext ontbreekt.");
  if (!Number.isFinite(signal?.spreadPct) || signal.spreadPct < 0 || signal.spreadPct > SIGNAL_LIMITS.actionableSpreadPct) reasons.push("De actuele spread is te hoog of ongeldig.");
  if ((Number(signal?.executionScore) || 0) < 75 || ticker?.bookValidated !== true) reasons.push("Recente orderboekdiepte en slippage zijn niet voldoende bevestigd.");
  if (signal?.adverseFunding) reasons.push("De voorspelde funding is te ongunstig voor deze richting.");
  if (signal?.adversePremium) reasons.push("De mark/index-premium is te ongunstig.");
  return [...new Set(reasons)];
}
function safeLeverage(signal, market, maxLeverage) {
  const values = [Math.floor(Number(signal?.plan?.leverage)), Math.floor(Number(maxLeverage)), Math.floor(Number(market?.maxLeverage))];
  if (!values.every(finitePositive)) return null;
  return Math.max(1, Math.min(SIGNAL_LIMITS.absoluteMaxLeverage, ...values));
}
function exitDistribution({ quantity, qtyStep, minQty }) {
  const first = floorToStep(quantity / 2, qtyStep); const second = floorToStep(quantity - first, qtyStep);
  return first >= minQty && second >= minQty
    ? { mode: "50/50", target1Pct: 50, target2Pct: 50, target1Qty: first, target2Qty: second }
    : { mode: "100% doel 1", target1Pct: 100, target2Pct: 0, target1Qty: quantity, target2Qty: 0 };
}

export function createManualTradePlan({ market, pair = market, signal, ticker = {}, eurUsd, budgetEUR = TRADE_DEFAULTS.budgetEUR, accountEquityEUR = TRADE_DEFAULTS.accountEquityEUR, riskPct = TRADE_DEFAULTS.riskPct, maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage, expectedHoldingHours = TRADE_DEFAULTS.expectedHoldingHours } = {}) {
  market ||= pair || {};
  const blockedReasons = eligibilityReasons(signal, market, ticker);
  const marginBudget = Number(budgetEUR); const equity = Number(accountEquityEUR); const riskPercentage = Number(riskPct); const fx = Number(eurUsd);
  if (!finitePositive(marginBudget)) blockedReasons.push("Het maximale marginbudget in EUR is ongeldig.");
  if (!finitePositive(equity)) blockedReasons.push("Account equity in EUR is ongeldig.");
  if (!finitePositive(riskPercentage) || riskPercentage > TRADE_DEFAULTS.maximumRiskPct) blockedReasons.push(`Risico per trade moet tussen 0 en ${TRADE_DEFAULTS.maximumRiskPct}% liggen.`);
  if (!finitePositive(fx)) blockedReasons.push("De actuele EUR/USD-index ontbreekt.");
  const tickSize = Number(market?.tickSize); const qtyStep = Number(market?.qtyStep); const minQty = Number(market?.minQty) || qtyStep; const maxQty = Number(market?.maxPositionSize);
  if (!finitePositive(tickSize)) blockedReasons.push("Krakens actuele tickgrootte ontbreekt.");
  if (!finitePositive(qtyStep) || !finitePositive(minQty)) blockedReasons.push("Krakens minimale contracthoeveelheid ontbreekt.");
  const leverage = safeLeverage(signal, market, maxLeverage); if (!leverage) blockedReasons.push("Er is geen geldig leverageadvies.");
  const source = signal?.plan || {}; const direction = signal?.status;
  const entry = roundTradePrice(source.entry, tickSize, { direction, role: "entry" });
  const entryLow = floorToStep(source.entryLow, tickSize); const entryHigh = ceilToStep(source.entryHigh, tickSize);
  const stop = roundTradePrice(source.stop, tickSize, { direction, role: "stop" });
  const target1 = roundTradePrice(source.target1, tickSize, { direction, role: "target" });
  const target2 = roundTradePrice(source.target2, tickSize, { direction, role: "target" });
  const stopDistance = Math.abs(entry - stop);
  if (![entry, entryLow, entryHigh, stop, target1, target2].every(finitePositive)) blockedReasons.push("Een of meer prijsniveaus zijn ongeldig.");
  if (!finitePositive(stopDistance)) blockedReasons.push("De stopafstand is ongeldig.");
  if (direction === "LONG" && stop >= entry) blockedReasons.push("De LONG-stop moet onder de instap liggen.");
  if (direction === "SHORT" && stop <= entry) blockedReasons.push("De SHORT-stop moet boven de instap liggen.");
  if (blockedReasons.length) return { eligible: false, symbol: market?.symbol || signal?.symbol || "", pairLabel: market?.label || "Geselecteerde markt", direction: direction || "GEEN TRADE", blockedReasons: [...new Set(blockedReasons)], warnings: [] };

  const riskClass = signal.signalTier === "OPPORTUNITY" ? 0.25 : 1;
  const marginBudgetUSD = marginBudget * fx; const riskBudgetEUR = equity * riskPercentage / 100 * riskClass; const riskBudgetUSD = riskBudgetEUR * fx;
  const multiplier = finitePositive(market.contractSize) ? Number(market.contractSize) : 1;
  const spreadFraction = signal.spreadPct / 100;
  const slippageFraction = Math.max(0, Number(direction === "LONG" ? ticker.buySlippagePct : ticker.sellSlippagePct)) / 100;
  const fundingRate = Number(ticker.fundingRatePrediction ?? ticker.fundingRate) || 0; const holdingHours = Math.max(0, Number(expectedHoldingHours) || 0);
  const priceRiskPerContract = stopDistance * multiplier;
  const feePerContract = Math.max(entry, stop) * multiplier * TRADE_DEFAULTS.takerFeeRatePerSide * 2;
  const executionPerContract = entry * multiplier * (spreadFraction + slippageFraction);
  const adverseFundingPerContract = Math.max(0, fundingRate * (direction === "LONG" ? 1 : -1)) * entry * multiplier * holdingHours;
  const allInRiskPerContract = priceRiskPerContract + feePerContract + executionPerContract + adverseFundingPerContract;
  const quantityByRisk = riskBudgetUSD / allInRiskPerContract;
  const quantityByMargin = marginBudgetUSD * leverage / (entry * multiplier);
  const rawQuantity = Math.min(quantityByRisk, quantityByMargin, finitePositive(maxQty) ? maxQty : Infinity);
  const quantity = floorToStep(rawQuantity, qtyStep);
  const notionalUSD = contractNotionalUSD(market, quantity, entry); const ownMarginUSD = notionalUSD / leverage; const ownMarginEUR = ownMarginUSD / fx;
  const tradingFeesUSD = quantity * feePerContract; const executionCostsUSD = quantity * executionPerContract; const fundingCostUSD = quantity * adverseFundingPerContract;
  const priceLossAtStopUSD = quantity * priceRiskPerContract; const maxPlannedLossUSD = priceLossAtStopUSD + tradingFeesUSD + executionCostsUSD + fundingCostUSD; const maxPlannedLossEUR = maxPlannedLossUSD / fx;
  const failures = [];
  if (!finitePositive(quantity) || !finitePositive(notionalUSD)) failures.push("De berekende positie is niet geldig.");
  if (quantity < minQty) failures.push(`Hoeveelheid is lager dan Krakens minimum van ${minQty}.`);
  if (finitePositive(maxQty) && quantity > maxQty) failures.push(`Hoeveelheid is hoger dan Krakens maximum van ${maxQty}.`);
  if (maxPlannedLossUSD > riskBudgetUSD + 1e-8) failures.push("Het geplande verlies overschrijdt het risicobudget.");
  if (notionalUSD > Number(ticker.validatedDepthUSD || 0) / SIGNAL_LIMITS.minimumBookDepthMultiple) failures.push("De positie is te groot ten opzichte van de gevalideerde orderboekdiepte.");
  const exits = exitDistribution({ quantity, qtyStep, minQty });
  const base = market.base || String(signal.symbol || "").replace(/^PF_/, "").replace(/USD$/, "");
  const fundingEffectUSDPerHour = notionalUSD * (Number(ticker.fundingRate) || 0) * (direction === "LONG" ? -1 : 1);
  return { eligible: failures.length === 0, venue: "Kraken Pro", productType: "linear perpetual", symbol: market.symbol || signal.symbol, pairLabel: market.label || `${base}/USD Perp`, base, direction, signalTier: signal.signalTier, riskClass, strategyVersion: signal.strategyVersion, score: Number(signal.score), longScore: Number(signal.longScore), shortScore: Number(signal.shortScore), confidence: Number(signal.confidence), setupConfidence: Number(signal.setupConfidence), tradeQuality: signal.tradeQuality, reasons: Array.isArray(signal.reasons) ? signal.reasons.slice(0, 5) : [], timeframeBias: { ...signal.timeframeBias }, spreadPct: Number(signal.spreadPct), premiumPct: Number(ticker.premiumPct), fundingRate: Number(ticker.fundingRate) || 0, fundingRatePrediction: Number(ticker.fundingRatePrediction) || 0, fundingEffectUSDPerHour, budgetEUR: marginBudget, accountEquityEUR: equity, eurUsd: fx, budgetUSD: marginBudgetUSD, riskPct: riskPercentage, riskBudgetEUR, riskBudgetUSD, leverage, entry, entryLow, entryHigh, stop, target1, target2, tickSize, qtyStep, minQty, contractSize: multiplier, quantity, notionalUSD, ownMarginUSD, ownMarginEUR, takerFeesUSD: tradingFeesUSD, spreadCostUSD: executionCostsUSD, fundingCostUSD, estimatedCostsUSD: tradingFeesUSD + executionCostsUSD + fundingCostUSD, priceLossAtStopUSD, maxPlannedLossUSD, maxPlannedLossEUR, exits, instruction: direction === "LONG" ? `Open een LONG door ${quantity} ${base}-perpetualcontracten te kopen.` : `Open een SHORT door ${quantity} ${base}-perpetualcontracten te verkopen.`, marketUrl: `https://futures.kraken.com/trade/futures/${encodeURIComponent(market.symbol)}`, krakenProUrl: KRAKEN_PRO_URL, blockedReasons: failures, warnings: ["Kies handmatig isolated margin en controleer Krakens getoonde liquidatieprijs.", "Funding, spread en slippage zijn conservatief geraamd maar kunnen tijdens uitvoering veranderen.", "Plaats stop en doelen reduce-only; dit dashboard kan vulling of posities niet controleren."] };
}

function safeSignalSnapshot(value = {}) { return { signalTier: typeof value.signalTier === "string" ? value.signalTier : null, riskClass: numberOrNull(value.riskClass), strategyVersion: typeof value.strategyVersion === "string" ? value.strategyVersion : null, score: numberOrNull(value.score), longScore: numberOrNull(value.longScore), shortScore: numberOrNull(value.shortScore), confidence: numberOrNull(value.confidence), setupConfidence: numberOrNull(value.setupConfidence), tradeQuality: typeof value.tradeQuality === "string" ? value.tradeQuality : null, spreadPct: numberOrNull(value.spreadPct), premiumPct: numberOrNull(value.premiumPct), fundingRate: numberOrNull(value.fundingRate), reasons: Array.isArray(value.reasons) ? value.reasons.filter((item) => typeof item === "string").slice(0, 5) : [], timeframeBias: { "60": typeof value.timeframeBias?.["60"] === "string" ? value.timeframeBias["60"] : "NEUTRAAL", "240": typeof value.timeframeBias?.["240"] === "string" ? value.timeframeBias["240"] : "NEUTRAAL", D: typeof value.timeframeBias?.D === "string" ? value.timeframeBias.D : "NEUTRAAL" } }; }
function safeOrderSnapshot(value = {}) { const fields = ["budgetEUR", "accountEquityEUR", "eurUsd", "budgetUSD", "riskPct", "riskBudgetEUR", "riskBudgetUSD", "leverage", "entry", "entryLow", "entryHigh", "stop", "target1", "target2", "quantity", "contractSize", "notionalUSD", "ownMarginUSD", "ownMarginEUR", "estimatedCostsUSD", "maxPlannedLossUSD", "maxPlannedLossEUR", "fundingEffectUSDPerHour"]; return Object.fromEntries(fields.map((field) => [field, numberOrNull(value[field])])); }
export function createJournalEntry(plan, { id, now = Date.now() } = {}) { if (!plan?.eligible) return null; const generatedId = id || globalThis.crypto?.randomUUID?.() || `trade-${now}-${Math.random().toString(16).slice(2)}`; return { version: 2, id: String(generatedId), venue: "Kraken Pro", productType: "linear perpetual", symbol: String(plan.symbol), pairLabel: String(plan.pairLabel), direction: plan.direction, status: "voorbereid", preparedAt: Number(now), updatedAt: Number(now), signal: safeSignalSnapshot(plan), order: safeOrderSnapshot(plan), actualExit: null, actualPnlEUR: null, closedAt: null }; }
function normalizeJournalEntry(entry) { if (!entry || typeof entry !== "object" || entry.version !== 2 || entry.venue !== "Kraken Pro") return null; if (typeof entry.id !== "string" || !entry.id || typeof entry.symbol !== "string") return null; if (!["LONG", "SHORT"].includes(entry.direction) || !JOURNAL_STATUSES.includes(entry.status)) return null; const preparedAt = Number(entry.preparedAt); if (!Number.isFinite(preparedAt)) return null; return { version: 2, id: entry.id.slice(0, 120), venue: "Kraken Pro", productType: "linear perpetual", symbol: entry.symbol.slice(0, 40), pairLabel: typeof entry.pairLabel === "string" ? entry.pairLabel.slice(0, 50) : entry.symbol.slice(0, 40), direction: entry.direction, status: entry.status, preparedAt, updatedAt: Number.isFinite(Number(entry.updatedAt)) ? Number(entry.updatedAt) : preparedAt, signal: safeSignalSnapshot(entry.signal), order: safeOrderSnapshot(entry.order), actualExit: numberOrNull(entry.actualExit), actualPnlEUR: numberOrNull(entry.actualPnlEUR), closedAt: numberOrNull(entry.closedAt) }; }
export function normalizeJournal(value) { if (!Array.isArray(value)) return []; return value.map(normalizeJournalEntry).filter(Boolean).slice(0, 500); }
export function journalSummary(entries, warningLimit = TRADE_DEFAULTS.cumulativeRiskWarningEUR) { const normalized = normalizeJournal(entries); const active = normalized.filter((entry) => entry.status !== "gesloten"); const cumulativePlannedRiskEUR = active.reduce((sum, entry) => sum + Math.max(0, Number(entry.order.maxPlannedLossEUR) || 0), 0); const closedPnlEUR = normalized.filter((entry) => entry.status === "gesloten").reduce((sum, entry) => sum + (Number(entry.actualPnlEUR) || 0), 0); return { total: normalized.length, activeCount: active.length, cumulativePlannedRiskEUR, closedPnlEUR, overRiskLimit: cumulativePlannedRiskEUR > Number(warningLimit) }; }
