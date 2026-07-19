import test from "node:test";
import assert from "node:assert/strict";
import { combineBacktests, evaluateTradeWindow } from "../js/backtest.js";

test("stop wint conservatief wanneer stop en target in dezelfde candle vallen", () => {
  const result = evaluateTradeWindow({
    candles: [{ open: 100, high: 103, low: 98, close: 102 }],
    startIndex: 0,
    direction: 1,
    entry: 100,
    riskDistance: 1,
  });
  assert.equal(result.outcome, "loss");
  assert.equal(result.grossR, -1);
});

test("tradevenster kijkt niet voorbij de ingestelde 24 candles", () => {
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

test("een lege backtest levert nulwaarden en geen fout op", () => {
  const combined = combineBacktests([]);
  assert.equal(combined.summary.total, 0);
  assert.equal(combined.summary.winRate, 0);
  assert.equal(combined.summary.profitFactor, 0);
  assert.equal(combined.summary.sufficientSample, false);
});
