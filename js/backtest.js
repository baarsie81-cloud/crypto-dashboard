import { TIMEFRAMES, TRADE_DEFAULTS } from "./constants.js";
import { analyzeMarket } from "./signals.js";

export const BACKTEST_MIN_SCORE = 85;
export const BACKTEST_QUALITIES = Object.freeze(new Set(["A", "A+"]));

function candlesClosedBy(candles, intervalMs, timestamp) { return candles.filter((candle) => candle.start + intervalMs <= timestamp); }

function calculateSummary(trades) {
  const wins = trades.filter((trade) => trade.netR > 0).length;
  const losses = trades.filter((trade) => trade.netR < 0).length;
  const timeouts = trades.filter((trade) => trade.outcome === "timeout").length;
  const positive = trades.filter((trade) => trade.netR > 0).reduce((sum, trade) => sum + trade.netR, 0);
  const negative = Math.abs(trades.filter((trade) => trade.netR < 0).reduce((sum, trade) => sum + trade.netR, 0));
  let currentLosingStreak = 0;
  let maxLosingStreak = 0;
  let equityR = 0;
  let peakR = 0;
  let maxDrawdownR = 0;
  trades.forEach((trade) => {
    if (trade.netR < 0) {
      currentLosingStreak += 1;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
    } else currentLosingStreak = 0;
    equityR += trade.netR;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  });
  return {
    total: trades.length,
    wins,
    losses,
    timeouts,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : 0,
    expectancyR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : 0,
    profitFactor: negative > 0 ? positive / negative : positive > 0 ? Infinity : 0,
    maxLosingStreak,
    maxDrawdownR,
    sufficientSample: trades.length >= 20,
    minScore: BACKTEST_MIN_SCORE,
    qualities: [...BACKTEST_QUALITIES],
  };
}

function levelHit(candle, direction, level, kind) {
  if (direction === 1) return kind === "stop" ? candle.low <= level : candle.high >= level;
  return kind === "stop" ? candle.high >= level : candle.low <= level;
}

export function evaluateTradeWindow({ candles, startIndex, direction, entry, stop, target1, target2, maxHold = 24, target1Fraction = 0.5 }) {
  const riskDistance = Math.abs(entry - stop);
  if (!(riskDistance > 0)) return { outcome: "invalid", grossR: 0, exitIndex: startIndex, stop, target1, target2, target1Hit: false, target2Hit: false };
  const target1R = direction * (target1 - entry) / riskDistance;
  const target2R = direction * (target2 - entry) / riskDistance;
  const stopR = -1;
  let remaining = 1;
  let grossR = 0;
  let target1Hit = false;
  let target2Hit = false;
  let outcome = "timeout";
  let exitIndex = Math.min(startIndex + maxHold - 1, candles.length - 1);

  for (let index = startIndex; index <= exitIndex; index += 1) {
    const candle = candles[index];
    const stopHit = levelHit(candle, direction, stop, "stop");
    const t1Hit = !target1Hit && levelHit(candle, direction, target1, "target");
    const t2Hit = levelHit(candle, direction, target2, "target");

    if (!target1Hit) {
      // Conservative intrabar assumption: if stop and a target are both touched, stop happens first.
      if (stopHit) {
        grossR += remaining * stopR;
        outcome = "loss";
        exitIndex = index;
        remaining = 0;
        break;
      }
      if (t1Hit) {
        target1Hit = true;
        const closedFraction = Math.min(target1Fraction, remaining);
        grossR += closedFraction * target1R;
        remaining -= closedFraction;
      }
    }

    if (remaining > 0 && target1Hit) {
      // After T1, keep the original invalidation. Same-candle stop+T2 is resolved conservatively in favour of stop.
      if (stopHit) {
        grossR += remaining * stopR;
        outcome = grossR > 0 ? "partial-win" : "loss";
        exitIndex = index;
        remaining = 0;
        break;
      }
      if (t2Hit) {
        target2Hit = true;
        grossR += remaining * target2R;
        remaining = 0;
        outcome = "win";
        exitIndex = index;
        break;
      }
    }

    if (index === exitIndex && remaining > 0) {
      const closeR = direction * (candle.close - entry) / riskDistance;
      grossR += remaining * closeR;
      outcome = target1Hit ? "partial-timeout" : "timeout";
      remaining = 0;
    }
  }
  return { outcome, grossR, exitIndex, stop, target1, target2, target1Hit, target2Hit };
}

function valueAt(series, timestamp, fallback = 0) { let value = fallback; for (const row of series || []) { if (row.start > timestamp) break; if (Number.isFinite(Number(row.value))) value = Number(row.value); } return value; }
function fundingBetween(series, from, to) { return (series || []).filter((row) => row.start >= from && row.start <= to).reduce((sum, row) => sum + (Number(row.value) || 0), 0); }

