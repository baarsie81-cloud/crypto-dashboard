import { SIGNAL_LIMITS, TIMEFRAMES } from "./constants.js";
import { atr, clamp, closedCandles, ema, lastFinite, macd, rsi, sma } from "./indicators.js";
import { buildStructureSetup, detectMarketStructure } from "./market-structure.js";

const signWithTolerance = (value, tolerance = 0) => {
  if (!Number.isFinite(value) || Math.abs(value) <= tolerance) return 0;
  return value > 0 ? 1 : -1;
};

function timeframeState(candles, interval) {
  const closed = closedCandles(candles || [], TIMEFRAMES[interval].milliseconds, Number.MAX_SAFE_INTEGER);
  if (closed.length < 55) return null;
  const closes = closed.map((candle) => Number(candle.close));
  const volumes = closed.map((candle) => Number(candle.volume));
  const ema20Values = ema(closes, 20);
  const ema50Values = ema(closes, 50);
  const rsiValues = rsi(closes, 14);
  const macdValues = macd(closes);
  const atrValues = atr(closed, 14);
  const volumeAverage = sma(volumes, 20);
  const close = closes.at(-1);
  const ema20 = lastFinite(ema20Values);
  const ema50 = lastFinite(ema50Values);
  const ema50Ago = lastFinite(ema50Values, 5);
  const rsi14 = lastFinite(rsiValues);
  const macdLine = lastFinite(macdValues.line);
  const macdSignal = lastFinite(macdValues.signal);
  const histogram = lastFinite(macdValues.histogram);
  const previousHistogram = lastFinite(macdValues.histogram, 1);
  const atr14 = lastFinite(atrValues);
  const averageVolume = lastFinite(volumeAverage, 1) || lastFinite(volumeAverage);
  const volumeRatio = averageVolume > 0 ? volumes.at(-1) / averageVolume : 1;
  const tolerance = close * 0.0002;
  const trendDirection = (signWithTolerance(close - ema20, tolerance) + signWithTolerance(ema20 - ema50, tolerance) + signWithTolerance(ema50 - ema50Ago, tolerance)) / 3;
  const rsiDirection = clamp((rsi14 - 50) / 20, -1, 1);
  const momentumDirection = (rsiDirection + signWithTolerance(histogram) + signWithTolerance(macdLine - macdSignal)) / 3;
  return { closed, close, ema20, ema50, rsi14, macdLine, macdSignal, histogram, histogramRising: Number.isFinite(previousHistogram) ? histogram > previousHistogram : false, atr14, atrPct: close > 0 ? atr14 / close * 100 : 0, volumeRatio, trendDirection, momentumDirection };
}

function volatilityQuality(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0;
  if (atrPct >= 0.5 && atrPct <= 3) return 1;
  if (atrPct < 0.5) return clamp(atrPct / 0.5, 0, 1);
  return clamp(1 - (atrPct - 3) / 4, 0, 1);
}
function spreadQuality(spreadPct) {
  if (!Number.isFinite(spreadPct)) return 0;
  if (spreadPct <= 0.03) return 1;
  return clamp(1 - (spreadPct - 0.03) / 0.17, 0, 1);
}
function timeframeBias(state) {
  if (!state) return "NEUTRAAL";
  const value = state.trendDirection * 0.65 + state.momentumDirection * 0.35;
  if (value > 0.2) return "LONG";
  if (value < -0.2) return "SHORT";
  return "NEUTRAAL";
}
function leverageCapFromQuality(score, setupConfidence) {
  const quality = Math.min(Number(score) || 0, Number(setupConfidence) || 0);
  if (quality < 80) return 1;
  if (quality < 90) return 2;
  return 3;
}
export function suggestedLeverage({ score, setupConfidence = score, entry, stop, maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage, atrPct = 0 }) {
  if (![entry, stop].every((value) => Number.isFinite(Number(value))) || Number(entry) <= 0) return null;
  const stopDistance = Math.abs(Number(entry) - Number(stop)) / Number(entry);
  if (stopDistance <= 0) return null;
  const stopCap = Math.max(1, Math.floor(0.04 / stopDistance));
  const volatilityCap = Number(atrPct) > 3 ? 1 : Number(atrPct) > 2 ? 2 : SIGNAL_LIMITS.absoluteMaxLeverage;
  return Math.max(1, Math.min(SIGNAL_LIMITS.absoluteMaxLeverage, Number(maxLeverage) || 1, leverageCapFromQuality(score, setupConfidence), stopCap, volatilityCap));
}
function executionQuality({ spreadPct, ticker, turnoverQuality }) {
  const slippage = Number(ticker.estimatedSlippagePct);
  const depthMultiple = Number(ticker.bookDepthMultiple);
  const spread = spreadQuality(spreadPct);
  const slippageScore = Number.isFinite(slippage) ? clamp(1 - slippage / SIGNAL_LIMITS.maximumEstimatedSlippagePct, 0, 1) : 0.45;
  const depthScore = Number.isFinite(depthMultiple) ? clamp(depthMultiple / SIGNAL_LIMITS.minimumBookDepthMultiple, 0, 1) : 0.45;
  return Math.round(100 * (spread * 0.4 + slippageScore * 0.3 + depthScore * 0.2 + clamp(turnoverQuality, 0, 1) * 0.1));
}
function tradeQuality({ score, confidence, setupConfidence, rr2, executionScore }) {
  if (score >= 85 && confidence >= 80 && setupConfidence >= 85 && rr2 >= 2.5 && executionScore >= 85) return "A+";
  if (score >= 80 && confidence >= 75 && setupConfidence >= 78 && rr2 >= 2 && executionScore >= 75) return "A";
  if (score >= 70 && confidence >= 60) return "B";
  if (score >= 55) return "C";
  return "D";
}
function rr(entry, stop, target) {
  const risk = Math.abs(entry - stop);
  return risk > 0 ? Math.abs(target - entry) / risk : 0;
}

