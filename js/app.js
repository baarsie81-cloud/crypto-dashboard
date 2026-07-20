import {
  MARKET_LIMITS,
  PRODUCTION_URL,
  SIGNAL_LIMITS,
  STORAGE_KEYS,
  TIMEFRAMES,
  TRADE_DEFAULTS,
} from "./constants.js";
import { SignalChart } from "./chart.js";
import { runBacktest } from "./backtest.js";
import { closedCandles, ema, lastFinite } from "./indicators.js";
import { KrakenClient, loadSnapshot, rankTopMarkets, runPool, saveSnapshot } from "./kraken.js";
import { analyzeMarket, rankTurnover } from "./signals.js";
import { ManualTradeAssistant } from "./trade-assistant.js";

if (location.hostname === "baarsie81-cloud.github.io") {
  location.replace(`${PRODUCTION_URL}${location.pathname.replace(/^\/crypto-dashboard/, "")}${location.search}${location.hash}`);
}

const client = new KrakenClient();
const state = {
  selectedSymbol: "PF_XBTUSD",
  interval: "60",
  markets: [],
  marketBySymbol: new Map(),
  topMarkets: [],
  tickers: new Map(),
  candles: {},
  signals: new Map(),
  eurUsd: NaN,
  lastUsefulAt: 0,
  lastHeartbeatAt: 0,
  connection: "connecting",
  source: "loading",
  loading: false,
  renderQueued: false,
  backtestCancelled: false,
  settings: {
    maxLeverage: SIGNAL_LIMITS.defaultMaxLeverage,
    budgetEUR: TRADE_DEFAULTS.budgetEUR,
    riskPct: TRADE_DEFAULTS.riskPct,
  },
  lastBoundaries: {},
};

const elements = {};
const byId = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const starSvg = `<svg class="star-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.72 5.5 6.08.88-4.4 4.29 1.04 6.06L12 16.87l-5.44 2.86 1.04-6.06-4.4-4.29 6.08-.88L12 3Z"/></svg>`;
const icons = {
  trend: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 17 6-6 4 4 8-9M15 6h6v6"/></svg>`,
  momentum: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 13h4l2-8 4 14 3-9 2 3h5"/></svg>`,
  volume: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20v-6h3v6H4Zm6 0V9h3v11h-3Zm6 0V4h3v16h-3Z"/></svg>`,
  volatility: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>`,
  chevron: `<svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`,
};

function cacheElements() {
  [
    "connectionStatus", "connectionLabel", "lastUpdated", "marketRegime", "bestSetup", "activeSignals", "dataQuality",
    "alertBanner", "watchlist", "watchlistTitle", "selectedPair", "mobilePrice", "mobileChange", "mobileStatus", "mobileScore",
    "signalChart", "ema20Value", "ema50Value", "chartTimestamp", "signalStatus", "signalScore", "consensus", "futuresContext",
    "tradePlan", "signalReasons", "setupsTable", "mobileSetups", "footerConnection", "settingsDialog", "maxLeverage",
    "infoDrawer", "runBacktest", "cancelBacktest", "backtestProgress", "backtestProgressBar", "backtestProgressText",
    "backtestResults", "refreshButton", "settingsButton", "saveSettings", "mobileInfoButton", "openInfoButton",
    "tradeBudget", "riskPercentage", "manualOrderContent", "journalRiskSummary", "openJournalButton",
    "journalDialog", "closeJournalButton", "journalSummary", "journalWarning", "journalList", "exportJournalButton",
    "importJournalButton", "journalImportFile", "marketDialog", "marketCount", "closeMarketButton", "marketSearchInput", "marketResults",
  ].forEach((id) => { elements[id] = byId(id); });
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  const digits = number < 0.001 ? 8 : number < 1 ? 5 : number < 100 ? 3 : 2;
  return number.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number)
    ? number.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "—";
}

function compactNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Intl.NumberFormat("nl-NL", { notation: "compact", maximumFractionDigits: 1 }).format(number) : "—";
}

function formatPct(value, digits = 2, signed = true) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${signed && number > 0 ? "+" : ""}${formatNumber(number, digits)}%`;
}

