import { CORE_PAIRS, SIGNAL_LIMITS, STORAGE_KEYS, TIMEFRAMES, TRADE_DEFAULTS } from "./constants.js";
import { BybitClient, loadSnapshot, saveSnapshot } from "./bybit.js";
import { SignalChart } from "./chart.js";
import { combineBacktests, runBacktest } from "./backtest.js";
import { closedCandles } from "./indicators.js";
import { analyzeMarket, rankTurnover } from "./signals.js";
import { ManualTradeAssistant } from "./trade-assistant.js";

const client = new BybitClient();
const pairBySymbol = new Map(CORE_PAIRS.map((pair) => [pair.symbol, pair]));
const state = {
  selectedSymbol: CORE_PAIRS[0].symbol,
  interval: "60",
  instruments: new Map(),
  tickers: new Map(),
  candles: {},
  signals: new Map(),
  lastLiveAt: 0,
  lastHeartbeatAt: 0,
  source: "loading",
  connection: "connecting",
  loading: false,
  settings: {
    maxLeverage: SIGNAL_LIMITS.defaultMaxLeverage,
    budgetUSDC: TRADE_DEFAULTS.budgetUSDC,
    riskPct: TRADE_DEFAULTS.riskPct,
  },
  backtestCancelled: false,
};

const elements = {};
const byId = (id) => document.getElementById(id);
const starSvg = (selected = false) => `<svg class="star-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.72 5.5 6.08.88-4.4 4.29 1.04 6.06L12 16.87l-5.44 2.86 1.04-6.06-4.4-4.29 6.08-.88L12 3Z"${selected ? "" : ""}/></svg>`;
const trendSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m3 17 6-6 4 4 8-9M15 6h6v6"/></svg>`;
const momentumSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 13h4l2-8 4 14 3-9 2 3h5"/></svg>`;
const volumeSvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20v-6h3v6H4Zm6 0V9h3v11h-3Zm6 0V4h3v16h-3Z"/></svg>`;
const volatilitySvg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></svg>`;
const chevronSvg = `<svg class="row-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>`;

