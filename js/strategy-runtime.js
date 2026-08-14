import { evaluateRelativeStrengthContinuation } from "./relative-strength.js";
import { applyClassification, classifySignal } from "./strategy-engine.js";
import { strategyFlags } from "./strategy-config.js";

export function classifyDashboardSignals({ signals = new Map(), candles = {}, tickers = new Map(), flags = strategyFlags(), now = Date.now() } = {}) {
  const btcSignal = signals.get("PF_XBTUSD") || null;
  const btcCandles = candles["PF_XBTUSD"]?.["60"] || [];
  return new Map([...signals.entries()].map(([symbol, signal]) => {
    const ticker = tickers.get(symbol) || {};
    const direction = ["LONG", "SHORT"].includes(signal.status) ? signal.status : signal.bias;
    const relativeStrength = ["PF_XBTUSD", "PF_ETHUSD"].includes(symbol) ? null : evaluateRelativeStrengthContinuation({
      symbol,
      direction,
      coinCandles: candles[symbol]?.["60"] || [],
      btcCandles,
      atrValue: signal?.states?.["60"]?.atr14,
      volumeRatio: signal?.states?.["60"]?.volumeRatio,
      openInterestChangePct: null,
      fundingPctPerHour: Number(ticker.fundingRatePrediction) * 100,
      executionScore: signal.executionScore,
      now,
    });
    const classification = classifySignal(signal, {
      symbol,
      btcSignal,
      currentPrice: ticker.lastPrice || ticker.markPrice || signal?.states?.["60"]?.close,
      relativeStrength,
      flags,
    });
    return [symbol, applyClassification(signal, classification)];
  }));
}
