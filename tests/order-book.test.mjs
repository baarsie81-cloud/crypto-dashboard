import test from "node:test";
import assert from "node:assert/strict";
import { FuturesOrderBook, calculateBookExecution } from "../js/order-book.js";

test("snapshot en opeenvolgende delta houden het boek valide", () => {
  const book = new FuturesOrderBook("PF_XBTUSD");
  assert.equal(book.applySnapshot({ seq: 10, bids: [{ price: 99, qty: 20 }], asks: [{ price: 101, qty: 20 }] }), true);
  assert.equal(book.applyDelta({ seq: 11, side: "buy", price: 100, qty: 5 }), true);
  assert.equal(book.valid, true);
  assert.equal(book.seq, 11);
});

test("sequence gap maakt het boek onmiddellijk ongeldig", () => {
  const book = new FuturesOrderBook("PF_XBTUSD");
  book.applySnapshot({ seq: 10, bids: [{ price: 99, qty: 20 }], asks: [{ price: 101, qty: 20 }] });
  assert.equal(book.applyDelta({ seq: 12, side: "buy", price: 100, qty: 5 }), false);
  assert.equal(book.valid, false);
});

test("slippage en diepte worden uit echte levels berekend", () => {
  const metrics = calculateBookExecution({
    bids: [{ price: 99.9, qty: 100 }, { price: 99.8, qty: 100 }],
    asks: [{ price: 100.1, qty: 100 }, { price: 100.2, qty: 100 }],
    contractSize: 1,
    targetNotionalUSD: 5_000,
  });
  assert.ok(metrics);
  assert.ok(metrics.spreadPct > 0);
  assert.ok(metrics.buySlippagePct >= 0);
  assert.ok(metrics.sellSlippagePct >= 0);
  assert.ok(metrics.validatedDepthUSD > 0);
  assert.ok(metrics.bookDepthMultiple > 0);
});

test("onvoldoende diepte levert geen uitvoerbare VWAP", () => {
  const metrics = calculateBookExecution({ bids: [{ price: 99, qty: 1 }], asks: [{ price: 101, qty: 1 }], targetNotionalUSD: 1_000 });
  assert.equal(metrics.buySlippagePct, Infinity);
  assert.equal(metrics.sellSlippagePct, Infinity);
});