export function runBacktest({ symbol, candlesByTimeframe, instrument = { tradeable: true, maxLeverage: 4 }, spreadSeries = [], fundingSeries = [], defaultSpreadPct = 0.05, takerFeePct = TRADE_DEFAULTS.takerFeeRatePerSide * 100, startAt = Date.now() - 90 * 24 * 60 * 60 * 1000 }) {
  const oneHour = candlesByTimeframe["60"] || [];
  const fourHour = candlesByTimeframe["240"] || [];
  const daily = candlesByTimeframe.D || [];
  const trades = [];
  for (let index = 55; index < oneHour.length - 1; index += 1) {
    const decisionCandle = oneHour[index];
    const decisionTime = decisionCandle.start + TIMEFRAMES["60"].milliseconds;
    if (decisionTime < startAt) continue;
    const history = {
      "60": oneHour.slice(0, index + 1),
      "240": candlesClosedBy(fourHour, TIMEFRAMES["240"].milliseconds, decisionTime),
      D: candlesClosedBy(daily, TIMEFRAMES.D.milliseconds, decisionTime),
    };
    const next = oneHour[index + 1];
    if (history["240"].length < 55 || history.D.length < 55 || !next) continue;
    const price = decisionCandle.close;
    const spreadPct = Math.max(0, valueAt(spreadSeries, decisionTime, defaultSpreadPct));
    const spread = price * spreadPct / 100;
    const fundingRate = valueAt(fundingSeries, decisionTime, 0);
    const result = analyzeMarket({
      symbol,
      candlesByTimeframe: history,
      ticker: {
        lastPrice: price,
        bid: price - spread / 2,
        ask: price + spread / 2,
        markPrice: price,
        indexPrice: price,
        premiumPct: 0,
        fundingRate,
        fundingRatePrediction: fundingRate,
        volumeQuote: 1_000_000,
        serverTime: decisionTime,
        bookValidated: true,
        buySlippagePct: spreadPct / 2,
        sellSlippagePct: spreadPct / 2,
        bookDepthMultiple: 10,
      },
      instrument,
      turnoverQuality: 0.75,
      dataAgeMs: 0,
    });

    if (!["LONG", "SHORT"].includes(result.status)) continue;
    if (Number(result.score) < BACKTEST_MIN_SCORE) continue;
    if (!BACKTEST_QUALITIES.has(result.tradeQuality)) continue;
    if (!result.plan?.confirmed) continue;

    const direction = result.status === "LONG" ? 1 : -1;
    const entry = Number(next.open);
    const stop = Number(result.plan.stop);
    const target1 = Number(result.plan.target1);
    const target2 = Number(result.plan.target2);
    const riskDistance = Math.abs(entry - stop);
    if (!(riskDistance > 0) || ![entry, stop, target1, target2].every(Number.isFinite)) continue;
    if (direction === 1 && !(stop < entry && target1 > entry && target2 > entry)) continue;
    if (direction === -1 && !(stop > entry && target1 < entry && target2 < entry)) continue;

    const evaluated = evaluateTradeWindow({ candles: oneHour, startIndex: index + 1, direction, entry, stop, target1, target2 });
    const exitCandle = oneHour[evaluated.exitIndex];
    const feeSpreadReturn = (takerFeePct * 2 + spreadPct) / 100;
    const feeSpreadCostR = feeSpreadReturn / (riskDistance / entry);
    const fundingReturn = direction * fundingBetween(fundingSeries, next.start, exitCandle.start);
    const fundingCostR = fundingReturn / (riskDistance / entry);
    const netR = evaluated.grossR - feeSpreadCostR - fundingCostR;
    trades.push({
      symbol,
      direction: result.status,
      decisionTime,
      entryTime: next.start,
      entryPrice: entry,
      exitTime: exitCandle.start,
      outcome: evaluated.outcome,
      target1Hit: evaluated.target1Hit,
      target2Hit: evaluated.target2Hit,
      grossR: evaluated.grossR,
      netR,
      feeSpreadCostR,
      fundingCostR,
      score: result.score,
      setupConfidence: result.setupConfidence,
      tradeQuality: result.tradeQuality,
      setupType: result.plan.type,
      stop,
      target1,
      target2,
    });
    index = evaluated.exitIndex;
  }
  return { symbol, filter: { minScore: BACKTEST_MIN_SCORE, qualities: [...BACKTEST_QUALITIES] }, trades, summary: calculateSummary(trades) };
}

export function combineBacktests(results) {
  const trades = results.flatMap((result) => result.trades).sort((a, b) => a.entryTime - b.entryTime);
  return { filter: { minScore: BACKTEST_MIN_SCORE, qualities: [...BACKTEST_QUALITIES] }, trades, summary: calculateSummary(trades) };
}
