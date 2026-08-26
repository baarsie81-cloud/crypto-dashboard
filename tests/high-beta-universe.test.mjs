import test from "node:test";
import assert from "node:assert/strict";
import { selectHighBetaUniverse } from "../js/trade-universe.js";

const market = (symbol) => ({ symbol, tradeable: true });
const ticker = (volumeQuote, openInterest = 1000, lastPrice = 1) => ({ volumeQuote, openInterest, lastPrice, markPrice: lastPrice, bid: lastPrice * 0.9995, ask: lastPrice * 1.0005, suspended: false, postOnly: false });

test("high-beta universe is Kraken-perp-only input and excludes configured majors", () => {
  const markets = [market("PF_XBTUSD"), market("PF_SOLUSD"), market("PF_PUMPUSD"), market("PF_TRUMPUSD")];
  const tickers = new Map([
    ["PF_XBTUSD", ticker(100000000)], ["PF_SOLUSD", ticker(50000000)],
    ["PF_PUMPUSD", ticker(5000000)], ["PF_TRUMPUSD", ticker(4000000)],
  ]);
  const selected = selectHighBetaUniverse(markets, tickers, 20).map((row) => row.symbol);
  assert.deepEqual(selected.sort(), ["PF_PUMPUSD", "PF_TRUMPUSD"].sort());
});
