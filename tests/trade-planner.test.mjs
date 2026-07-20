import test from "node:test";
import assert from "node:assert/strict";
import { createJournalEntry, createManualTradePlan, floorToStep, journalSummary, normalizeJournal } from "../js/trade-planner.js";

const market = { symbol: "PF_XBTUSD", label: "BTC/USD Perp", base: "BTC", tickSize: 0.1, qtyStep: 0.0001, minQty: 0.0001, maxPositionSize: 10, maxLeverage: 10, tradeable: true, postOnly: false };
const ticker = { fundingRate: 0.0001, fundingRatePrediction: 0.0002, premiumPct: 0.1, suspended: false, postOnly: false };

function signal(overrides = {}) {
  return {
    symbol: "PF_XBTUSD", status: "LONG", score: 82, fresh: true, availability: true, postOnly: false,
    futuresContext: true, adverseFunding: false, adversePremium: false, higherTimeframeConfirmed: true, dailyOpposes: false,
    spreadPct: 0.05, reasons: ["4u trend bevestigt long", "Spread zeer laag"],
    timeframeBias: { "60": "LONG", "240": "LONG", D: "NEUTRAAL" },
    plan: { entry: 100.09, entryLow: 99.8, entryHigh: 100.2, stop: 98.09, target1: 103.09, target2: 105.09, leverage: 6 },
    ...overrides,
  };
}

const planFor = (signalValue = signal(), overrides = {}) => createManualTradePlan({ market, signal: signalValue, ticker, eurUsd: 1.15, budgetEUR: 20, riskPct: 10, maxLeverage: 10, ...overrides });

test("LONG-sizing blijft inclusief kosten en spread binnen de 10%-risicocap", () => {
  const plan = planFor();
  assert.equal(plan.eligible, true);
  assert.equal(plan.direction, "LONG");
  assert.equal(plan.riskBudgetEUR, 2);
  assert.ok(plan.maxPlannedLossEUR <= 2);
  assert.equal(plan.takerFeesUSD, plan.quantity * Math.max(plan.entry, plan.stop) * 0.001);
  assert.equal(plan.spreadCostUSD, plan.notionalUSD * 0.0005);
});

test("SHORT-sizing gebruikt dezelfde conservatieve risicocap", () => {
  const short = signal({ status: "SHORT", timeframeBias: { "60": "SHORT", "240": "SHORT", D: "NEUTRAAL" }, plan: { entry: 100.09, entryLow: 99.8, entryHigh: 100.2, stop: 102.09, target1: 97.09, target2: 95.09, leverage: 6 } });
  const plan = planFor(short);
  assert.equal(plan.eligible, true);
  assert.match(plan.instruction, /SHORT/);
  assert.ok(plan.maxPlannedLossEUR <= plan.riskBudgetEUR);
});

test("leverage wordt nooit hoger dan gebruikers- of Krakenlimiet", () => {
  const high = signal({ plan: { ...signal().plan, leverage: 25 } });
  assert.equal(planFor(high, { maxLeverage: 12 }).leverage, 10);
  assert.equal(planFor(signal({ plan: { ...signal().plan, leverage: 8 } }), { maxLeverage: 4 }).leverage, 4);
  assert.equal(planFor(high, { market: { ...market, maxLeverage: 3 } }).leverage, 3);
});

test("prijzen en contracten worden naar beneden op Kraken-precisie afgerond", () => {
  assert.equal(floorToStep(100.09, 0.1), 100);
  assert.equal(floorToStep(0.1234569, 0.0001), 0.1234);
  const plan = planFor();
  assert.equal(plan.entry, 100);
  assert.equal(Math.round(plan.quantity / market.qtyStep) * market.qtyStep, plan.quantity);
});

test("minimumcontract blokkeert een te kleine positie", () => {
  const plan = planFor(signal(), { market: { ...market, minQty: 5, qtyStep: 1 } });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /minimum/);
});

for (const [name, overrides] of [
  ["WATCH", { status: "WATCH" }], ["GEEN TRADE", { status: "GEEN TRADE", plan: null }],
  ["verouderde data", { fresh: false }], ["te hoge spread", { spreadPct: 0.151 }],
  ["negatieve spread", { spreadPct: -0.01 }], ["verdwenen markt", { availability: false }],
  ["post-only", { postOnly: true }], ["ontbrekende futurescontext", { futuresContext: false }],
]) {
  test(`${name} krijgt geen orderkaart`, () => assert.equal(planFor(signal(overrides)).eligible, false));
}

test("ontbrekende EUR/USD-index blokkeert alleen de orderkaart", () => {
  const plan = createManualTradePlan({ market, signal: signal(), ticker, eurUsd: NaN });
  assert.equal(plan.eligible, false);
  assert.match(plan.blockedReasons.join(" "), /EUR\/USD/);
});

test("funding wordt apart als uurindicatie berekend", () => {
  const long = planFor();
  const short = planFor(signal({ status: "SHORT", timeframeBias: { "60": "SHORT", "240": "SHORT", D: "NEUTRAAL" }, plan: { entry: 100, entryLow: 99.8, entryHigh: 100.2, stop: 102, target1: 97, target2: 95, leverage: 4 } }));
  assert.ok(long.fundingEffectUSDPerHour < 0);
  assert.ok(short.fundingEffectUSDPerHour > 0);
});

test("doelen splitsen alleen wanneer beide contractdelen het minimum halen", () => {
  const regular = planFor();
  assert.equal(regular.exits.mode, "50/50");
  const highMinimum = Math.floor(regular.quantity * 0.75 / market.qtyStep) * market.qtyStep;
  assert.equal(planFor(signal(), { market: { ...market, minQty: highMinimum } }).exits.mode, "100% doel 1");
});

test("Kraken-link bevat het exacte PF-symbool", () => {
  assert.equal(planFor().marketUrl, "https://futures.kraken.com/trade/futures/PF_XBTUSD");
});

test("versie-2-journal bewaart veilige velden en telt EUR-risico", () => {
  const first = createJournalEntry(planFor(), { id: "a", now: 1 });
  const second = createJournalEntry(planFor(), { id: "b", now: 2 });
  second.apiKey = "mag-niet-bewaard-worden";
  const normalized = normalizeJournal([first, second]);
  assert.equal(normalized[1].apiKey, undefined);
  assert.equal(journalSummary(normalized, 3).overRiskLimit, true);
});

test("journal mengt geen oude of vreemde data", () => {
  const valid = createJournalEntry(planFor(), { id: "valid", now: 1 });
  assert.deepEqual(normalizeJournal(null), []);
  assert.deepEqual(normalizeJournal([{ ...valid, version: 1 }, { ...valid, venue: "Anders" }]), []);
});

test("gesloten journalregel telt alleen mee in werkelijke EUR-PnL", () => {
  const entry = createJournalEntry(planFor(), { id: "closed", now: 1 });
  entry.status = "gesloten";
  entry.actualPnlEUR = 1.25;
  const summary = journalSummary([entry]);
  assert.equal(summary.activeCount, 0);
  assert.equal(summary.cumulativePlannedRiskEUR, 0);
  assert.equal(summary.closedPnlEUR, 1.25);
});
