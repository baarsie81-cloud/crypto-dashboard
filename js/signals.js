import { SIGNAL_LIMITS, TIMEFRAMES } from "./constants.js";
import { atr, clamp, closedCandles, ema, lastFinite, macd, rsi, sma } from "./indicators.js";

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
  const trendDirection = (
    signWithTolerance(close - ema20, tolerance)
    + signWithTolerance(ema20 - ema50, tolerance)
    + signWithTolerance(ema50 - ema50Ago, tolerance)
  ) / 3;
  const rsiDirection = clamp((rsi14 - 50) / 20, -1, 1);
  const momentumDirection = (rsiDirection + signWithTolerance(histogram) + signWithTolerance(macdLine - macdSignal)) / 3;
  return {
    closed, close, ema20, ema50, rsi14, macdLine, macdSignal, histogram,
    histogramRising: Number.isFinite(previousHistogram) ? histogram > previousHistogram : false,
    atr14,
    atrPct: close > 0 ? (atr14 / close) * 100 : 0,
    volumeRatio,
    trendDirection,
    momentumDirection,
  };
}

function volatilityQuality(atrPct) {
  if (!Number.isFinite(atrPct) || atrPct <= 0) return 0;
  if (atrPct >= 0.5 && atrPct <= 3) return 1;
  if (atrPct < 0.5) return clamp(atrPct / 0.5, 0, 1);
  return clamp(1 - (atrPct - 3) / 4, 0, 1);
}

function spreadQuality(spreadPct) {
  if (!Number.isFinite(spreadPct)) return 0;
  if (spreadPct <= 0.05) return 1;
  return clamp(1 - (spreadPct - 0.05) / 0.2, 0, 1);
}

function confidenceLeverageCap(score) {
  if (score < SIGNAL_LIMITS.watchScore) return null;
  if (score < 70) return 2;
  if (score < 80) return 4;
  if (score < 90) return 6;
  return 10;
}

export function suggestedLeverage({ score, entry, stop, maxLeverage = 10 }) {
  const confidenceCap = confidenceLeverageCap(score);
  if (!confidenceCap || !Number.isFinite(entry) || !Number.isFinite(stop) || entry <= 0) return null;
  const stopDistance = Math.abs(entry - stop) / entry;
  if (stopDistance <= 0) return null;
  const riskCap = Math.max(1, Math.floor(0.1 / stopDistance));
  return Math.max(1, Math.min(10, maxLeverage, riskCap, confidenceCap));
}

function timeframeBias(state) {
  if (!state) return "NEUTRAAL";
  const value = state.trendDirection * 0.65 + state.momentumDirection * 0.35;
  if (value > 0.2) return "LONG";
  if (value < -0.2) return "SHORT";
  return "NEUTRAAL";
}

function buildReasons({ bias, states, spreadPct, volumeScore, availability, postOnly, futuresContext, adverseFunding, adversePremium }) {
  const reasons = [];
  if (!availability) reasons.push("Kraken-markt niet verhandelbaar");
  if (postOnly) reasons.push("Kraken staat alleen post-only toe");
  if (!futuresContext) reasons.push("Futurescontext onvolledig");
  if (adverseFunding) reasons.push("Funding is ongunstig voor deze richting");
  if (adversePremium) reasons.push("Mark/index-premium is ongunstig");
  if (bias !== "NEUTRAAL" && timeframeBias(states["240"]) === bias) reasons.push(`4u trend bevestigt ${bias.toLowerCase()}`);
  if (bias === "LONG" && states["60"]?.histogram > 0) reasons.push("1u MACD positief");
  if (bias === "SHORT" && states["60"]?.histogram < 0) reasons.push("1u MACD negatief");
  if (volumeScore >= 9) reasons.push("Volume boven gemiddeld");
  if (spreadPct <= 0.05) reasons.push("Spread zeer laag");
  else if (spreadPct > SIGNAL_LIMITS.actionableSpreadPct) reasons.push("Spread vraagt voorzichtigheid");
  return reasons.slice(0, 5);
}