function formatFunding(value) {
  const percent = Number(value) * 100;
  return Number.isFinite(percent) ? formatPct(percent, 4) : "—";
}

function statusClass(status) {
  if (status === "LONG") return "long";
  if (status === "SHORT") return "short";
  if (status === "WATCH") return "watch";
  return "none";
}

function visibleStatus(signal) {
  if (!signal) return "GEEN TRADE";
  return signal.status === "WATCH" && signal.bias !== "NEUTRAAL" ? `${signal.bias} WATCH` : signal.status;
}

function setAlert(message = "") {
  elements.alertBanner.hidden = !message;
  elements.alertBanner.textContent = message;
}

function serializableMap(map) { return Object.fromEntries(map.entries()); }

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    const leverage = Number(parsed?.maxLeverage);
    const budget = Number(parsed?.budgetEUR);
    const riskPct = Number(parsed?.riskPct);
    if (leverage >= 2 && leverage <= 10) state.settings.maxLeverage = leverage;
    if (budget >= 1 && budget <= 100_000) state.settings.budgetEUR = budget;
    if (riskPct >= 0.1 && riskPct <= 100) state.settings.riskPct = riskPct;
  } catch { /* Defaults blijven actief. */ }
  elements.maxLeverage.value = String(state.settings.maxLeverage);
  elements.tradeBudget.value = String(state.settings.budgetEUR);
  elements.riskPercentage.value = String(state.settings.riskPct);
}

function applySnapshot(snapshot) {
  state.source = "cache";
  state.lastUsefulAt = Number(snapshot.savedAt) || 0;
  state.markets = Array.isArray(snapshot.markets) ? snapshot.markets : [];
  state.marketBySymbol = new Map(state.markets.map((market) => [market.symbol, market]));
  state.tickers = new Map(Object.entries(snapshot.tickers || {}));
  state.candles = snapshot.candles || {};
  state.topMarkets = (snapshot.topSymbols || []).map((symbol) => state.marketBySymbol.get(symbol)).filter(Boolean);
  if (!state.marketBySymbol.has(state.selectedSymbol)) state.selectedSymbol = state.topMarkets[0]?.symbol || state.markets[0]?.symbol || state.selectedSymbol;
  updateFx();
  evaluateSignals();
  renderAll();
  setAlert("Offlineweergave: de lokale Kraken-snapshot blijft zichtbaar, maar verouderde setups worden niet vrijgegeven.");
}

function persistSnapshot() {
  saveSnapshot({
    version: 2,
    savedAt: Date.now(),
    markets: state.markets,
    topSymbols: state.topMarkets.map((market) => market.symbol),
    tickers: serializableMap(state.tickers),
    candles: state.candles,
  });
}

function mergeTickers(rows) {
  rows.forEach((ticker) => {
    const current = state.tickers.get(ticker.symbol) || {};
    state.tickers.set(ticker.symbol, { ...current, ...ticker });
  });
  updateFx();
}

function updateFx() {
  const fx = state.tickers.get("PF_EURUSD");
  state.eurUsd = Number(fx?.indexPrice) || Number(fx?.markPrice) || Number(fx?.lastPrice) || NaN;
}

function symbolsToScan() {
  return [...new Set([...state.topMarkets.map((market) => market.symbol), state.selectedSymbol])].filter(Boolean);
}

function turnoverQualities() { return rankTurnover(state.tickers, symbolsToScan()); }

function evaluateSignals() {
  const quality = turnoverQualities();
  const next = new Map();
  symbolsToScan().forEach((symbol) => {
    const ticker = state.tickers.get(symbol) || {};
    const market = state.marketBySymbol.get(symbol) || {};
    next.set(symbol, analyzeMarket({
      symbol,
      candlesByTimeframe: state.candles[symbol] || {},
      ticker,
      instrument: market,
      turnoverQuality: quality.get(symbol) || 0,
      dataAgeMs: Date.now() - (Number(ticker.receivedAt) || 0),
      maxLeverage: state.settings.maxLeverage,
    }));
  });
  state.signals = next;
}