export function analyzeMarket({ symbol, candlesByTimeframe, ticker = {}, instrument = {}, turnoverQuality = 0.5, dataAgeMs = 0, maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage }) {
  const states = {};
  const now = Number(ticker.serverTime) || Date.now();
  for (const interval of Object.keys(TIMEFRAMES)) {
    const closed = closedCandles(candlesByTimeframe?.[interval] || [], TIMEFRAMES[interval].milliseconds, now);
    states[interval] = timeframeState(closed, interval);
  }
  const bid = Number(ticker.bid); const ask = Number(ticker.ask);
  const lastPrice = Number(ticker.lastPrice) || states["60"]?.close || 0;
  const spreadPct = bid > 0 && ask > 0 && lastPrice > 0 ? (ask - bid) / lastPrice * 100 : Infinity;
  const availability = instrument.tradeable === true && ticker.suspended !== true;
  const postOnly = instrument.postOnly === true || ticker.postOnly === true;
  const fresh = dataAgeMs <= SIGNAL_LIMITS.staleAfterMs;
  const futuresContext = Number(ticker.markPrice) > 0 && Number(ticker.indexPrice) > 0 && Number.isFinite(Number(ticker.fundingRatePrediction)) && Number.isFinite(Number(ticker.premiumPct));
  if (!Object.values(states).every(Boolean)) return { symbol, status: "GEEN TRADE", bias: "NEUTRAAL", score: 0, longScore: 0, shortScore: 0, confidence: 0, setupConfidence: 0, tradeQuality: "D", marketRegime: "NEUTRAAL", componentScores: { trend: 0, momentum: 0, volume: 0, execution: 0 }, timeframeBias: { "60": "NEUTRAAL", "240": "NEUTRAAL", D: "NEUTRAAL" }, reasons: ["Onvoldoende gesloten candles"], spreadPct, availability, postOnly, fresh, futuresContext, plan: null, states };

  const trendDirectional = states["60"].trendDirection * 12 + states["240"].trendDirection * 16 + states.D.trendDirection * 12;
  const momentumDirectional = states["60"].momentumDirection * 18 + states["240"].momentumDirection * 12;
  const directional = trendDirectional + momentumDirectional;
  const volumeStrength = clamp((states["60"].volumeRatio - 0.5) / 1.5, 0, 1);
  const activity = clamp((Math.log10(Math.max(Number(ticker.volumeQuote) || 1, 1)) - 4) / 4, 0, 1);
  const executionScore = executionQuality({ spreadPct, ticker, turnoverQuality });
  const quality = 100 * (volumeStrength * 0.25 + volatilityQuality(states["60"].atrPct) * 0.2 + activity * 0.15 + executionScore / 100 * 0.4);
  const directionalNorm = clamp(directional / 70, -1, 1);
  const longScore = Math.round(clamp(50 + directionalNorm * 42 + (quality - 50) * 0.16, 0, 100));
  const shortScore = Math.round(clamp(50 - directionalNorm * 42 + (quality - 50) * 0.16, 0, 100));
  const bias = directional >= 18 ? "LONG" : directional <= -18 ? "SHORT" : "NEUTRAAL";
  const score = bias === "LONG" ? longScore : bias === "SHORT" ? shortScore : Math.max(longScore, shortScore);
  const bias4h = timeframeBias(states["240"]); const bias1d = timeframeBias(states.D);
  const agreement = [timeframeBias(states["60"]), bias4h, bias1d].filter((value) => value === bias).length / 3;
  const dataCompleteness = [fresh, futuresContext, Number.isFinite(spreadPct), executionScore >= 50].filter(Boolean).length / 4;
  const confidence = Math.round(clamp(agreement * 55 + dataCompleteness * 30 + Math.abs(directionalNorm) * 15, 0, 100));
  const fundingPctPerHour = Number(ticker.fundingRatePrediction) * 100;
  const premiumPct = Number(ticker.premiumPct);
  const adverseFunding = bias === "LONG" ? fundingPctPerHour > SIGNAL_LIMITS.adverseFundingPctPerHour : bias === "SHORT" ? fundingPctPerHour < -SIGNAL_LIMITS.adverseFundingPctPerHour : false;
  const adversePremium = bias === "LONG" ? premiumPct > SIGNAL_LIMITS.adversePremiumPct : bias === "SHORT" ? premiumPct < -SIGNAL_LIMITS.adversePremiumPct : false;
  const structure = detectMarketStructure(states["60"].closed, { atrValue: states["60"].atr14, currentPrice: lastPrice });
  const plan = buildStructureSetup({ bias, price: lastPrice, atrValue: states["60"].atr14, structure, volumeRatio: states["60"].volumeRatio });
  if (plan) { plan.rr1 = rr(plan.entry, plan.stop, plan.target1); plan.rr2 = rr(plan.entry, plan.stop, plan.target2); }
  const locationScore = plan?.confirmed ? 100 : plan?.type?.includes("BREAK") ? 65 : 55;
  const setupConfidence = Math.round(clamp(confidence * 0.35 + executionScore * 0.25 + locationScore * 0.25 + Math.min(100, (plan?.rr2 || 0) / 2.5 * 100) * 0.15, 0, 100));
  const qualityGrade = tradeQuality({ score, confidence, setupConfidence, rr2: plan?.rr2 || 0, executionScore });
  if (plan) plan.leverage = suggestedLeverage({ score, setupConfidence, entry: plan.entry, stop: plan.stop, maxLeverage: Math.min(maxLeverage, Number(instrument.maxLeverage) || 1), atrPct: states["60"].atrPct });
  const higherTimeframeConfirmed = bias !== "NEUTRAAL" && bias4h === bias;
  const dailyOpposes = bias === "LONG" ? bias1d === "SHORT" : bias === "SHORT" ? bias1d === "LONG" : false;
  let status = "GEEN TRADE";
  const hardGate = availability && fresh && !postOnly && futuresContext && spreadPct <= SIGNAL_LIMITS.actionableSpreadPct && !adverseFunding && !adversePremium && executionScore >= 60;
  if (bias !== "NEUTRAAL" && score >= SIGNAL_LIMITS.watchScore) status = "WATCH";
  if (hardGate && plan?.confirmed && ["A", "A+"].includes(qualityGrade) && higherTimeframeConfirmed && !dailyOpposes) status = bias;
  const marketRegime = directional > 12 ? "BULLISH" : directional < -12 ? "BEARISH" : "NEUTRAAL";
  const reasons = [higherTimeframeConfirmed ? `4u bevestigt ${bias.toLowerCase()}` : "4u bevestiging ontbreekt", executionScore >= 75 ? "Uitvoeringskwaliteit sterk" : "Liquiditeit/spread vraagt bevestiging", plan?.waitFor, adverseFunding ? "Funding ongunstig" : null, adversePremium ? "Premium ongunstig" : null].filter(Boolean).slice(0, 5);
  return { symbol, status, bias, score, longScore, shortScore, confidence, setupConfidence, tradeQuality: qualityGrade, marketRegime, directional, componentScores: { trend: Math.round(clamp(Math.abs(trendDirectional) / 40 * 100, 0, 100)), momentum: Math.round(clamp(Math.abs(momentumDirectional) / 30 * 100, 0, 100)), volume: Math.round(volumeStrength * 100), execution: executionScore }, timeframeBias: { "60": timeframeBias(states["60"]), "240": bias4h, D: bias1d }, reasons, spreadPct, availability, postOnly, fresh, futuresContext, adverseFunding, adversePremium, higherTimeframeConfirmed, dailyOpposes, executionScore, structure, plan, states };
}

export function rankTurnover(tickers, symbols) {
  const rows = symbols.map((symbol) => ({ symbol, value: Number(tickers.get(symbol)?.volumeQuote) || 0 })).sort((a, b) => a.value - b.value);
  const denominator = Math.max(rows.length - 1, 1);
  return new Map(rows.map((row, index) => [row.symbol, index / denominator]));
}
