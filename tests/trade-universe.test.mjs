import test from "node:test";
import assert from "node:assert/strict";
import { passes85TradeGate, selectTradeUniverse } from "../js/trade-universe.js";

const market = (symbol) => ({ symbol, tradeable: true });
const ticker = (volumeQuote, extra = {}) => ({ volumeQuote, openInterest: 1000, markPrice: 100, bid: 99.95, ask: 100.05, ...extra });

test("BTC en ETH blijven altijd in dynamische top-15", () => {
  const markets = [market("PF_XBTUSD"), market("PF_ETHUSD"), ...Array.from({ length: 20 }, (_, i) => market(`PF_ALT${i}USD`))];
  const tickers = new Map(markets.map((m, i) => [m.symbol, ticker((i + 1) * 1_000_000)]));
  const selected = selectTradeUniverse(markets, tickers, 15).map((m) => m.symbol);
  assert.equal(selected.length, 15);
  assert.ok(selected.includes("PF_XBTUSD"));
  assert.ok(selected.includes("PF_ETHUSD"));
});

test("altcoin 85+ vereist strengere confidence, setup confidence, execution en RR", () => {
  const base = { symbol: "PF_SOLUSD", status: "LONG", score: 90, tradeQuality: "A+", confidence: 79, setupConfidence: 90, executionScore: 90, plan: { confirmed: true, rr2: 3 } };
  assert.equal(passes85TradeGate(base).eligible, false);
  assert.equal(passes85TradeGate({ ...base, confidence: 85 }).eligible, true);
});

test("tegengestelde BTC 85+ setup blokkeert altcoin trade", () => {
  const alt = { symbol: "PF_SOLUSD", status: "LONG", score: 90, tradeQuality: "A+", confidence: 85, setupConfidence: 90, executionScore: 90, plan: { confirmed: true, rr2: 3 } };
  const btc = { symbol: "PF_XBTUSD", status: "SHORT", score: 88, tradeQuality: "A", plan: { confirmed: true } };
  const gate = passes85TradeGate(alt, { btcSignal: btc });
  assert.equal(gate.eligible, false);
  assert.ok(gate.reasons.some((reason) => reason.includes("BTC")));
});