function cacheElements() {
  [
    "connectionStatus", "connectionLabel", "lastUpdated", "marketRegime", "bestSetup", "activeSignals", "dataQuality",
    "alertBanner", "watchlist", "selectedPair", "mobilePrice", "mobileChange", "mobileStatus", "mobileScore",
    "signalChart", "ema20Value", "ema50Value", "chartTimestamp", "signalStatus", "signalScore", "consensus",
    "tradePlan", "signalReasons", "setupsTable", "mobileSetups", "footerConnection", "settingsDialog", "maxLeverage",
    "infoDrawer", "runBacktest", "cancelBacktest", "backtestProgress", "backtestProgressBar", "backtestProgressText",
    "backtestResults", "refreshButton", "settingsButton", "saveSettings", "mobileInfoButton", "openInfoButton",
    "tradeBudget", "riskPercentage", "manualOrderContent", "journalRiskSummary", "openJournalButton",
    "journalDialog", "closeJournalButton", "journalSummary", "journalWarning", "journalList", "exportJournalButton",
    "importJournalButton", "journalImportFile",
  ].forEach((id) => { elements[id] = byId(id); });
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "—";
  const digits = number < 0.001 ? 8 : number < 1 ? 5 : number < 100 ? 3 : 2;
  return number.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatPct(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  const sign = number > 0 ? "+" : "";
  return `${sign}${number.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}

function priceChangePct(ticker) {
  return (Number(ticker?.price24hPcnt) || 0) * 100;
}

function statusClass(status) {
  if (status === "LONG") return "long";
  if (status === "SHORT") return "short";
  if (status === "WATCH") return "watch";
  return "none";
}

function visibleStatus(signal) {
  if (!signal) return "GEEN TRADE";
  if (signal.status === "WATCH" && signal.bias !== "NEUTRAAL") return `${signal.bias} WATCH`;
  return signal.status;
}

function setAlert(message = "") {
  elements.alertBanner.hidden = !message;
  elements.alertBanner.textContent = message;
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings));
    const leverage = Number(parsed?.maxLeverage);
    if (leverage >= 2 && leverage <= 10) state.settings.maxLeverage = leverage;
    const budget = Number(parsed?.budgetUSDC);
    if (budget >= 1 && budget <= 100_000) state.settings.budgetUSDC = budget;
    const riskPct = Number(parsed?.riskPct);
    if (riskPct >= 0.1 && riskPct <= 100) state.settings.riskPct = riskPct;
  } catch {
    // Defaults remain active.
  }
  elements.maxLeverage.value = String(state.settings.maxLeverage);
  elements.tradeBudget.value = String(state.settings.budgetUSDC);
  elements.riskPercentage.value = String(state.settings.riskPct);
}

function applySnapshot(snapshot) {
  state.source = "cache";
  state.lastLiveAt = Number(snapshot.savedAt) || 0;
  state.instruments = new Map(Object.entries(snapshot.instruments || {}));
  state.tickers = new Map(Object.entries(snapshot.tickers || {}));
  state.candles = snapshot.candles || {};
  evaluateSignals();
  renderAll();
  setAlert("Tijdelijke offlineweergave: dit is de laatste lokale snapshot. Er worden geen tradesignalen vrijgegeven totdat live data terug is.");
}

function serializableMap(map) {
  return Object.fromEntries(map.entries());
}

function persistSnapshot() {
  saveSnapshot({
    savedAt: Date.now(),
    instruments: serializableMap(state.instruments),
    tickers: serializableMap(state.tickers),
    candles: state.candles,
  });
}

async function runPool(tasks, concurrency, onProgress) {
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor;
      cursor += 1;
      await tasks[index]();
      completed += 1;
      onProgress?.(completed, tasks.length);
    }
  });
  await Promise.all(workers);
}

async function refreshMarketData({ showProgress = true } = {}) {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  state.connection = "connecting";
  renderConnection();
  if (showProgress) setAlert("Bybit EU-instrumenten, tickers en gesloten candles worden geladen…");
  try {
    const [instrumentResponse, tickerResponse] = await Promise.all([client.getInstruments(), client.getTickers()]);
    state.instruments = new Map(instrumentResponse.list.map((instrument) => [instrument.symbol, instrument]));
    state.tickers = new Map(tickerResponse.list.map((ticker) => [ticker.symbol, ticker]));
    state.lastLiveAt = Date.now();
    state.source = "live";

    const orderedPairs = [
      pairBySymbol.get(state.selectedSymbol),
      ...CORE_PAIRS.filter((pair) => pair.symbol !== state.selectedSymbol),
    ];
    const tasks = [];
    orderedPairs.forEach((pair) => {
      state.candles[pair.symbol] ||= {};
      Object.keys(TIMEFRAMES).forEach((interval) => {
        tasks.push(async () => {
          try {
            state.candles[pair.symbol][interval] = await client.getKlines(pair.symbol, interval);
            if (pair.symbol === state.selectedSymbol) renderSelectedMarket();
          } catch (error) {
            if (!state.candles[pair.symbol][interval]?.length) throw error;
          }
        });
      });
    });
    await runPool(tasks, 4, (completed, total) => {
      if (showProgress) setAlert(`Gesloten candles laden: ${completed} van ${total}`);
    });
    state.connection = "live";
    evaluateSignals();
    renderAll();
    persistSnapshot();
    setAlert(availabilityWarning());
    connectRealtime();
  } catch (error) {
    state.connection = "offline";
    evaluateSignals();
    renderAll();
    const hasCache = Object.keys(state.candles).length > 0;
    setAlert(`${error.message}. ${hasCache ? "De laatste snapshot blijft zichtbaar, maar alle signalen zijn geblokkeerd." : "Er is nog geen bruikbare snapshot."}`);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
  }
}

function availabilityWarning() {
  const unavailable = CORE_PAIRS.filter((pair) => {
    const instrument = state.instruments.get(pair.symbol);
    return !instrument || instrument.status !== "Trading" || instrument.marginTrading === "none";
  });
  if (!unavailable.length) return "";
  return `Bybit EU meldt momenteel geen publieke marginbeschikbaarheid voor: ${unavailable.map((pair) => pair.base).join(", ")}. Deze markten krijgen GEEN TRADE.`;
}

function connectRealtime() {
  client.connectPublic(CORE_PAIRS.map((pair) => pair.symbol), {
    onStatus(status) {
      state.connection = status;
      if (status === "live") state.lastHeartbeatAt = Date.now();
      renderConnection();
    },
    onHeartbeat(timestamp) {
      state.lastHeartbeatAt = timestamp;
      if (state.connection === "live") state.lastLiveAt = timestamp;
    },
    onTicker(symbol, update) {
      const current = state.tickers.get(symbol) || {};
      state.tickers.set(symbol, { ...current, ...update });
      state.lastLiveAt = Date.now();
      evaluateSignals();
      scheduleRender();
    },
    async onKline(symbol, kline) {
      if (!kline.confirm) return;
      try {
        state.candles[symbol]["60"] = await client.getKlines(symbol, "60");
        state.lastLiveAt = Date.now();
        evaluateSignals();
        renderAll();
        persistSnapshot();
      } catch {
        // The next periodic refresh repairs a missed closed candle.
      }
    },
  });
}

let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderHeaderStats();
    renderWatchlist();
    renderSelectedMarket();
    renderSetups();
  });
}

function evaluateSignals() {
  const turnoverRanks = rankTurnover(state.tickers, CORE_PAIRS.map((pair) => pair.symbol));
  const dataAgeMs = state.source === "live" ? Date.now() - state.lastLiveAt : Number.MAX_SAFE_INTEGER;
  const nextSignals = new Map();
  CORE_PAIRS.forEach((pair) => {
    nextSignals.set(pair.symbol, analyzeMarket({
      symbol: pair.symbol,
      candlesByTimeframe: state.candles[pair.symbol] || {},
      ticker: state.tickers.get(pair.symbol) || {},
      instrument: state.instruments.get(pair.symbol) || { status: "Unavailable", marginTrading: "none" },
      turnoverQuality: turnoverRanks.get(pair.symbol) || 0,
      dataAgeMs,
      maxLeverage: state.settings.maxLeverage,
    }));
  });
  state.signals = nextSignals;
}

function renderConnection() {
  const className = state.connection === "live" ? "connection" : state.connection === "offline" ? "connection connection-offline" : "connection connection-loading";
  elements.connectionStatus.className = className;
  elements.connectionLabel.textContent = state.connection === "live" ? "LIVE" : state.connection === "offline" ? "OFFLINE" : "VERBINDEN";
  elements.footerConnection.textContent = state.connection === "live" ? "LIVE" : "OFFLINE";
  elements.footerConnection.className = state.connection === "live" ? "positive" : "negative";
}

function renderHeaderStats() {
  const active = [...state.signals.values()].filter((signal) => signal.status === "LONG" || signal.status === "SHORT");
  const ranked = [...state.signals.values()].filter((signal) => signal.status !== "GEEN TRADE").sort((a, b) => b.score - a.score);
  const best = ranked[0];
  const btc = state.signals.get("BTCUSDC");
  const bullish = btc?.timeframeBias?.["240"] === "LONG";
  const bearish = btc?.timeframeBias?.["240"] === "SHORT";
  elements.marketRegime.textContent = bullish ? "Licht bullish" : bearish ? "Licht bearish" : "Neutraal / gemengd";
  elements.marketRegime.className = bearish ? "bad" : bullish ? "" : "warning";
  elements.bestSetup.textContent = best ? `${pairBySymbol.get(best.symbol).label} (${visibleStatus(best)})` : "Geen setup";
  elements.activeSignals.textContent = `${active.length} van 8`;
  const fresh = state.source === "live" && Date.now() - state.lastLiveAt <= SIGNAL_LIMITS.staleAfterMs;
  elements.dataQuality.textContent = fresh ? "Hoog ●" : state.source === "cache" ? "Snapshot" : "Verouderd";
  elements.dataQuality.className = fresh ? "" : "warning";
  elements.lastUpdated.textContent = state.lastLiveAt
    ? new Date(state.lastLiveAt).toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
}

function renderWatchlist() {
  elements.watchlist.innerHTML = CORE_PAIRS.map((pair) => {
    const ticker = state.tickers.get(pair.symbol);
    const signal = state.signals.get(pair.symbol);
    const change = priceChangePct(ticker);
    const selected = pair.symbol === state.selectedSymbol;
    return `<button type="button" class="watchlist-row${selected ? " selected" : ""}" data-symbol="${pair.symbol}" role="listitem" aria-pressed="${selected}">
      <span class="pair-cell">${starSvg(selected)}${pair.label}</span>
      <span class="numeric-cell price-cell">${formatPrice(ticker?.lastPrice)}</span>
      <span class="numeric-cell change-cell ${change > 0 ? "positive" : change < 0 ? "negative" : "neutral"}">${formatPct(change)}</span>
      <i class="signal-dot ${statusClass(signal?.status)}" title="${signal?.status || "Geen data"}"></i>
    </button>`;
  }).join("");
  elements.watchlist.querySelectorAll("[data-symbol]").forEach((button) => {
    button.addEventListener("click", () => selectSymbol(button.dataset.symbol));
  });
}

function renderConsensus(signal) {
  const values = signal?.componentScores || { trend: 0, momentum: 0, volume: 0, volatility: 0 };
  const rows = [
    ["Trend", values.trend, trendSvg],
    ["Momentum", values.momentum, momentumSvg],
    ["Volume", values.volume, volumeSvg],
    ["Volatiliteit", values.volatility, volatilitySvg],
  ];
  elements.consensus.innerHTML = rows.map(([label, value, icon]) => `<div class="consensus-row">
    <span class="consensus-label">${icon}${label}</span>
    <span class="consensus-bar"><i style="width:${value}%"></i></span>
    <span class="consensus-value">${value}</span>
  </div>`).join("");
}

function renderTradePlan(signal) {
  if (!signal?.plan) {
    elements.tradePlan.innerHTML = `<h3>Tradeplan (1u)</h3><p class="empty-copy">Geen tradeplan zolang de setup niet sterk en actueel genoeg is.</p>`;
    return;
  }
  const plan = signal.plan;
  elements.tradePlan.innerHTML = `<h3>Tradeplan (1u)</h3><dl class="plan-list">
    <dt>Entryzone</dt><dd>${formatPrice(plan.entryLow)} – ${formatPrice(plan.entryHigh)}</dd>
    <dt>Stop</dt><dd class="stop-value">${formatPrice(plan.stop)}</dd>
    <dt>Doel 1</dt><dd>${formatPrice(plan.target1)}</dd>
    <dt>Doel 2</dt><dd>${formatPrice(plan.target2)}</dd>
    <dt>R/R</dt><dd class="plain-value">${plan.rr1.toLocaleString("nl-NL", { minimumFractionDigits: 1 })}</dd>
    <dt>Advies (max ${state.settings.maxLeverage}x)</dt><dd>${plan.leverage ? `${plan.leverage}x` : "—"}</dd>
  </dl>`;
}

function renderSelectedMarket() {
  const pair = pairBySymbol.get(state.selectedSymbol);
  const ticker = state.tickers.get(state.selectedSymbol) || {};
  const signal = state.signals.get(state.selectedSymbol);
  const status = visibleStatus(signal);
  const change = priceChangePct(ticker);
  elements.selectedPair.textContent = pair.label;
  elements.mobilePrice.textContent = formatPrice(ticker.lastPrice);
  elements.mobileChange.textContent = formatPct(change);
  elements.mobileChange.className = change >= 0 ? "positive" : "negative";
  elements.mobileStatus.textContent = status;
  elements.mobileStatus.className = statusClass(signal?.status) === "short" ? "negative" : statusClass(signal?.status) === "watch" ? "status-watch" : statusClass(signal?.status) === "none" ? "neutral" : "positive";
  elements.mobileScore.textContent = signal?.score ?? "—";
  elements.signalStatus.textContent = status;
  elements.signalStatus.className = statusClass(signal?.status);
  elements.signalScore.textContent = signal?.score ?? "—";
  renderConsensus(signal);
  renderTradePlan(signal);
  elements.signalReasons.innerHTML = (signal?.reasons?.length ? signal.reasons : ["Nog geen volledige marktanalyse"])
    .map((reason) => `<li>${reason}</li>`).join("");

  const intervalState = signal?.states?.[state.interval];
  elements.ema20Value.textContent = formatPrice(intervalState?.ema20);
  elements.ema50Value.textContent = formatPrice(intervalState?.ema50);
  const now = Number(ticker.serverTime) || Date.now();
  const candles = closedCandles(state.candles[state.selectedSymbol]?.[state.interval] || [], TIMEFRAMES[state.interval].milliseconds, now);
  elements.chartTimestamp.textContent = candles.length ? `Laatste gesloten candle: ${new Date(candles.at(-1).start + TIMEFRAMES[state.interval].milliseconds).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : "Candles laden…";
  chart.update(candles, signal, state.interval);
  manualTradeAssistant?.render();
}

function renderSetups() {
  const sorted = CORE_PAIRS.map((pair) => ({ pair, signal: state.signals.get(pair.symbol) }))
    .sort((a, b) => (b.signal?.score || 0) - (a.signal?.score || 0));
  elements.setupsTable.innerHTML = sorted.map(({ pair, signal }) => {
    const status = signal?.status || "GEEN TRADE";
    const explanation = signal?.reasons?.join(" · ") || "Wachten op voldoende data";
    return `<tr>
      <td><span class="table-pair">${starSvg(pair.symbol === state.selectedSymbol)}${pair.label}</span></td>
      <td class="status-${statusClass(signal?.timeframeBias?.["60"])} status-text">${signal?.timeframeBias?.["60"] || "NEUTRAAL"}</td>
      <td class="status-${statusClass(signal?.timeframeBias?.["240"])} status-text">${signal?.timeframeBias?.["240"] || "NEUTRAAL"}</td>
      <td class="status-${statusClass(signal?.timeframeBias?.D)} status-text">${signal?.timeframeBias?.D || "NEUTRAAL"}</td>
      <td class="${signal?.score >= 70 ? "positive" : signal?.score >= 55 ? "status-watch" : "neutral"}"><b>${signal?.score ?? 0}</b></td>
      <td class="setup-explanation" title="${explanation}">${explanation}</td>
      <td class="${signal?.spreadPct <= 0.15 ? "positive" : signal?.spreadPct <= 0.25 ? "status-watch" : "negative"}">${Number.isFinite(signal?.spreadPct) ? formatPct(signal.spreadPct, 3) : "—"}</td>
      <td class="status-${statusClass(status)} status-text">${visibleStatus(signal)}</td>
    </tr>`;
  }).join("");

  elements.mobileSetups.innerHTML = sorted.filter(({ pair }) => pair.symbol !== state.selectedSymbol).slice(0, 4).map(({ pair, signal }) => `<button type="button" class="mobile-setup-row" data-symbol="${pair.symbol}">
    <span class="table-pair">${starSvg(false)}${pair.label}</span>
    <span class="status-${statusClass(signal?.status)} status-text">${visibleStatus(signal)}</span>
    <span class="setup-score ${signal?.score >= 70 ? "positive" : signal?.score >= 55 ? "status-watch" : "neutral"}">${signal?.score ?? 0}</span>
    ${chevronSvg}
  </button>`).join("");
  elements.mobileSetups.querySelectorAll("[data-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      selectSymbol(button.dataset.symbol);
      byId("chartView").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
}

function renderAll() {
  renderConnection();
  renderHeaderStats();
  renderWatchlist();
  renderSelectedMarket();
  renderSetups();
}

function selectSymbol(symbol) {
  if (!pairBySymbol.has(symbol)) return;
  state.selectedSymbol = symbol;
  renderWatchlist();
  renderSelectedMarket();
  renderSetups();
}

function setIntervalTab(interval) {
  state.interval = interval;
  document.querySelectorAll(".timeframe-tab").forEach((button) => {
    const active = button.dataset.interval === interval;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  renderSelectedMarket();
}

function openInfoDrawer() {
  elements.infoDrawer.classList.add("open");
  elements.infoDrawer.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  elements.infoDrawer.querySelector(".drawer-content").focus?.();
}

function closeInfoDrawer() {
  elements.infoDrawer.classList.remove("open");
  elements.infoDrawer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

function formatMetric(value, digits = 2) {
  if (value === Infinity) return "∞";
  return Number(value || 0).toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function renderBacktestResults(combined, perPair) {
  const summary = combined.summary;
  elements.backtestResults.innerHTML = `<div class="result-grid">
    <div><span>Setups</span><strong>${summary.total}</strong></div>
    <div><span>Winrate</span><strong>${formatMetric(summary.winRate, 1)}%</strong></div>
    <div><span>Gemiddelde R</span><strong class="${summary.averageR >= 0 ? "positive" : "negative"}">${formatMetric(summary.averageR)}</strong></div>
    <div><span>Profit factor</span><strong>${formatMetric(summary.profitFactor)}</strong></div>
    <div><span>Time-outs</span><strong>${summary.timeouts}</strong></div>
    <div><span>Langste verliesreeks</span><strong>${summary.maxLosingStreak}</strong></div>
  </div>
  <p class="${summary.sufficientSample ? "" : "sample-warning"}">${summary.sufficientSample ? "Steekproef bevat minimaal twintig trades." : "Onvoldoende steekproef: minder dan twintig trades."}</p>
  <p class="empty-copy">Per coin: ${perPair.map((result) => `${pairBySymbol.get(result.symbol).base} ${result.summary.total}`).join(" · ")}</p>`;
}

async function startBacktest() {
  if (state.loading) return;
  state.backtestCancelled = false;
  elements.runBacktest.disabled = true;
  elements.cancelBacktest.hidden = false;
  elements.backtestProgress.hidden = false;
  elements.backtestResults.innerHTML = "";
  const results = [];
  try {
    for (let index = 0; index < CORE_PAIRS.length; index += 1) {
      if (state.backtestCancelled) throw new Error("Backtest gestopt");
      const pair = CORE_PAIRS[index];
      const percent = Math.round(index / CORE_PAIRS.length * 100);
      elements.backtestProgressBar.style.width = `${percent}%`;
      elements.backtestProgressText.textContent = `${pair.label}: historische candles ophalen…`;
      const [oneHour, fourHour, daily] = await Promise.all([
        client.getHistory(pair.symbol, "60", 95),
        client.getHistory(pair.symbol, "240", 150),
        client.getHistory(pair.symbol, "D", 180),
      ]);
      if (state.backtestCancelled) throw new Error("Backtest gestopt");
      const signal = state.signals.get(pair.symbol);
      const result = runBacktest({
        symbol: pair.symbol,
        candlesByTimeframe: { "60": oneHour, "240": fourHour, D: daily },
        instrument: state.instruments.get(pair.symbol),
        spreadPct: Number.isFinite(signal?.spreadPct) ? signal.spreadPct : 0.05,
      });
      results.push(result);
      elements.backtestProgressBar.style.width = `${Math.round((index + 1) / CORE_PAIRS.length * 100)}%`;
      elements.backtestProgressText.textContent = `${pair.label}: ${result.summary.total} setups getest`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const combined = combineBacktests(results);
    renderBacktestResults(combined, results);
    localStorage.setItem(STORAGE_KEYS.backtest, JSON.stringify({ savedAt: Date.now(), summary: combined.summary, perPair: results.map(({ symbol, summary }) => ({ symbol, summary })) }));
  } catch (error) {
    elements.backtestResults.innerHTML = `<p class="${state.backtestCancelled ? "sample-warning" : "negative"}">${error.message}</p>`;
  } finally {
    elements.runBacktest.disabled = false;
    elements.cancelBacktest.hidden = true;
  }
}

function bindEvents() {
  elements.refreshButton.addEventListener("click", () => refreshMarketData());
  elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
  elements.saveSettings.addEventListener("click", () => {
    state.settings.maxLeverage = Number(elements.maxLeverage.value);
    state.settings.budgetUSDC = Math.min(100_000, Math.max(1, Number(elements.tradeBudget.value) || TRADE_DEFAULTS.budgetUSDC));
    state.settings.riskPct = Math.min(100, Math.max(0.1, Number(elements.riskPercentage.value) || TRADE_DEFAULTS.riskPct));
    elements.tradeBudget.value = String(state.settings.budgetUSDC);
    elements.riskPercentage.value = String(state.settings.riskPct);
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(state.settings));
    evaluateSignals();
    renderAll();
  });
  document.querySelectorAll(".timeframe-tab").forEach((button) => button.addEventListener("click", () => setIntervalTab(button.dataset.interval)));
  elements.mobileInfoButton.addEventListener("click", openInfoDrawer);
  elements.openInfoButton.addEventListener("click", () => {
    elements.settingsDialog.close();
    openInfoDrawer();
  });
  document.querySelectorAll("[data-close-drawer]").forEach((button) => button.addEventListener("click", closeInfoDrawer));
  elements.runBacktest.addEventListener("click", startBacktest);
  elements.cancelBacktest.addEventListener("click", () => { state.backtestCancelled = true; });
  document.querySelectorAll("[data-mobile-target]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".mobile-nav button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    byId(button.dataset.mobileTarget).scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && elements.infoDrawer.classList.contains("open")) closeInfoDrawer();
  });
  window.addEventListener("online", () => refreshMarketData({ showProgress: false }));
}

async function init() {
  cacheElements();
  loadSettings();
  chart = new SignalChart(elements.signalChart);
  manualTradeAssistant = new ManualTradeAssistant({
    elements,
    getContext: () => ({
      pair: pairBySymbol.get(state.selectedSymbol),
      signal: state.signals.get(state.selectedSymbol),
      instrument: state.instruments.get(state.selectedSymbol) || {},
      budgetUSDC: state.settings.budgetUSDC,
      riskPct: state.settings.riskPct,
      maxLeverage: state.settings.maxLeverage,
    }),
    notify: setAlert,
  });
  bindEvents();
  const snapshot = loadSnapshot();
  if (snapshot) applySnapshot(snapshot);
  else renderAll();
  await refreshMarketData();
  setInterval(() => {
    if (state.source !== "live") return;
    evaluateSignals();
    renderAll();
  }, 10_000);
  setInterval(() => refreshMarketData({ showProgress: false }), 5 * 60_000);
}

let chart;
let manualTradeAssistant;
init();
