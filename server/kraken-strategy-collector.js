import { randomUUID } from "node:crypto";
import { TIMEFRAMES } from "../js/constants.js";
import { normalizeCandle, normalizeTicker, filterCryptoPerpetuals } from "../js/kraken.js";
import { calculateBookExecution } from "../js/order-book.js";
import { analyzeMarket, rankTurnover } from "../js/signals.js";
import { selectHighBetaUniverse, selectTradeUniverse } from "../js/trade-universe.js";
import { evaluateMomentumAcceptance, evaluateRelativeStrengthContinuation } from "../js/relative-strength.js";
import { evaluateHighBetaMomentum, HIGH_BETA_LIMITS } from "../js/high-beta.js";
import { buildAlertPayload, classifySignal, evaluateChase, hasOpposingBtcPrime } from "../js/strategy-engine.js";
import { buildSetupRecord } from "../js/setup-lifecycle.js";
import { evaluateSetupOutcome } from "../js/outcome-evaluator.js";
import { HIGH_BETA_STRATEGY_VERSION, strategyFlags } from "../js/strategy-config.js";
import { recordSentTradeAlert } from "./alert-repository.js";
import {
  highBetaDedupeKey,
  dueHighBetaOutcomes,
  invalidateUnseenHighBetaSetups,
  recordHighBetaSetup,
  saveHighBetaOutcome,
} from "./high-beta-repository.js";
import {
  acquireCollectorRunLock,
  dueOutcomes,
  invalidateUnseenSetups,
  openInterestChange,
  recordSetup,
  releaseCollectorRunLock,
  saveMarketSnapshot,
  saveOutcome,
} from "./setup-repository.js";

const KRAKEN_BASE = "https://futures.kraken.com";
const MINUTE = 60 * 1000;
const OUTCOME_BATCH_LIMIT = 3;
const HIGH_BETA_OUTCOME_BATCH_LIMIT = 2;

async function fetchJson(path, { fetchImpl = fetch, parameters = {}, timeout = 12_000 } = {}) {
  const url = new URL(path, KRAKEN_BASE);
  Object.entries(parameters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "crypto-dashboard-strategy-collector/1.1" } });
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

async function loadHighBetaMarketData(market, ticker, options) {
  const [payload, book] = await Promise.all([
    fetchJson(`/api/charts/v1/trade/${market.symbol}/1h`, { ...options, parameters: { count: 120 } }),
    fetchJson("/derivatives/api/v3/orderbook", { ...options, parameters: { symbol: market.symbol } }),
  ]);
  return {
    candles: (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start),
    ticker: { ...ticker, ...normalizeBook(book, market), receivedAt: options.observedAt, serverTime: options.observedAt },
  };
}