export function analyzeMarket({
  symbol,
  candlesByTimeframe,
  ticker = {},
  instrument = {},
  turnoverQuality = 0.5,
  dataAgeMs = 0,
  maxLeverage = SIGNAL_LIMITS.defaultMaxLeverage,
}) {
  const states = {};
  const now = Number(ticker.serverTime) || Date.now();
  for (const interval of Object.keys(TIMEFRAMES)) {
    const closed = closedCandles(candlesByTimeframe?.[interval] || [], TIMEFRAMES[interval].milliseconds, now);
    states[interval] = timeframeState(closed, interval);
  }

  const bid = Number(ticker.bid);
  const ask = Number(ticker.ask);
  const lastPrice = Number(ticker.lastPrice) || states["60"]?.close || 0;
  const spreadPct = bid > 0 && ask > 0 && lastPrice > 0 ? ((ask - bid) / lastPrice) * 100 : Infinity;
  const availability = instrument.tradeable === true && ticker.suspended !== true;
  const postOnly = instrument.postOnly === true || ticker.postOnly === true;
  const fresh = dataAgeMs <= SIGNAL_LIMITS.staleAfterMs;
  const futuresContext = Number(ticker.markPrice) > 0
    && Number(ticker.indexPrice) > 0
    && Number.isFinite(Number(ticker.fundingRatePrediction))
    && Number.isFinite(Number(ticker.premiumPct));

  if (!Object.values(states).every(Boolean)) {
    return {
      symbol, status: "GEEN TRADE", bias: "NEUTRAAL", score: 0,
      componentScores: { trend: 0, momentum: 0, volume: 0, volatility: 0 },
      timeframeBias: { "60": "NEUTRAAL", "240": "NEUTRAAL", D: "NEUTRAAL" },
      reasons: ["Onvoldoende gesloten candles"], spreadPct, availability, postOnly, fresh,
      futuresContext, adverseFunding: false, adversePremium: false, plan: null, states,
    };
  }

  const trendDirectional = states["60"].trendDirection * 12 + states["240"].trendDirection * 16 + states.D.trendDirection * 12;
  const momentumDirectional = states["60"].momentumDirection * 18 + states["240"].momentumDirection * 12;
  const directional = trendDirectional + momentumDirectional;
  const volumeStrength = clamp((states["60"].volumeRatio - 0.5) / 1.5, 0, 1);
  const volumeScore = 15 * (volumeStrength * 0.6 + clamp(turnoverQuality, 0, 1) * 0.4);
  const volumeQuote = Number(ticker.volumeQuote) || 0;
  const activityQuality = clamp((Math.log10(Math.max(volumeQuote, 1)) - 4) / 4, 0, 1);
  const volatilityScore = 15 * (
    volatilityQuality(states["60"].atrPct) * (7 / 15)
    + spreadQuality(spreadPct) * (5 / 15)
    + activityQuality * (3 / 15)
  );
  const score = Math.round(clamp((Math.abs(directional) / 70) * 70 + volumeScore + volatilityScore, 0, 100));
  const bias = directional >= 18 ? "LONG" : directional <= -18 ? "SHORT" : "NEUTRAAL";
  const bias4h = timeframeBias(states["240"]);
  const bias1d = timeframeBias(states.D);
  const higherTimeframeConfirmed = bias !== "NEUTRAAL" && bias4h === bias;
  const dailyOpposes = (bias === "LONG" && bias1d === "SHORT") || (bias === "SHORT" && bias1d === "LONG");
  const fundingPctPerHour = Number(ticker.fundingRatePrediction) * 100;
  const premiumPct = Number(ticker.premiumPct);
  const adverseFunding = bias === "LONG"
    ? fundingPctPerHour > SIGNAL_LIMITS.adverseFundingPctPerHour
    : bias === "SHORT" ? fundingPctPerHour < -SIGNAL_LIMITS.adverseFundingPctPerHour : false;
  const adversePremium = bias === "LONG"
    ? premiumPct > SIGNAL_LIMITS.adversePremiumPct
    : bias === "SHORT" ? premiumPct < -SIGNAL_LIMITS.adversePremiumPct : false;

  let status = "GEEN TRADE";
  if (availability && fresh && spreadPct <= SIGNAL_LIMITS.maximumSpreadPct && bias !== "NEUTRAAL") {
    if (score >= SIGNAL_LIMITS.actionableScore && higherTimeframeConfirmed && !dailyOpposes && spreadPct <= SIGNAL_LIMITS.actionableSpreadPct) status = bias;
    else if (score >= SIGNAL_LIMITS.watchScore || Math.abs(directional) >= 18) status = "WATCH";
  }
  if (status !== "GEEN TRADE" && (postOnly || !futuresContext || adverseFunding || adversePremium || spreadPct > SIGNAL_LIMITS.actionableSpreadPct)) {
    status = "WATCH";
  }

  const entry = states["60"].close;
  const range = states["60"].atr14;
  const direction = bias === "SHORT" ? -1 : 1;
  const plan = bias === "NEUTRAAL" || status === "GEEN TRADE" ? null : {
    entry,
    entryLow: entry - range * 0.2,
    entryHigh: entry + range * 0.2,
    stop: entry - direction * range * 1.5,
    target1: entry + direction * range * 1.5 * 1.5,
    target2: entry + direction * range * 1.5 * 2.5,
    rr1: 1.5,
    rr2: 2.5,
  };
  const exchangeCap = Number(instrument.maxLeverage) || 1;
  if (plan) plan.leverage = suggestedLeverage({ score, entry: plan.entry, stop: plan.stop, maxLeverage: Math.min(maxLeverage, exchangeCap) });

  return {
    symbol, status, bias, score, directional,
    componentScores: {
      trend: Math.round(clamp(Math.abs(trendDirectional) / 40 * 100, 0, 100)),
      momentum: Math.round(clamp(Math.abs(momentumDirectional) / 30 * 100, 0, 100)),
      volume: Math.round(volumeScore / 15 * 100),
      volatility: Math.round(volatilityScore / 15 * 100),
    },
    timeframeBias: { "60": timeframeBias(states["60"]), "240": bias4h, D: bias1d },
    reasons: buildReasons({ bias, states, spreadPct, volumeScore, availability, postOnly, futuresContext, adverseFunding, adversePremium }),
    spreadPct, availability, postOnly, fresh, futuresContext, adverseFunding, adversePremium,
    higherTimeframeConfirmed, dailyOpposes, plan, states,
  };
}

export function rankTurnover(tickers, symbols) {
  const rows = symbols
    .map((symbol) => ({ symbol, value: Number(tickers.get(symbol)?.volumeQuote) || 0 }))
    .sort((a, b) => a.value - b.value);
  const denominator = Math.max(rows.length - 1, 1);
  return new Map(rows.map((row, index) => [row.symbol, index / denominator]));
}
