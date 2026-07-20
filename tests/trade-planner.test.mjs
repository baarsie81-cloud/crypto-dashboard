import test from "node:test";
import assert from "node:assert/strict";
import {
  createJournalEntry,
  createManualTradePlan,
  floorToStep,
  journalSummary,
  normalizeJournal,
} from "../js/trade-planner.js";
import { CORE_PAIRS } from "../js/constants.js";

const pair = { symbol: "BTCUSDC", label: "BTC/USDC", base: "BTC" };
const instrument = {
  symbol: "BTCUSDC",
  status: "Trading",
  marginTrading: "utaOnly",
  priceFilter: { tickSize: "0.1" },
  lotSizeFilter: { basePrecision: "0.000001", minOrderQty: "0.000001", minOrderAmt: "1", maxLimitOrderQty: "10" },
};

function signal(overrides = {}) {
  return {
    symbol: "BTCUSDC",
    status: "LONG",
    score: 82,
    fresh: true,
    availability: true,
    higherTimeframeConfirmed: true,
    dailyOpposes: false,
    spreadPct: 0.05,
    reasons: ["4u trend bevestigt long", "Spread zeer laag"],
    timeframeBias: { "60": "LONG", "240": "LONG", D: "NEUTRAAL" },
    plan: { entry: 100.09, entryLow: 99.8, entryHigh: 100.2, stop: 98.09, target1: 103.09, target2: 105.09, leverage: 6 },
    ...overrides,
  };
}

test("LONG-positie blijft inclusief kosten en spread binnen de 10%-risicocap", () => {
  const plan = createManualTradePlan({ pair, signal: signal(), instrument, budgetUSDC: 20, riskPct: 10, maxLeverage: 10 });
  assert.equal(plan.eligible, true);
  assert.equal(plan.direction, "LONG");
  assert.equal(plan.riskBudget, 2);
  assert.ok(plan.maxPlannedLoss <= 2);
  assert.equal(plan.tradingFees, plan.quantity * Math.max(plan.entry, plan.stop) * 0.005);
  assert.equal(plan.spreadCost, plan.notional * 0.0005);
});

test("SHORT-position sizing gebruikt dezelfde conservatieve risicocap", () => {
  const shortSignal = signal({
    status: "SHORT",
    timeframeBias: { "60": "SHORT", "240": "SHORT", D: "NEUTRAAL" },
    plan: { entry: 100.09, entryLow: 99.8, entryHigh: 100.2, stop: 102.09, target1: 97.09, target2: 95.09, leverage: 6 },
  });
  const plan = createManualTradePlan({ pair, signal: shortSignal, instrument });
  assert.equal(plan.eligible, true);
  assert.equal(plan.direction, "SHORT");
  assert.match(plan.instruction, /Leen BTC/);
  assert.ok(plan.maxPlannedLoss <= plan.riskBudget);
});

test("leverage wordt nooit hoger dan 10x of de gebruikerslimiet", () => {
  const ten = createManualTradePlan({ pair, signal: signal({ plan: { ...signal().plan, leverage: 25 } }), instrument, maxLeverage: 12 });
  const four = createManualTradePlan({ pair, signal: signal({ plan: { ...signal().plan, leverage: 8 } }), instrument, maxLeverage: 4 });
  assert.equal(ten.leverage, 10);
  assert.equal(four.leverage, 4);
});

test("prijzen en hoeveelheden worden naar beneden op Bybit-stappen afgerond", () => {
  assert.equal(floorToStep(100.09, 0.1), 100);
  assert.equal(floorToStep(0.1234569, 0.000001), 0.123456);
  const plan = createManualTradePlan({ pair, signal: signal(), instrument });
  assert.equal(plan.entry, 100);
  assert.equal(plan.quantity % 0.000001 < 1e-12, true);
});

test("minimumorder blokkeert een te kleine berekende positie", () => {
  const strictInstrument = { ...instrument, lotSizeFilter: { ...instrument.lotSizeFilter, minOrderAmt: "1000" } };
  const plan = createManualTradePlan({ pair, signal: signal(), instrument: strictInstrument });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /minimum/);
});

for (const [name, overrides] of [
  ["WATCH", { status: "WATCH" }],
  ["GEEN TRADE", { status: "GEEN TRADE", plan: null }],
  ["verouderde data", { fresh: false }],
  ["te hoge spread", { spreadPct: 0.151 }],
  ["ongeldige negatieve spread", { spreadPct: -0.01 }],
  ["verdwenen marginstatus", { availability: false }],
]) {
  test(`${name} krijgt geen orderkaart`, () => {
    const plan = createManualTradePlan({ pair, signal: signal(overrides), instrument });
    assert.equal(plan.eligible, false);
  });
}

test("doelen worden alleen 50/50 verdeeld wanneer beide delen het minimum halen", () => {
  const split = createManualTradePlan({ pair, signal: signal(), instrument });
  const oneTarget = createManualTradePlan({
    pair,
    signal: signal(),
    instrument: { ...instrument, lotSizeFilter: { ...instrument.lotSizeFilter, minOrderAmt: "75" } },
  });
  assert.equal(split.exits.mode, "50/50");
  assert.equal(oneTarget.exits.mode, "100% doel 1");
});

test("journal bewaart alleen veilige velden en telt risico van niet-gesloten trades op", () => {
  const plan = createManualTradePlan({ pair, signal: signal(), instrument });
  const first = createJournalEntry(plan, { id: "a", now: 1 });
  const second = createJournalEntry(plan, { id: "b", now: 2 });
  second.apiKey = "mag-niet-bewaard-worden";
  const normalized = normalizeJournal([first, second]);
  assert.equal(normalized[1].apiKey, undefined);
  const summary = journalSummary(normalized, 3);
  assert.equal(summary.activeCount, 2);
  assert.equal(summary.overRiskLimit, true);
});

test("gesloten journalregels tellen niet mee als actief risico", () => {
  const plan = createManualTradePlan({ pair, signal: signal(), instrument });
  const entry = createJournalEntry(plan, { id: "closed", now: 1 });
  entry.status = "gesloten";
  entry.actualPnl = 1.25;
  const summary = journalSummary([entry]);
  assert.equal(summary.activeCount, 0);
  assert.equal(summary.cumulativePlannedRisk, 0);
  assert.equal(summary.closedPnl, 1.25);
});

test("corrupte of lege journaldata levert veilig een lege lijst", () => {
  assert.deepEqual(normalizeJournal(null), []);
  assert.deepEqual(normalizeJournal({ nope: true }), []);
  assert.deepEqual(normalizeJournal([null, { id: "x" }]), []);
});

test("alle acht paren krijgen de juiste handmatige Bybit EU-spotlink", () => {
  CORE_PAIRS.forEach((corePair) => {
    const symbolSignal = signal({ symbol: corePair.symbol });
    const symbolInstrument = { ...instrument, symbol: corePair.symbol, baseCoin: corePair.base };
    const plan = createManualTradePlan({ pair: corePair, signal: symbolSignal, instrument: symbolInstrument });
    assert.equal(plan.bybitUrl, `https://www.bybit.eu/trade/spot/${corePair.base}/USDC`);
  });
});