async function runPool(items, worker, concurrency = 5) {
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

async function persistCoreAlert(sql, alert, setup, observedAt) {
  if (!alert || !setup?.dedupe_key) return false;
  const saved = await recordSentTradeAlert(sql, {
    alertKey: `core:${setup.dedupe_key}`,
    symbol: alert.symbol,
    direction: alert.direction,
    score: alert.score,
    tradeQuality: alert.quality,
    setupFingerprint: setup.dedupe_key,
    payload: alert,
    sentAt: observedAt,
  });
  return Boolean(saved);
}

function highBetaAlertPayload(result, row, observedAt, chase) {
  const plan = result.plan;
  return {
    header: "⚡ HIGH-BETA MOMENTUM CALL",
    tier: "HIGH_BETA",
    riskClass: "0.05R",
    experimental: true,
    symbol: row.market.symbol,
    market: row.market.label || row.market.symbol,
    direction: result.direction,
    score: result.score,
    quality: result.tradeQuality,
    confidence: result.confidence,
    setupConfidence: result.setupConfidence,
    setupType: plan.type,
    entry: { low: Number(plan.entryLow), high: Number(plan.entryHigh), reference: Number(plan.entry) },
    stop: Number(plan.stop),
    target1: Number(plan.target1),
    target2: Number(plan.target2),
    rrTarget2: Number(chase?.effectiveRR2 ?? plan.rr2),
    trigger: plan.waitFor,
    triggerConfirmed: true,
    executionScore: result.executionScore,
    metrics: result.metrics,
    mainRisk: "High-beta perpetual: hogere wick-, slippage- en liquidation-risk; 0.05R is bewust klein.",
    observedAt,
  };
}

async function collectStrategySnapshotLocked({ sql, env, fetchImpl, now }) {
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
    const momentumAcceptance = flags.momentumAcceptanceEnabled ? evaluateMomentumAcceptance({
      direction,
      coinCandles: row.candlesByTimeframe["60"],
      atrValue: signal?.states?.["60"]?.atr14,
      volumeRatio: signal?.states?.["60"]?.volumeRatio,
      openInterestChangePct: oiChange,
      fundingPctPerHour: Number(row.ticker.fundingRatePrediction) * 100,
      executionScore: signal?.executionScore,
      targetRR2: 2.7,
      now,
    }) : null;
    const classification = classifySignal(signal, {
      symbol: row.market.symbol,
      btcSignal,
      currentPrice: row.ticker.lastPrice || row.ticker.markPrice,
      relativeStrength,
      momentumAcceptance,
      flags,
    });
    const record = buildSetupRecord({ signal, classification, ticker: row.ticker, market: row.market, observedAt: now });
    const seenDedupeKeys = [];
    if (record) {
      const saved = await recordSetup(sql, record);
      seenDedupeKeys.push(record.dedupeKey);
      setups.push({ id: saved.setup.id, symbol: record.symbol, tier: record.signalTier, triggerSource: classification.triggerSource, promoted: Boolean(saved.transition) });
      const alert = buildAlertPayload({ signal, classification, ticker: row.ticker, market: row.market, observedAt: now });
      if (alert && await persistCoreAlert(sql, alert, saved.setup, observedAt)) alerts.push(alert);
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

  const highBeta = await collectHighBetaLane({ sql, env, flags, markets, tickers, btcCandles, btcSignal, validStandard: valid, fetchImpl, now, observedAt });
  alerts.push(...highBeta.alerts);
  errors.push(...highBeta.errors);

  const outcomes = await evaluateDueStrategyOutcomes({ sql, fetchImpl, now });
  const highBetaOutcomes = await evaluateDueHighBetaOutcomes({ sql, fetchImpl, now });
  return {
    observedAt,
    scanned: valid.length,
    setups,
    alerts,
    outcomes,
    errors,
    flags,
    highBeta: { ...highBeta, outcomes: highBetaOutcomes },
  };
}

async function collectHighBetaLane({ sql, env, flags, markets, tickers, btcCandles, btcSignal, validStandard, fetchImpl, now, observedAt }) {
  if (!flags.highBetaSignalsEnabled) return { scanned: 0, setups: [], alerts: [], errors: [], universe: [] };
  const highBetaLimit = Math.max(1, Math.min(20, Number(env.HIGH_BETA_SCAN_LIMIT) || 20));
  const universe = selectHighBetaUniverse(markets, tickers, highBetaLimit);
  const standardMap = new Map(validStandard.map((row) => [row.market.symbol, row]));
  const loaded = await runPool(universe, async (market) => {
    const existing = standardMap.get(market.symbol);
    if (existing) return { market, ticker: existing.ticker, candles: existing.candlesByTimeframe["60"] };
    const ticker = tickers.get(market.symbol) || {};
    try {
      return { market, ...(await loadHighBetaMarketData(market, ticker, { fetchImpl, observedAt: now })) };
    } catch (error) {
      return { market, ticker, error: error.message };
    }
  }, 6);

  const valid = loaded.filter((row) => !row.error);
  const setups = [];
  const alerts = [];
  const errors = loaded.filter((row) => row.error).map((row) => ({ symbol: row.market.symbol, lane: "HIGH_BETA", error: row.error }));

  for (const row of valid) {
    const oiChange = await openInterestChange(sql, row.market.symbol, row.ticker.openInterest, observedAt);
    let result = evaluateHighBetaMomentum({
      symbol: row.market.symbol,
      market: row.market,
      ticker: row.ticker,
      coinCandles: row.candles,
      btcCandles,
      openInterestChangePct: oiChange,
      btcOpposingPrime: false,
      now,
    });
    const opposing = result.direction ? hasOpposingBtcPrime({ status: result.direction, bias: result.direction }, btcSignal) : false;
    if (opposing) result = { ...result, eligible: false, reasons: [...new Set([...(result.reasons || []), "Tegengestelde BTC PRIME is actief"])] };

    const seenDedupeKeys = [];
    if (result.plan && result.direction && result.score >= 55) {
      const chase = evaluateChase({
        direction: result.direction,
        currentPrice: row.ticker.lastPrice || row.ticker.markPrice,
        plan: result.plan,
        minimumRR2: HIGH_BETA_LIMITS.minRR2,
      });
      const alertEligible = result.eligible && !chase.blocked && chase.effectiveRR2 >= HIGH_BETA_LIMITS.minRR2;
      const status = alertEligible ? "ACTIVE" : chase.blocked ? "CHASE_BLOCKED" : "WATCH";
      const dedupeKey = highBetaDedupeKey({
        symbol: row.market.symbol,
        direction: result.direction,
        setupType: result.plan.type,
        breakoutLevel: result.metrics?.breakoutLevel,
        tickSize: row.market.tickSize,
      });
      const saved = await recordHighBetaSetup(sql, {
        observedAt,
        symbol: row.market.symbol,
        market: row.market.label || row.market.symbol,
        direction: result.direction,
        score: result.score,
        tradeQuality: result.tradeQuality,
        confidence: result.confidence,
        setupConfidence: result.setupConfidence,
        executionScore: result.executionScore,
        plan: result.plan,
        metrics: result.metrics,
        eligible: alertEligible,
        status,
        reasons: [...new Set([...(result.reasons || []), ...(chase.reasons || [])])],
        metadata: { chase, lane: "HIGH_BETA", btcOpposingPrime: opposing },
        dedupeKey,
        strategyVersion: HIGH_BETA_STRATEGY_VERSION,
      });
      seenDedupeKeys.push(dedupeKey);
      setups.push({ id: saved.id, symbol: row.market.symbol, score: result.score, eligible: alertEligible, status });
      if (alertEligible) {
        const payload = highBetaAlertPayload(result, row, observedAt, chase);
        const inserted = await recordSentTradeAlert(sql, {
          alertKey: `high-beta:${dedupeKey}`,
          symbol: row.market.symbol,
          direction: result.direction,
          score: result.score,
          tradeQuality: result.tradeQuality,
          setupFingerprint: dedupeKey,
          payload,
          sentAt: observedAt,
        });
        if (inserted) alerts.push(payload);
      }
    }
    await invalidateUnseenHighBetaSetups(sql, {
      symbol: row.market.symbol,
      seenDedupeKeys,
      observedAt,
      strategyVersion: HIGH_BETA_STRATEGY_VERSION,
    });
    await saveMarketSnapshot(sql, {
      symbol: row.market.symbol,
      observedAt,
      lastPrice: row.ticker.lastPrice || row.ticker.markPrice,
      openInterest: row.ticker.openInterest,
      fundingRate: row.ticker.fundingRatePrediction,
      volume24h: row.ticker.volumeQuote,
    });
  }
  return { scanned: valid.length, setups, alerts, errors, universe: universe.map((market) => market.symbol) };
}

export async function collectStrategySnapshot({ sql, env = process.env, fetchImpl = fetch, now = Date.now() } = {}) {
  const ownerToken = randomUUID();
  const observedAt = new Date(now).toISOString();
  if (!await acquireCollectorRunLock(sql, ownerToken)) {
    return {
      observedAt,
      skipped: true,
      reason: "COLLECTOR_ALREADY_RUNNING",
      scanned: 0,
      setups: [],
      alerts: [],
      outcomes: [],
      errors: [],
      flags: strategyFlags(env),
    };
  }
  try {
    return await collectStrategySnapshotLocked({ sql, env, fetchImpl, now });
  } finally {
    try {
      await releaseCollectorRunLock(sql, ownerToken);
    } catch (error) {
      console.warn("Strategy collector lock kon niet direct worden vrijgegeven", error);
    }
  }
}

async function fetchOutcomeCandles(setup, fetchImpl) {
  const createdAt = Date.parse(setup.created_at);
  const horizonEnd = createdAt + 24 * 60 * 60 * 1000;
  const from = Math.floor(createdAt / MINUTE) * MINUTE / 1000;
  const to = Math.ceil(horizonEnd / MINUTE) * MINUTE / 1000;
  const payload = await fetchJson(`/api/charts/v1/trade/${setup.symbol}/1m`, { fetchImpl, parameters: { from, to } });
  return (payload.candles || []).map(normalizeCandle).sort((a, b) => a.start - b.start);
}

export async function evaluateDueStrategyOutcomes({ sql, fetchImpl = fetch, now = Date.now() } = {}) {
  const due = await dueOutcomes(sql, now, OUTCOME_BATCH_LIMIT);
  const results = [];
  for (const setup of due) {
    try {
      const candles = await fetchOutcomeCandles(setup, fetchImpl);
      const outcome = evaluateSetupOutcome(setup, candles, { evaluatedAt: now, candleIntervalMs: MINUTE });
      if (outcome.dataComplete) await saveOutcome(sql, setup.id, outcome);
      results.push({ setupId: setup.id, symbol: setup.symbol, status: outcome.outcomeStatus });
    } catch (error) {
      results.push({ setupId: setup.id, symbol: setup.symbol, status: "ERROR", error: error.message });
    }
  }
  return results;
}

export async function evaluateDueHighBetaOutcomes({ sql, fetchImpl = fetch, now = Date.now() } = {}) {
  const due = await dueHighBetaOutcomes(sql, now, HIGH_BETA_OUTCOME_BATCH_LIMIT);
  const results = [];
  for (const setup of due) {
    try {
      const candles = await fetchOutcomeCandles(setup, fetchImpl);
      const outcome = evaluateSetupOutcome(setup, candles, { evaluatedAt: now, candleIntervalMs: MINUTE });
      if (outcome.dataComplete) await saveHighBetaOutcome(sql, setup.id, outcome);
      results.push({ setupId: setup.id, symbol: setup.symbol, status: outcome.outcomeStatus });
    } catch (error) {
      results.push({ setupId: setup.id, symbol: setup.symbol, status: "ERROR", error: error.message });
    }
  }
  return results;
}
