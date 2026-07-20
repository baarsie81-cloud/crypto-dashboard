import { TIMEFRAMES, TRADE_DEFAULTS } from "./constants.js";
import { analyzeMarket } from "./signals.js";

function candlesClosedBy(candles, intervalMs, timestamp) {
  return candles.filter((candle) => candle.start + intervalMs <= timestamp);
}

function calculateSummary(trades) {
  const wins = trades.filter((trade) => trade.outcome === "win").length;
  const losses = trades.filter((trade) => trade.outcome === "loss").length;
  const timeouts = trades.length - wins - losses;
  const positive = trades.filter((trade) => trade.netR > 0).reduce((sum, trade) => sum + trade.netR, 0);
  const negative = Math.abs(trades.filter((trade) => trade.netR < 0).reduce((sum, trade) => sum + trade.netR, 0));
  let currentLosingStreak = 0;
  let maxLosingStreak = 0;
  trades.forEach((trade) => {
    if (trade.netR < 0) {
      currentLosingStreak += 1;
      maxLosingStreak = Math.max(maxLosingStreak, currentLosingStreak);
    } else currentLosingStreak = 0;
  });
  return {
    total: trades.length, wins, losses, timeouts,
    winRate: trades.length ? wins / trades.length * 100 : 0,
    averageR: trades.length ? trades.reduce((sum, trade) => sum + trade.netR, 0) / trades.length : 0,
    profitFactor: negative > 0 ? positive / negative : positive > 0 ? Infinity : 0,
    maxLosingStreak,
    sufficientSample: trades.length >= 20,
  };
}

export function evaluateTradeWindow({ candles, startIndex, direction, entry, riskDistance, maxHold = 24 }) {
  const stop = entry - direction * riskDistance;
  const target = entry + direction * riskDistance * 1.5;
  let outcome = "timeout";
  let grossR = 0;
  let exitIndex = Math.min(startIndex + maxHold - 1, candles.length - 1);
  for (let index = startIndex; index <= exitIndex; index += 1) {
    const candle = candles[index];
    const stopHit = direction === 1 ? candle.low <= stop : candle.high >= stop;
    const targetHit = direction === 1 ? candle.high >= target : candle.low <= target;
    if (stopHit) {
      outcome = "loss";
      grossR = -1;
      exitIndex = index;
      break;
    }
    if (targetHit) {
      outcome = "win";
      grossR = 1.5;
      exitIndex = index;
      break;
    }
    if (index === exitIndex) grossR = direction * (candle.close - entry) / riskDistance;
  }
  return { outcome, grossR, exitIndex, stop, target };
}

function valueAt(series, timestamp, fallback = 0) {
  let value = fallback;
  for (const row of series || []) {
    if (row.start > timestamp) break;
    if (Number.isFinite(Number(row.value))) value = Number(row.value);
  }
  return value;
}

function fundingBetween(series, from, to) {
  return (series || [])
    .filter((row) => row.start >= from && row.start <= to)
    .reduce((sum, row) => sum + (Number(row.value) || 0), 0);
}

export function runBacktest({
  symbol,
  candlesByTimeframe,
  instrument = { tradeable: true, maxLeverage: 10 },
  spreadSeries = [],
  fundingSeries = [],
  defaultSpreadPct = 0.05,
  takerFeePct = TRADE_DEFAULTS.takerFeeRatePerSide * 100,
  startAt = Date.now() - 90 * 24 * 60 * 60 * 1000,
}) {
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
      },
      instrument,
      turnoverQuality: 0.75,
      dataAgeMs: 0,
    });
    if (!["LONG", "SHORT"].includes(result.status)) continue;

    const direction = result.status === "LONG" ? 1 : -1;
    const entry = next.open;
    const riskDistance = result.states["60"].atr14 * 1.5;
    const evaluated = evaluateTradeWindow({ candles: oneHour, startIndex: index + 1, direction, entry, riskDistance });
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
      grossR: evaluated.grossR,
      netR,
      feeSpreadCostR,
      fundingCostR,
      score: result.score,
    });
    index = evaluated.exitIndex;
  }

  return { symbol, trades, summary: calculateSummary(trades) };
}

export function combineBacktests(results) {
  const trades = results.flatMap((result) => result.trades).sort((a, b) => a.entryTime - b.entryTime);
  return { trades, summary: calculateSummary(trades) };
}
