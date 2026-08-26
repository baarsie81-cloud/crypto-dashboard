import test from "node:test";
import assert from "node:assert/strict";
import { selectHighBetaUniverse } from "../js/trade-universe.js";

test("BTC ETH SOL remain outside high-beta lane", () => {
  const markets = ["PF_XBTUSD","PF_ETHUSD","PF_SOLUSD"].map((symbol) => ({ symbol, tradeable: true }));
  const tickers = new Map(markets.map(({ symbol }) => [symbol, { volumeQuote: 100000000, openInterest: 10000, markPrice: 100, bid: 99.9, ask: 100.1 }]));
  assert.equal(selectHighBetaUniverse(markets, tickers, 20).length, 0);
});
