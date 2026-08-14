import { TIMEFRAMES } from "../js/constants.js";
import { normalizeCandle, normalizeTicker, filterCryptoPerpetuals } from "../js/kraken.js";
import { calculateBookExecution } from "../js/order-book.js";
import { analyzeMarket, rankTurnover } from "../js/signals.js";
import { selectTradeUniverse } from "../js/trade-universe.js";
import { evaluateRelativeStrengthContinuation } from "../js/relative-strength.js";
import { buildAlertPayload, classifySignal } from "../js/strategy-engine.js";
import { buildSetupRecord } from "../js/setup-lifecycle.js";
import { evaluateSetupOutcome } from "../js/outcome-evaluator.js";
import { strategyFlags } from "../js/strategy-config.js";
import {
  dueOutcomes,
  invalidateUnseenSetups,
  openInterestChange,
  recordSetup,
  saveMarketSnapshot,
  saveOutcome,
} from "./setup-repository.js";

const KRAKEN_BASE = "https://futures.kraken.com";
async function fetchJson(path, { fetchImpl = fetch, parameters = {}, timeout = 12_000 } = {}) {
  const url = new URL(path, KRAKEN_BASE);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "crypto-dashboard-strategy-collector/1.0" } });
    if (!response.ok) throw new Error(`Kraken HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function normalizeRestTicker(row, observedAt) {
  const ticker = normalizeTicker(row, observedAt);
  ticker.volumeQuote = Number(row.volumeQuote) || (Number(ticker.volume24h) * Number(ticker.markPrice || ticker.lastPrice)) || 0;
  return ticker;
}

function normalizeBook(payload, market) {
  const book = payload?.orderBook || {};
  const bids = (book.bids || []).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })).filter((row) => row.price > 0 && row.qty > 0).sort((a, b) => b.price - a.price);
  const asks = (book.asks || []).map(([price, qty]) => ({ price: Number(price), qty: Number(qty) })).filter((row) => row.price > 0 && row.qty > 0).sort((a, b) => a.price - b.price);
  const metrics = calculateBookExecution({ bids, asks, contractSize: market.contractSize, targetNotionalUSD: 1000 });
  return metrics ? { ...metrics, bookValidated: true, bookTimestamp: Date.now() } : { bookValidated: false };
}

async function loadMarketData(market, ticker, options) {
  const requests = Object.entries(TIMEFRAMES).map(async ([interval, config]) => {
    const payload = await fetchJson(`/api/charts/v1/trade/${market.symbol}/${config.resolution}`, { ...options, parameters: { count: 120 } });
    return [interval, (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start)];
  });
  const bookRequest = fetchJson("/derivatives/api/v3/orderbook", { ...options, parameters: { symbol: market.symbol } });
  const [candleEntries, book] = await Promise.all([Promise.all(requests), bookRequest]);
  return {
    candlesByTimeframe: Object.fromEntries(candleEntries),
    ticker: { ...ticker, ...normalizeBook(book, market), receivedAt: options.observedAt, serverTime: options.observedAt },
  };
}

async function runPool(items, worker, concurrency = 4) {
  let cursor = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

export async function collectStrategySnapshot({ sql, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const flags = strategyFlags(env);
  const observedAt = new Date(now).toISOString();
  const [instrumentPayload, tickerPayload] = await Promise.all([
    fetchJson("/derivatives/api/v3/instruments", { fetchImpl }),
    fetchJson("/derivatives/api/v3/tickers", { fetchImpl }),
  ]);
  const markets = filterCryptoPerpetuals(instrumentPayload.instruments || []);
  const tickers = new Map((tickerPayload.tickers || []).map((row) => {
    const ticker = normalizeRestTicker(row, now);
    return [ticker.symbol, ticker];
  }));
  const limit = Math.max(2, Math.min(15, Number(env.STRATEGY_SCAN_LIMIT) || 15));
  const universe = selectTradeUniverse(markets, tickers, limit);
  const loaded = await runPool(universe, async (market) => {
    const ticker = tickers.get(market.symbol) || {};
    try {
      return { market, ...(await loadMarketData(market, ticker, { fetchImpl, observedAt: now })) };
    } catch (error) {
      return { market, ticker, error: error.message };
    }
  });
  const valid = loaded.filter((row) => !row.error);
  const enrichedTickers = new Map(valid.map((row) => [row.market.symbol, row.ticker]));
  const turnover = rankTurnover(enrichedTickers, valid.map((row) => row.market.symbol));
  const technical = new Map(valid.map((row) => [row.market.symbol, analyzeMarket({
    symbol: row.market.symbol,
    candlesByTimeframe: row.candlesByTimeframe,
    ticker: row.ticker,
    instrument: row.market,
    turnoverQuality: turnover.get(row.market.symbol) || 0,
    dataAgeMs: 0,
  })]));
  const btcSignal = technical.get("PF_XBTUSD") || null;
  const btcCandles = valid.find((row) => row.market.symbol === "PF_XBTUSD")?.candlesByTimeframe?.["60"] || [];
  const alerts = [];
  const setups = [];
  const errors = loaded.filter((row) => row.error).map((row) => ({ symbol: row.market.symbol, error: row.error }));

  for (const row of valid) {
    const signal = technical.get(row.market.symbol);
    const oiChange = await openInterestChange(sql, row.market.symbol, row.ticker.openInterest, observedAt);
    const direction = signal?.status === "LONG" || signal?.status === "SHORT" ? signal.status : signal?.bias;
    const relativeStrength = row.market.symbol === "PF_XBTUSD" || row.market.symbol === "PF_ETHUSD" ? null : evaluateRelativeStrengthContinuation({
      symbol: row.market.symbol,
      direction,
      coinCandles: row.candlesByTimeframe["60"],
      btcCandles,
      atrValue: signal?.states?.["60"]?.atr14,
      volumeRatio: signal?.states?.["60"]?.volumeRatio,
      openInterestChangePct: oiChange,
      fundingPctPerHour: Number(row.ticker.fundingRatePrediction) * 100,
      executionScore: signal?.executionScore,
      btcOpposingPrime: false,
      now,
    });
    const classification = classifySignal(signal, {
      symbol: row.market.symbol,
      btcSignal,
      currentPrice: row.ticker.lastPrice || row.ticker.markPrice,
      relativeStrength,
      flags,
    });
    const record = buildSetupRecord({ signal, classification, ticker: row.ticker, market: row.market, observedAt: now });
    const seenDedupeKeys = [];
    if (record) {
      const saved = await recordSetup(sql, record);
      seenDedupeKeys.push(record.dedupeKey);
      setups.push({ id: saved.setup.id, symbol: record.symbol, tier: record.signalTier, promoted: Boolean(saved.transition) });
      const alert = buildAlertPayload({ signal, classification, ticker: row.ticker, market: row.market, observedAt: now });
      if (alert) alerts.push(alert);
    }
    await invalidateUnseenSetups(sql, { symbol: row.market.symbol, seenDedupeKeys, observedAt });
    await saveMarketSnapshot(sql, {
      symbol: row.market.symbol,
      observedAt,
      lastPrice: row.ticker.lastPrice || row.ticker.markPrice,
      openInterest: row.ticker.openInterest,
      fundingRate: row.ticker.fundingRatePrediction,
      volume24h: row.ticker.volumeQuote,
    });
  }

  const outcomes = await evaluateDueStrategyOutcomes({ sql, fetchImpl, now });
  return { observedAt, scanned: valid.length, setups, alerts, outcomes, errors, flags };
}

export async function evaluateDueStrategyOutcomes({ sql, fetchImpl = fetch, now = Date.now() } = {}) {
  const due = await dueOutcomes(sql, now, 25);
  const results = [];
  for (const setup of due) {
    try {
      const from = Math.floor(Date.parse(setup.created_at) / 1000);
      const to = Math.ceil((Date.parse(setup.created_at) + 24 * 60 * 60 * 1000) / 1000);
      const payload = await fetchJson(`/api/charts/v1/trade/${setup.symbol}/1h`, { fetchImpl, parameters: { from, to } });
      const candles = (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start);
      const outcome = evaluateSetupOutcome(setup, candles, { evaluatedAt: now });
      if (outcome.outcomeStatus !== "OPEN") await saveOutcome(sql, setup.id, outcome);
      results.push({ setupId: setup.id, symbol: setup.symbol, status: outcome.outcomeStatus });
    } catch (error) {
      results.push({ setupId: setup.id, symbol: setup.symbol, status: "ERROR", error: error.message });
    }
  }
  return results;
}
