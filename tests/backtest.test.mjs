import test from "node:test";
import assert from "node:assert/strict";
import { combineBacktests, evaluateTradeWindow, runBacktest } from "../js/backtest.js";

test("stop wint conservatief wanneer stop en target in dezelfde candle vallen", () => {
  const result = evaluateTradeWindow({ candles: [{ open: 100, high: 103, low: 98, close: 102 }], startIndex: 0, direction: 1, entry: 100, riskDistance: 1 });
  assert.equal(result.outcome, "loss");
  assert.equal(result.grossR, -1);
});

test("tradevenster kijkt niet voorbij 24 candles", () => {
  const candles = Array.from({ length: 30 }, (_, index) => ({ open: 100, high: index === 25 ? 103 : 100.4, low: 99.8, close: 100.2 }));
  const result = evaluateTradeWindow({ candles, startIndex: 0, direction: 1, entry: 100, riskDistance: 1, maxHold: 24 });
  assert.equal(result.outcome, "timeout");
  assert.equal(result.exitIndex, 23);
});

test("samenvatting markeert een kleine steekproef", () => {
  const combined = combineBacktests([{ trades: [{ outcome: "win", netR: 1.3, entryTime: 1 }] }]);
  assert.equal(combined.summary.total, 1);
  assert.equal(combined.summary.winRate, 100);
  assert.equal(combined.summary.sufficientSample, false);
});

test("lege backtest levert veilige nulwaarden", () => {
  const combined = combineBacktests([]);
  assert.equal(combined.summary.total, 0);
  assert.equal(combined.summary.profitFactor, 0);
});

test("backtest gebruikt uitsluitend reeds gesloten candles en volgende candle als entry", () => {
  const end = Date.UTC(2026, 7, 6);
  const rising = (count, interval) => {
    const first = end - count * interval;
    return Array.from({ length: count }, (_, index) => {
      const open = 100 + index * 0.25 + index ** 2 * 0.006;
      const close = open + 0.45 + Math.sin(index / 4) * 0.08;
      return { start: first + index * interval, open, high: close + 0.5, low: open - 0.35, close, volume: 1_000 + index * 12 };
    });
  };
  const candlesByTimeframe = { "60": rising(260, 3_600_000), "240": rising(120, 14_400_000), D: rising(90, 86_400_000) };
  const result = runBacktest({ symbol: "PF_XBTUSD", candlesByTimeframe, instrument: { tradeable: true, maxLeverage: 10 }, startAt: 0 });
  for (const trade of result.trades) {
    const entryCandle = candlesByTimeframe["60"].find((candle) => candle.start === trade.entryTime);
    assert.ok(entryCandle);
    assert.equal(trade.entryPrice, entryCandle.open);
    assert.ok(["A", "A+"].includes(trade.tradeQuality));
  }
});
