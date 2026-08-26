import { closedCandles } from "./indicators.js";
import { TIMEFRAMES } from "./constants.js";
import { relativePerformanceWindows } from "./relative-strength.js";

const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pct = (from, to) => finite(from) && Number(from) !== 0 && finite(to) ? ((Number(to) - Number(from)) / Number(from)) * 100 : NaN;

export const HIGH_BETA_LIMITS = Object.freeze({
  minScore: 68,
  minRR2: 2.0,
  minExecutionScore: 65,
  minVolumeRatio: 1.15,
  maxSpreadPct: 0.15,
  maxSlippagePct: 0.12,
  minDepthUSD: 3000,
  maxOiChangePct: 15,
  maxFundingPctPerHour: 0.05,
  maxDistanceAtr: 0.85,
});

function average(values) {
  const clean = values.filter((value) => finite(value)).map(Number);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}

function atr14(candles) {
  const rows = candles.slice(-16);
  const trs = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    const previousClose = Number(rows[index - 1].close);
    trs.push(Math.max(
      Number(row.high) - Number(row.low),
      Math.abs(Number(row.high) - previousClose),
      Math.abs(Number(row.low) - previousClose),
    ));
  }
  return average(trs.slice(-14));
}

function executionMetrics(ticker = {}) {
  const spread = Number(ticker.spreadPct);
  const slippage = Math.max(Number(ticker.buySlippagePct), Number(ticker.sellSlippagePct));
  const depth = Number(ticker.validatedDepthUSD);
  const spreadScore = finite(spread) ? clamp(1 - spread / HIGH_BETA_LIMITS.maxSpreadPct, 0, 1) : 0;
  const slippageScore = finite(slippage) ? clamp(1 - slippage / HIGH_BETA_LIMITS.maxSlippagePct, 0, 1) : 0;
  const depthScore = finite(depth) ? clamp(depth / 15000, 0, 1) : 0;
  return {
    spread,
    slippage,
    depth,
    score: Math.round(100 * (spreadScore * 0.4 + slippageScore * 0.35 + depthScore * 0.25)),
  };
}

function breakoutContext(candles, direction, atrValue) {
  const rows = candles.slice(-30);
  if (rows.length < 22 || !(atrValue > 0)) return null;
  const confirmation = rows.slice(-2);
  const reference = rows.slice(0, -2).slice(-20);
  const level = direction === "LONG"
    ? Math.max(...reference.map((row) => Number(row.high)))
    : Math.min(...reference.map((row) => Number(row.low)));
  const closes = confirmation.map((row) => Number(row.close));
  const breakoutClosed = direction === "LONG"
    ? closes.at(-1) > level + atrValue * 0.04
    : closes.at(-1) < level - atrValue * 0.04;
  const acceptanceConfirmed = direction === "LONG"
    ? closes.every((close) => close > level)
    : closes.every((close) => close < level);
  return { level, lastClose: closes.at(-1), breakoutClosed, acceptanceConfirmed };
}

function buildPlan(direction, context, atrValue) {
  if (!context?.breakoutClosed || !context?.acceptanceConfirmed) return null;
  const entry = Number(context.lastClose);
  const stop = direction === "LONG" ? context.level - atrValue * 0.6 : context.level + atrValue * 0.6;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const rr2 = 2.2;
  return {
    type: "HIGH_BETA_MOMENTUM_ACCEPTANCE",
    entry,
    entryLow: direction === "LONG" ? context.level : entry - atrValue * 0.12,
    entryHigh: direction === "LONG" ? entry + atrValue * 0.12 : context.level,
    stop,
    target1: direction === "LONG" ? entry + risk * 1.25 : entry - risk * 1.25,
    target2: direction === "LONG" ? entry + risk * rr2 : entry - risk * rr2,
    rr1: 1.25,
    rr2,
    confirmed: true,
    waitFor: "High-Beta Momentum Acceptance bevestigd; alleen uitvoerbaar zolang spread, slippage, leverage en actuele R/R groen blijven.",
  };
}

function directionFromMomentum(oneHour, fourHour) {
  if (oneHour >= 0.3 && fourHour >= 1) return "LONG";
  if (oneHour <= -0.3 && fourHour <= -1) return "SHORT";
  return null;
}