async function loadCandlesForMarkets(markets, { count = MARKET_LIMITS.scanHistory, intervals = Object.keys(TIMEFRAMES), showProgress = false } = {}) {
  const tasks = [];
  markets.forEach((market) => {
    state.candles[market.symbol] ||= {};
    intervals.forEach((interval) => tasks.push(async () => {
      try {
        const candles = await client.getCandles(market.symbol, interval, count);
        if (candles.length) state.candles[market.symbol][interval] = candles;
        state.candles[market.symbol].savedAt = Date.now();
      } catch (error) {
        if (!state.candles[market.symbol][interval]?.length) throw error;
      }
    }));
  });
  await runPool(tasks, 4, (done, total) => {
    if (showProgress) setAlert(`Gesloten Kraken-candles laden: ${done} van ${total}`);
  });
}

async function ensureSelectedHistory() {
  const market = state.marketBySymbol.get(state.selectedSymbol);
  if (!market) return;
  const hasFullHistory = Object.keys(TIMEFRAMES).every((interval) => (state.candles[market.symbol]?.[interval]?.length || 0) >= 200);
  if (hasFullHistory) return;
  setAlert(`${market.label} wordt volledig geanalyseerd…`);
  await loadCandlesForMarkets([market], { count: MARKET_LIMITS.chartHistory });
  evaluateSignals();
  renderAll();
  persistSnapshot();
  setAlert(availabilityMessage());
}

