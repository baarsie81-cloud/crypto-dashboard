import { closedCandles } from "./indicators.js";
import { TIMEFRAMES } from "./constants.js";
import { STRATEGY_LIMITS } from "./strategy-config.js";

const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
const pct = (from, to) => finite(from) && Number(from) !== 0 && finite(to)
  ? ((Number(to) - Number(from)) / Number(from)) * 100
  : NaN;

function closeAtOrBefore(candles, timestamp) {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (Number(candles[index].start) <= timestamp) return Number(candles[index].close);
  }
  return NaN;
}

function performance(candles, hours) {
  if (!candles.length) return NaN;
  const latest = candles.at(-1);
  return pct(closeAtOrBefore(candles, Number(latest.start) - hours * 60 * 60 * 1000), latest.close);
}

export function relativePerformanceWindows(coinCandles = [], btcCandles = [], now = Date.now()) {
  const coin = closedCandles(coinCandles, TIMEFRAMES["60"].milliseconds, now);
  const btc = closedCandles(btcCandles, TIMEFRAMES["60"].milliseconds, now);
  return Object.fromEntries([1, 4, 24].map((hours) => {
    const coinPct = performance(coin, hours);
    const btcPct = performance(btc, hours);
    return [`${hours}h`, {
      coinPct,
      btcPct,
      relativePct: finite(coinPct) && finite(btcPct) ? coinPct - btcPct : NaN,
    }];
  }));
}

function breakoutContext(candles, direction, atrValue) {
  const rows = candles.slice(-30);
  if (rows.length < 22 || !["LONG", "SHORT"].includes(direction)) return null;
  const confirmation = rows.slice(-2);
  const reference = rows.slice(0, -2).slice(-20);
  const atr = Number(atrValue);
  if (!(atr > 0) || reference.length < 20) return null;
  const breakoutLevel = direction === "LONG"
    ? Math.max(...reference.map((row) => Number(row.high)))
    : Math.min(...reference.map((row) => Number(row.low)));
  const closes = confirmation.map((row) => Number(row.close));
  const breakoutClosed = direction === "LONG"
    ? closes.at(-1) > breakoutLevel + atr * 0.05
    : closes.at(-1) < breakoutLevel - atr * 0.05;
  const acceptanceConfirmed = direction === "LONG"
    ? closes.every((close) => close > breakoutLevel)
    : closes.every((close) => close < breakoutLevel);
  return { breakoutLevel, breakoutClosed, acceptanceConfirmed, lastClose: closes.at(-1) };
}

function planFromBreakout(direction, context, atrValue, targetRR2 = 2.7) {
  if (!context?.breakoutClosed || !context.acceptanceConfirmed) return null;
  const atr = Number(atrValue);
  const entry = Number(context.lastClose);
  const stop = direction === "LONG"
    ? Number(context.breakoutLevel) - atr * 0.75
    : Number(context.breakoutLevel) + atr * 0.75;
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  return {
    type: "RELATIVE_STRENGTH_CONTINUATION",
    entry,
    entryLow: direction === "LONG" ? context.breakoutLevel : entry - atr * 0.15,
    entryHigh: direction === "LONG" ? entry + atr * 0.15 : context.breakoutLevel,
    stop,
    target1: direction === "LONG" ? entry + risk * 1.5 : entry - risk * 1.5,
    target2: direction === "LONG" ? entry + risk * targetRR2 : entry - risk * targetRR2,
    rr1: 1.5,
    rr2: targetRR2,
    confirmed: true,
    waitFor: "Uitbraak gesloten en acceptatie buiten de zone bevestigd; wacht op een uitvoerbare entry zonder de koers te jagen.",
  };
}

export function evaluateRelativeStrengthContinuation({
  symbol,
  direction,
  coinCandles = [],
  btcCandles = [],
  atrValue,
  volumeRatio,
  openInterestChangePct,
  fundingPctPerHour,
  executionScore,
  btcOpposingPrime = false,
  targetRR2 = 2.7,
  now = Date.now(),
} = {}) {
  const reasons = [];
  if (!symbol || ["PF_XBTUSD", "PF_ETHUSD"].includes(symbol)) reasons.push("Relative Strength Continuation is alleen voor altcoins");
  if (!["LONG", "SHORT"].includes(direction)) reasons.push("Geen geldige richting");
  const windows = relativePerformanceWindows(coinCandles, btcCandles, now);
  const thresholds = { "1h": 0.4, "4h": 1, "24h": 2 };
  for (const [window, threshold] of Object.entries(thresholds)) {
    const relative = Number(windows[window]?.relativePct);
    const supports = direction === "LONG" ? relative >= threshold : relative <= -threshold;
    if (!supports) reasons.push(`Relatieve performance ${window} bevestigt niet`);
  }
  if (Number(volumeRatio) < STRATEGY_LIMITS.relativeStrengthMinVolumeRatio) reasons.push("Volume-expansie ontbreekt");
  const oiAvailable = finite(openInterestChangePct);
  if (oiAvailable) {
    const supportsOi = direction === "LONG"
      ? Number(openInterestChangePct) >= STRATEGY_LIMITS.relativeStrengthMinOiChangePct
      : Number(openInterestChangePct) <= -STRATEGY_LIMITS.relativeStrengthMinOiChangePct;
    if (!supportsOi) reasons.push("Open interest ondersteunt de beweging niet");
  }
  const fundingAvailable = finite(fundingPctPerHour);
  const funding = fundingAvailable ? Number(fundingPctPerHour) : null;
  if (!fundingAvailable) reasons.push("Fundingcontext ontbreekt");
  else if (direction === "LONG" && funding > STRATEGY_LIMITS.relativeStrengthMaxAdverseFundingPctPerHour) reasons.push("Funding is oververhit voor LONG");
  else if (direction === "SHORT" && funding < -STRATEGY_LIMITS.relativeStrengthMaxAdverseFundingPctPerHour) reasons.push("Funding is oververhit voor SHORT");
  if (Number(executionScore) < STRATEGY_LIMITS.opportunityMinExecutionScore) reasons.push("Execution/liquiditeit is onvoldoende");
  if (btcOpposingPrime) reasons.push("Tegengestelde BTC PRIME is actief");

  const closed = closedCandles(coinCandles, TIMEFRAMES["60"].milliseconds, now);
  const breakout = breakoutContext(closed, direction, atrValue);
  if (!breakout?.breakoutClosed) reasons.push("Breakout/breakdown is niet gesloten");
  if (!breakout?.acceptanceConfirmed) reasons.push("Prijsacceptatie buiten de zone ontbreekt");
  const plan = planFromBreakout(direction, breakout, atrValue, targetRR2);
  if ((Number(plan?.rr2) || 0) < STRATEGY_LIMITS.opportunityMinRR2) reasons.push("R/R naar T2 is lager dan 2,5");

  return {
    eligible: reasons.length === 0,
    setupType: "RELATIVE_STRENGTH_CONTINUATION",
    reasons,
    windows,
    volumeRatio: Number(volumeRatio),
    openInterestChangePct: oiAvailable ? Number(openInterestChangePct) : null,
    oiConfirmation: oiAvailable ? reasons.every((reason) => !reason.includes("Open interest")) : null,
    fundingPctPerHour: fundingAvailable ? funding : null,
    breakoutClosed: breakout?.breakoutClosed === true,
    acceptanceConfirmed: breakout?.acceptanceConfirmed === true,
    plan,
  };
}