export function evaluateHighBetaMomentum({
  symbol,
  market = {},
  ticker = {},
  coinCandles = [],
  btcCandles = [],
  openInterestChangePct,
  btcOpposingPrime = false,
  now = Date.now(),
} = {}) {
  const reasons = [];
  const closed = closedCandles(coinCandles, TIMEFRAMES["60"].milliseconds, now);
  if (closed.length < 30) return { eligible: false, score: 0, reasons: ["Onvoldoende 1u-historie"], plan: null };
  const last = closed.at(-1);
  const close = Number(last.close);
  const oneHour = pct(closed.at(-2)?.close, close);
  const fourHour = pct(closed.at(-5)?.close, close);
  const direction = directionFromMomentum(oneHour, fourHour);
  if (!direction) reasons.push("Momentumversnelling is nog onvoldoende eenduidig");

  const atrValue = atr14(closed);
  const priorVolumes = closed.slice(-21, -1).map((row) => Number(row.volume));
  const volumeRatio = average(priorVolumes) > 0 ? Number(last.volume) / average(priorVolumes) : 0;
  if (volumeRatio < HIGH_BETA_LIMITS.minVolumeRatio) reasons.push("Volume-expansie ontbreekt");

  const execution = executionMetrics(ticker);
  if (market.tradeable !== true || ticker.suspended === true || ticker.postOnly === true) reasons.push("Kraken perpetual is niet volledig verhandelbaar");
  if (ticker.bookValidated !== true) reasons.push("Orderboekvalidatie ontbreekt");
  if (!finite(execution.spread) || execution.spread > HIGH_BETA_LIMITS.maxSpreadPct) reasons.push("Spread is te hoog");
  if (!finite(execution.slippage) || execution.slippage > HIGH_BETA_LIMITS.maxSlippagePct) reasons.push("Slippage is te hoog");
  if (!finite(execution.depth) || execution.depth < HIGH_BETA_LIMITS.minDepthUSD) reasons.push("Orderboekdiepte is te laag");
  if (execution.score < HIGH_BETA_LIMITS.minExecutionScore) reasons.push("Execution-score is te laag");

  const oiAvailable = finite(openInterestChangePct);
  const oi = oiAvailable ? Number(openInterestChangePct) : null;
  if (oiAvailable && oi < 0) reasons.push("Open interest ondersteunt de momentumimpuls niet");
  if (oiAvailable && oi > HIGH_BETA_LIMITS.maxOiChangePct) reasons.push("Open interest loopt te explosief op");

  const fundingPctPerHour = finite(ticker.fundingRatePrediction) ? Number(ticker.fundingRatePrediction) * 100 : null;
  if (fundingPctPerHour !== null && direction === "LONG" && fundingPctPerHour > HIGH_BETA_LIMITS.maxFundingPctPerHour) reasons.push("Funding is oververhit voor LONG");
  if (fundingPctPerHour !== null && direction === "SHORT" && fundingPctPerHour < -HIGH_BETA_LIMITS.maxFundingPctPerHour) reasons.push("Funding is oververhit voor SHORT");

  const breakout = direction ? breakoutContext(closed, direction, atrValue) : null;
  if (!breakout?.breakoutClosed) reasons.push("Breakout/breakdown is niet gesloten");
  if (!breakout?.acceptanceConfirmed) reasons.push("Prijsacceptatie buiten de zone ontbreekt");
  const plan = direction ? buildPlan(direction, breakout, atrValue) : null;
  if ((Number(plan?.rr2) || 0) < HIGH_BETA_LIMITS.minRR2) reasons.push("R/R naar T2 is lager dan 2,0");

  const distanceAtr = breakout && atrValue > 0 ? Math.abs(close - breakout.level) / atrValue : Infinity;
  if (distanceAtr > HIGH_BETA_LIMITS.maxDistanceAtr) reasons.push("Beweging is al te ver van het breakoutniveau; chase-risico");
  if (btcOpposingPrime) reasons.push("Tegengestelde BTC PRIME is actief");

  const windows = relativePerformanceWindows(coinCandles, btcCandles, now);
  const relative1h = Number(windows["1h"]?.relativePct);
  const relative4h = Number(windows["4h"]?.relativePct);
  const relativeSupports = direction === "LONG"
    ? relative1h > 0 && relative4h > 0
    : direction === "SHORT"
      ? relative1h < 0 && relative4h < 0
      : false;
  if (!relativeSupports) reasons.push("Relatieve sterkte/zwakte versus BTC ondersteunt onvoldoende");

  const momentumScore = clamp((Math.abs(oneHour) / 2 * 45) + (Math.abs(fourHour) / 5 * 55), 0, 100);
  const volumeScore = clamp((volumeRatio - 0.7) / 1.3 * 100, 0, 100);
  const oiScore = !oiAvailable ? 55 : oi < 0 ? 20 : oi > HIGH_BETA_LIMITS.maxOiChangePct ? 0 : clamp(60 + oi * 4, 0, 100);
  const fundingScore = fundingPctPerHour === null ? 55 : clamp(100 - Math.abs(fundingPctPerHour) / HIGH_BETA_LIMITS.maxFundingPctPerHour * 100, 0, 100);
  const relativeScore = clamp((Math.abs(relative1h) / 1 * 40) + (Math.abs(relative4h) / 3 * 60), 0, 100);
  const score = Math.round(
    momentumScore * 0.25
    + volumeScore * 0.20
    + execution.score * 0.20
    + oiScore * 0.15
    + fundingScore * 0.10
    + relativeScore * 0.10
  );
  if (score < HIGH_BETA_LIMITS.minScore) reasons.push(`High-beta momentumscore lager dan ${HIGH_BETA_LIMITS.minScore}`);

  return {
    eligible: reasons.length === 0,
    symbol,
    direction,
    score,
    confidence: Math.round(clamp(score * 0.7 + execution.score * 0.3, 0, 100)),
    setupConfidence: Math.round(clamp(score * 0.65 + (breakout?.acceptanceConfirmed ? 35 : 0), 0, 100)),
    tradeQuality: score >= 80 && execution.score >= 80 ? "A" : score >= HIGH_BETA_LIMITS.minScore ? "A-" : "B",
    executionScore: execution.score,
    plan,
    reasons: [...new Set(reasons)],
    metrics: {
      momentum1hPct: oneHour,
      momentum4hPct: fourHour,
      volumeRatio,
      openInterestChangePct: oi,
      fundingPctPerHour,
      spreadPct: execution.spread,
      slippagePct: execution.slippage,
      orderbookDepthUSD: execution.depth,
      relative1hPct: relative1h,
      relative4hPct: relative4h,
      breakoutLevel: breakout?.level ?? null,
      breakoutClosed: breakout?.breakoutClosed === true,
      acceptanceConfirmed: breakout?.acceptanceConfirmed === true,
      distanceAtr,
    },
  };
}