async function refreshUniverse({ showProgress = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  state.connection = "connecting";
  renderConnection();
  if (showProgress) setAlert("Kraken-instrumenten en tickers worden geladen…");
  try {
    const [markets, tickers] = await Promise.all([client.getInstruments(), client.getTickers()]);
    state.markets = markets;
    state.marketBySymbol = new Map(markets.map((market) => [market.symbol, market]));
    mergeTickers(tickers);
    state.topMarkets = rankTopMarkets(markets, state.tickers);
    if (!state.marketBySymbol.has(state.selectedSymbol)) state.selectedSymbol = state.marketBySymbol.has("PF_XBTUSD") ? "PF_XBTUSD" : state.topMarkets[0]?.symbol;
    state.source = "live";
    state.lastUsefulAt = Date.now();
    await loadCandlesForMarkets(state.topMarkets, { showProgress });
    await ensureSelectedHistory();
    state.connection = "live";
    evaluateSignals();
    renderAll();
    persistSnapshot();
    setAlert(availabilityMessage());
    connectRealtime();
  } catch (error) {
    state.connection = "offline";
    evaluateSignals();
    renderAll();
    const hasCache = Object.keys(state.candles).length > 0;
    setAlert(`${error.message}. ${hasCache ? "De snapshot blijft zichtbaar; verouderde signalen blijven geblokkeerd." : "Er is nog geen bruikbare Kraken-cache."}`);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
  }
}

function availabilityMessage() {
  if (!state.markets.length) return "Kraken leverde geen toegestane EEA-crypto-perpetuals. Controleer de publieke feed opnieuw.";
  if (!Number.isFinite(state.eurUsd)) return "Signalen werken, maar orderkaarten zijn geblokkeerd omdat de actuele PF_EURUSD-index ontbreekt.";
  return "";
}

function connectRealtime() {
  const symbols = [...symbolsToScan(), "PF_EURUSD"];
  client.connectPublic(symbols, {
    onStatus(status) {
      state.connection = status;
      renderConnection();
    },
    onHeartbeat(timestamp) {
      state.lastHeartbeatAt = timestamp;
      renderConnection();
    },
    onTicker(symbol, ticker) {
      mergeTickers([ticker]);
      state.lastUsefulAt = Date.now();
      state.source = "live";
      evaluateSignals();
      scheduleRender();
    },
  });
}

async function restFallback() {
  const selectedTicker = state.tickers.get(state.selectedSymbol);
  const stale = Date.now() - (Number(selectedTicker?.receivedAt) || 0) > SIGNAL_LIMITS.staleAfterMs;
  if (state.connection === "live" && !stale) return;
  try {
    mergeTickers(await client.getTickers());
    state.source = "REST fallback";
    state.lastUsefulAt = Date.now();
    evaluateSignals();
    renderAll();
  } catch { /* Volgende interval probeert opnieuw. */ }
}

async function refreshRanking() {
  try {
    const previous = new Set(state.topMarkets.map((market) => market.symbol));
    mergeTickers(await client.getTickers());
    state.topMarkets = rankTopMarkets(state.markets, state.tickers);
    const added = state.topMarkets.filter((market) => !previous.has(market.symbol));
    if (added.length) await loadCandlesForMarkets(added);
    evaluateSignals();
    renderAll();
    persistSnapshot();
    connectRealtime();
  } catch { /* De huidige rangschikking blijft bruikbaar. */ }
}

async function refreshClosedTimeframes() {
  const now = Date.now();
  for (const [interval, config] of Object.entries(TIMEFRAMES)) {
    const boundary = Math.floor(now / config.milliseconds);
    if (!state.lastBoundaries[interval]) {
      state.lastBoundaries[interval] = boundary;
      continue;
    }
    if (state.lastBoundaries[interval] === boundary) continue;
    state.lastBoundaries[interval] = boundary;
    try {
      await loadCandlesForMarkets(symbolsToScan().map((symbol) => state.marketBySymbol.get(symbol)).filter(Boolean), { intervals: [interval] });
      evaluateSignals();
      renderAll();
      persistSnapshot();
    } catch { /* REST fallback repareert de volgende ronde. */ }
  }
}

let chart;
let manualTradeAssistant;

function selectedContext() {
  return {
    market: state.marketBySymbol.get(state.selectedSymbol),
    signal: state.signals.get(state.selectedSymbol),
    ticker: state.tickers.get(state.selectedSymbol),
    eurUsd: state.eurUsd,
    budgetEUR: state.settings.budgetEUR,
    riskPct: state.settings.riskPct,
    maxLeverage: state.settings.maxLeverage,
  };
}

function renderConnection() {
  const ticker = state.tickers.get(state.selectedSymbol);
  const age = Date.now() - (Number(ticker?.receivedAt) || 0);
  const usable = age <= SIGNAL_LIMITS.staleAfterMs;
  const live = state.connection === "live" && usable;
  elements.connectionStatus.className = `connection ${live ? "" : state.connection === "connecting" ? "connection-loading" : "connection-offline"}`;
  elements.connectionLabel.textContent = live ? "LIVE" : state.connection === "connecting" ? "VERBINDEN" : usable ? "REST" : "OFFLINE";
  elements.footerConnection.textContent = elements.connectionLabel.textContent;
  elements.lastUpdated.textContent = ticker?.receivedAt
    ? new Date(ticker.receivedAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
}

function renderMarketStrip() {
  const actionable = state.topMarkets
    .map((market) => ({ market, signal: state.signals.get(market.symbol) }))
    .filter(({ signal }) => ["LONG", "SHORT"].includes(signal?.status));
  const best = [...actionable].sort((a, b) => b.signal.score - a.signal.score)[0];
  const btc = state.signals.get("PF_XBTUSD");
  const regime = btc?.timeframeBias?.["240"] || "NEUTRAAL";
  elements.marketRegime.textContent = regime === "LONG" ? "Opwaarts" : regime === "SHORT" ? "Neerwaarts" : "Neutraal";
  elements.marketRegime.className = regime === "SHORT" ? "bad" : regime === "NEUTRAAL" ? "warning" : "";
  elements.bestSetup.textContent = best ? `${best.market.base} ${best.signal.status} ${best.signal.score}` : "Geen vrijgave";
  elements.activeSignals.textContent = `${actionable.length} van ${state.topMarkets.length || 30}`;
  const freshCount = state.topMarkets.filter((market) => Date.now() - (Number(state.tickers.get(market.symbol)?.receivedAt) || 0) <= SIGNAL_LIMITS.staleAfterMs).length;
  elements.dataQuality.textContent = state.markets.length ? `${freshCount}/${state.topMarkets.length} actueel` : "Geen data";
  elements.dataQuality.className = freshCount === state.topMarkets.length && freshCount > 0 ? "" : freshCount ? "warning" : "bad";
}

function renderWatchlist() {
  elements.watchlistTitle.innerHTML = `Topmarkten <span>(${state.topMarkets.length})</span>`;
  elements.watchlist.innerHTML = state.topMarkets.map((market) => {
    const ticker = state.tickers.get(market.symbol) || {};
    const signal = state.signals.get(market.symbol);
    const change = Number(ticker.change24h);
    return `<button class="watchlist-row${market.symbol === state.selectedSymbol ? " selected" : ""}" type="button" data-symbol="${escapeHtml(market.symbol)}" role="listitem" aria-label="${escapeHtml(market.label)} selecteren">
      <span class="pair-cell">${starSvg}${escapeHtml(market.base)}</span>
      <span class="numeric-cell price-cell">${formatPrice(ticker.lastPrice || ticker.markPrice)}</span>
      <span class="numeric-cell change-cell ${change > 0 ? "positive" : change < 0 ? "negative" : "neutral"}">${formatPct(change)}</span>
      <i class="signal-dot ${statusClass(signal?.status)}" title="${escapeHtml(visibleStatus(signal))}"></i>
    </button>`;
  }).join("") || `<p class="empty-copy panel-empty">Kraken-markten worden geladen…</p>`;
}

function renderConsensus(signal) {
  const rows = [
    ["Trend", "trend", icons.trend], ["Momentum", "momentum", icons.momentum],
    ["Volume", "volume", icons.volume], ["Volatiliteit", "volatility", icons.volatility],
  ];
  elements.consensus.innerHTML = rows.map(([label, key, icon]) => {
    const value = Number(signal?.componentScores?.[key]) || 0;
    return `<div class="consensus-row"><span class="consensus-label">${icon}${label}</span><span class="consensus-bar"><i style="width:${value}%"></i></span><span class="consensus-value">${value}</span></div>`;
  }).join("");
}

function renderFuturesContext(ticker) {
  elements.futuresContext.innerHTML = `<h3>Futurescontext</h3><dl class="context-grid">
    <div><dt>Markprijs</dt><dd>$${formatPrice(ticker?.markPrice)}</dd></div>
    <div><dt>Indexprijs</dt><dd>$${formatPrice(ticker?.indexPrice)}</dd></div>
    <div><dt>Open interest</dt><dd>${compactNumber(ticker?.openInterest)}</dd></div>
    <div><dt>Funding nu</dt><dd>${formatFunding(ticker?.fundingRate)}</dd></div>
    <div><dt>Funding voorspeld</dt><dd>${formatFunding(ticker?.fundingRatePrediction)}</dd></div>
    <div><dt>Premium</dt><dd>${formatPct(ticker?.premiumPct, 3)}</dd></div>
  </dl>`;
}

function renderSelectedMarket() {
  const market = state.marketBySymbol.get(state.selectedSymbol);
  const ticker = state.tickers.get(state.selectedSymbol) || {};
  const signal = state.signals.get(state.selectedSymbol);
  if (!market) return;
  const status = visibleStatus(signal);
  const tone = statusClass(signal?.status);
  elements.selectedPair.textContent = market.label;
  elements.mobilePrice.textContent = `$${formatPrice(ticker.lastPrice || ticker.markPrice)}`;
  elements.mobileChange.textContent = formatPct(ticker.change24h);
  elements.mobileChange.className = Number(ticker.change24h) >= 0 ? "positive" : "negative";
  elements.mobileStatus.textContent = status;
  elements.mobileStatus.className = tone;
  elements.mobileScore.textContent = signal?.score ?? "—";
  elements.signalStatus.textContent = status;
  elements.signalStatus.className = tone;
  elements.signalScore.textContent = signal?.score ?? "—";
  renderConsensus(signal);
  renderFuturesContext(ticker);

  if (signal?.plan) {
    const plan = signal.plan;
    elements.tradePlan.innerHTML = `<h3>Tradeplan (1u)</h3><dl class="plan-list"><dt>Entryzone</dt><dd>$${formatPrice(plan.entryLow)} – $${formatPrice(plan.entryHigh)}</dd><dt>Stop</dt><dd class="stop-value">$${formatPrice(plan.stop)}</dd><dt>Doel 1</dt><dd>$${formatPrice(plan.target1)}</dd><dt>Doel 2</dt><dd>$${formatPrice(plan.target2)}</dd><dt>Leverageadvies</dt><dd class="plain-value">${plan.leverage ? `${plan.leverage}x isolated` : "Geen advies"}</dd></dl>`;
  } else {
    elements.tradePlan.innerHTML = `<h3>Tradeplan (1u)</h3><p class="empty-copy">Geen tradeplan zolang de setup niet minimaal WATCH is.</p>`;
  }
  elements.signalReasons.innerHTML = (signal?.reasons?.length ? signal.reasons : ["Onvoldoende gesloten candles of actuele futuresdata"])
    .map((reason) => `<li>${escapeHtml(reason)}</li>`).join("");

  const candles = closedCandles(state.candles[state.selectedSymbol]?.[state.interval] || [], TIMEFRAMES[state.interval].milliseconds);
  chart.update(candles, signal, state.interval);
  const closes = candles.map((candle) => candle.close);
  elements.ema20Value.textContent = formatPrice(lastFinite(ema(closes, 20)));
  elements.ema50Value.textContent = formatPrice(lastFinite(ema(closes, 50)));
  elements.chartTimestamp.textContent = candles.length
    ? `${candles.length} gesloten candles · laatste ${new Date(candles.at(-1).start).toLocaleString("nl-NL", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
    : "Candles laden…";
  manualTradeAssistant?.render();
}

function setupRow(market) {
  const signal = state.signals.get(market.symbol);
  const ticker = state.tickers.get(market.symbol) || {};
  const biases = signal?.timeframeBias || {};
  return `<tr data-symbol="${escapeHtml(market.symbol)}"><td><button class="table-market-button" type="button" data-symbol="${escapeHtml(market.symbol)}"><span class="table-pair">${starSvg}${escapeHtml(market.label)}</span></button></td><td class="status-${statusClass(biases["60"])}">${biases["60"] || "—"}</td><td class="status-${statusClass(biases["240"])}">${biases["240"] || "—"}</td><td class="status-${statusClass(biases.D)}">${biases.D || "—"}</td><td>${signal?.score ?? 0}</td><td>${formatFunding(ticker.fundingRatePrediction)}</td><td>${compactNumber(ticker.openInterest)}</td><td>${formatPct(signal?.spreadPct, 3, false)}</td><td class="status-${statusClass(signal?.status)} status-text">${escapeHtml(visibleStatus(signal))}</td></tr>`;
}

function renderSetups() {
  const ordered = [...state.topMarkets].sort((a, b) => (state.signals.get(b.symbol)?.score || 0) - (state.signals.get(a.symbol)?.score || 0));
  elements.setupsTable.innerHTML = ordered.map(setupRow).join("");
  elements.mobileSetups.innerHTML = ordered.map((market) => {
    const signal = state.signals.get(market.symbol);
    return `<button class="mobile-setup-row" type="button" data-symbol="${escapeHtml(market.symbol)}"><span class="table-pair">${starSvg}${escapeHtml(market.base)}</span><span class="status-${statusClass(signal?.status)} status-text">${escapeHtml(visibleStatus(signal))}</span><span class="setup-score">${signal?.score ?? 0}</span>${icons.chevron}</button>`;
  }).join("");
}

function renderMarketResults(query = "") {
  const needle = query.trim().toLocaleLowerCase("nl-NL");
  const topRank = new Map(state.topMarkets.map((market, index) => [market.symbol, index]));
  const matches = state.markets.filter((market) => !needle || `${market.base} ${market.label} ${market.category} ${market.symbol}`.toLocaleLowerCase("nl-NL").includes(needle))
    .sort((a, b) => (topRank.get(a.symbol) ?? 999) - (topRank.get(b.symbol) ?? 999)
      || (Number(state.tickers.get(b.symbol)?.volumeQuote) || 0) - (Number(state.tickers.get(a.symbol)?.volumeQuote) || 0));
  elements.marketCount.textContent = `${matches.length} van ${state.markets.length} toegestane EEA-crypto-perpetuals`;
  elements.marketResults.innerHTML = matches.map((market) => {
    const ticker = state.tickers.get(market.symbol) || {};
    const top = topRank.has(market.symbol) ? `Top ${topRank.get(market.symbol) + 1}` : "Op aanvraag";
    return `<button class="market-result${market.symbol === state.selectedSymbol ? " selected" : ""}" type="button" data-symbol="${escapeHtml(market.symbol)}"><span><strong>${escapeHtml(market.label)}</strong><small>${escapeHtml(market.symbol)} · ${escapeHtml(market.category)}</small></span><span><b>$${formatPrice(ticker.markPrice || ticker.lastPrice)}</b><small>${top} · OI ${compactNumber(ticker.openInterest)}</small></span></button>`;
  }).join("") || `<p class="empty-copy">Geen markt gevonden voor “${escapeHtml(query)}”.</p>`;
}

function renderAll() {
  renderConnection();
  renderMarketStrip();
  renderWatchlist();
  renderSelectedMarket();
  renderSetups();
  renderMarketResults(elements.marketSearchInput?.value || "");
}

function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => {
    state.renderQueued = false;
    renderAll();
  });
}

async function selectMarket(symbol) {
  if (!state.marketBySymbol.has(symbol)) return;
  state.selectedSymbol = symbol;
  renderAll();
  connectRealtime();
  try { await ensureSelectedHistory(); }
  catch (error) { setAlert(`${error.message}. Deze markt kan nog niet volledig worden geanalyseerd.`); }
}

function openInfoDrawer() {
  elements.settingsDialog.open && elements.settingsDialog.close();
  elements.infoDrawer.classList.add("open");
  elements.infoDrawer.setAttribute("aria-hidden", "false");
  elements.infoDrawer.querySelector(".drawer-content")?.focus();
}

function closeInfoDrawer() {
  elements.infoDrawer.classList.remove("open");
  elements.infoDrawer.setAttribute("aria-hidden", "true");
}

function renderBacktestResult(result, market) {
  const summary = result.summary;
  const profitFactor = summary.profitFactor === Infinity ? "∞" : formatNumber(summary.profitFactor, 2);
  elements.backtestResults.innerHTML = `<h4>${escapeHtml(market.label)} · 90 dagen</h4><div class="result-grid"><div><span>Setups</span><strong>${summary.total}</strong></div><div><span>Winst / verlies / time-out</span><strong>${summary.wins} / ${summary.losses} / ${summary.timeouts}</strong></div><div><span>Winrate</span><strong>${formatPct(summary.winRate, 2, false)}</strong></div><div><span>Gemiddelde R</span><strong>${formatNumber(summary.averageR, 2)}R</strong></div><div><span>Profit factor</span><strong>${profitFactor}</strong></div><div><span>Langste verliesreeks</span><strong>${summary.maxLosingStreak}</strong></div></div><p class="${summary.sufficientSample ? "result-note" : "sample-warning"}">${summary.sufficientSample ? "De steekproef bevat minimaal twintig trades, maar resultaten uit het verleden geven geen garantie." : "Onvoldoende steekproef: minder dan twintig trades."}</p><p class="result-note">Funding en spread zijn historisch meegenomen waar Kraken data leverde. Takerkosten: 0,05% per zijde.</p>`;
}

async function startBacktest() {
  const market = state.marketBySymbol.get(state.selectedSymbol);
  if (!market || state.loading) return;
  state.backtestCancelled = false;
  elements.runBacktest.disabled = true;
  elements.cancelBacktest.hidden = false;
  elements.backtestProgress.hidden = false;
  const progress = (percent, text) => {
    elements.backtestProgressBar.style.width = `${percent}%`;
    elements.backtestProgressText.textContent = text;
  };
  try {
    progress(10, `${market.label}: 1u-candles laden…`);
    const oneHour = await client.getHistory(market.symbol, "60", 95);
    if (state.backtestCancelled) return;
    progress(30, "4u- en 1d-context laden…");
    const [fourHour, daily] = await Promise.all([client.getHistory(market.symbol, "240", 150), client.getHistory(market.symbol, "D", 180)]);
    if (state.backtestCancelled) return;
    progress(60, "Historische funding en spread laden…");
    const [fundingSeries, spreadSeries] = await Promise.all([client.getFundingHistory(market.symbol), client.getSpreadHistory(market.symbol)]);
    if (state.backtestCancelled) return;
    progress(85, "Signalen zonder vooruitkijken doorrekenen…");
    const result = runBacktest({ symbol: market.symbol, candlesByTimeframe: { "60": oneHour, "240": fourHour, D: daily }, instrument: market, fundingSeries, spreadSeries });
    renderBacktestResult(result, market);
    localStorage.setItem(STORAGE_KEYS.backtest, JSON.stringify({ version: 2, savedAt: Date.now(), symbol: market.symbol, result }));
    progress(100, "Backtest afgerond.");
  } catch (error) {
    elements.backtestResults.innerHTML = `<p class="sample-warning">Backtest mislukt: ${escapeHtml(error.message)}.</p>`;
  } finally {
    elements.runBacktest.disabled = false;
    elements.cancelBacktest.hidden = true;
    state.backtestCancelled = false;
  }
}

function bindEvents() {
  elements.watchlist.addEventListener("click", (event) => selectMarket(event.target.closest("[data-symbol]")?.dataset.symbol));
  elements.setupsTable.addEventListener("click", (event) => selectMarket(event.target.closest("[data-symbol]")?.dataset.symbol));
  elements.mobileSetups.addEventListener("click", (event) => selectMarket(event.target.closest("[data-symbol]")?.dataset.symbol));
  document.querySelectorAll("[data-interval]").forEach((button) => button.addEventListener("click", () => {
    state.interval = button.dataset.interval;
    document.querySelectorAll("[data-interval]").forEach((tab) => {
      const active = tab.dataset.interval === state.interval;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    renderSelectedMarket();
  }));
  elements.refreshButton.addEventListener("click", () => refreshUniverse());
  elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
  elements.saveSettings.addEventListener("click", (event) => {
    event.preventDefault();
    const maxLeverage = Number(elements.maxLeverage.value);
    const budgetEUR = Number(elements.tradeBudget.value);
    const riskPct = Number(elements.riskPercentage.value);
    if (maxLeverage < 2 || maxLeverage > 10 || budgetEUR < 1 || riskPct < 0.1 || riskPct > 100) {
      setAlert("Controleer de leverage, het EUR-budget en het risicopercentage.");
      return;
    }
    state.settings = { maxLeverage, budgetEUR, riskPct };
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
    elements.settingsDialog.close();
    evaluateSignals();
    renderAll();
  });
  elements.mobileInfoButton.addEventListener("click", openInfoDrawer);
  elements.openInfoButton.addEventListener("click", openInfoDrawer);
  elements.infoDrawer.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closeInfoDrawer));
  document.querySelectorAll("[data-mobile-target]").forEach((button) => button.addEventListener("click", () => {
    byId(button.dataset.mobileTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll("[data-mobile-target]").forEach((item) => item.classList.toggle("active", item === button));
  }));
  document.querySelectorAll("[data-open-market-search]").forEach((button) => button.addEventListener("click", () => {
    renderMarketResults(elements.marketSearchInput.value);
    elements.marketDialog.showModal();
    requestAnimationFrame(() => elements.marketSearchInput.focus());
  }));
  elements.closeMarketButton.addEventListener("click", () => elements.marketDialog.close());
  elements.marketSearchInput.addEventListener("input", () => renderMarketResults(elements.marketSearchInput.value));
  elements.marketResults.addEventListener("click", (event) => {
    const symbol = event.target.closest("[data-symbol]")?.dataset.symbol;
    if (!symbol) return;
    elements.marketDialog.close();
    selectMarket(symbol);
  });
  elements.runBacktest.addEventListener("click", startBacktest);
  elements.cancelBacktest.addEventListener("click", () => { state.backtestCancelled = true; elements.backtestProgressText.textContent = "Stoppen na de huidige aanvraag…"; });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeInfoDrawer(); });
}

async function initialize() {
  cacheElements();
  chart = new SignalChart(elements.signalChart);
  loadSettings();
  manualTradeAssistant = new ManualTradeAssistant({ elements, getContext: selectedContext, notify: setAlert });
  bindEvents();
  const snapshot = loadSnapshot();
  if (snapshot) applySnapshot(snapshot);
  else renderAll();
  await refreshUniverse();
  setInterval(restFallback, MARKET_LIMITS.restFallbackMs);
  setInterval(refreshRanking, MARKET_LIMITS.rankingRefreshMs);
  setInterval(refreshClosedTimeframes, 30_000);
  setInterval(() => { evaluateSignals(); renderAll(); }, 15_000);
}

initialize();
