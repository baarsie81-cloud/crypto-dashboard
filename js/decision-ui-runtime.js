import "./order-book.js";
import { MARKET_LIMITS, SIGNAL_LIMITS, TIMEFRAMES, TRADE_DEFAULTS } from "./constants.js";
import { KrakenClient } from "./kraken.js";
import { analyzeMarket } from "./signals.js";
import { renderDecisionCards } from "./decision-ui.js";

const SYMBOLS = ["PF_XBTUSD", "PF_ETHUSD"];
const client = new KrakenClient();
const state = {
  markets: new Map(),
  tickers: new Map(),
  candles: {},
  signals: new Map(),
  ready: false,
};

function ensurePanel() {
  let section = document.getElementById("decisionDesk");
  if (section) return section;
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return null;
  section = document.createElement("section");
  section.id = "decisionDesk";
  section.className = "decision-desk panel";
  section.innerHTML = `<div class="panel-heading decision-heading"><div><h2>BTC & ETH Decision Desk</h2><span>Richting + kwaliteit + uitvoerbaarheid</span></div><small>Een hoge score is geen trade zonder bevestigde setup.</small></div><div id="decisionCards" class="decision-cards"><p class="empty-copy">BTC- en ETH-data worden geladen…</p></div>`;
  const manual = document.getElementById("manualOrderPanel");
  grid.insertBefore(section, manual || null);
  return section;
}

function hardenSettingsUi() {
  const leverage = document.getElementById("maxLeverage");
  if (leverage) {
    [...leverage.options].forEach((option) => { if (Number(option.value) > SIGNAL_LIMITS.absoluteMaxLeverage) option.remove(); });
    if (Number(leverage.value) > SIGNAL_LIMITS.absoluteMaxLeverage) leverage.value = String(SIGNAL_LIMITS.defaultMaxLeverage);
  }
  const risk = document.getElementById("riskPercentage");
  if (risk) {
    risk.max = String(TRADE_DEFAULTS.maximumRiskPct);
    if (Number(risk.value) > TRADE_DEFAULTS.maximumRiskPct) risk.value = String(TRADE_DEFAULTS.riskPct);
  }
  const dialog = document.getElementById("settingsDialog");
  if (dialog) {
    dialog.querySelectorAll(".field-note").forEach((note) => {
      if (/10%|10x|leverage/i.test(note.textContent)) note.textContent = "Veilige standaard: 1% risico per trade en maximaal 3x leverage. De engine kan lager adviseren en blokkeert boven 4x.";
    });
  }
}

function mergeTicker(symbol, patch) {
  const current = state.tickers.get(symbol) || {};
  state.tickers.set(symbol, { ...current, ...patch, symbol });
}

function evaluate(symbol) {
  const market = state.markets.get(symbol);
  const ticker = state.tickers.get(symbol) || {};
  if (!market) return;
  state.signals.set(symbol, analyzeMarket({
    symbol,
    candlesByTimeframe: state.candles[symbol] || {},
    ticker,
    instrument: market,
    turnoverQuality: symbol === "PF_XBTUSD" ? 1 : 0.95,
    dataAgeMs: Date.now() - (Number(ticker.receivedAt) || 0),
    maxLeverage: SIGNAL_LIMITS.defaultMaxLeverage,
  }));
}

function render() {
  ensurePanel();
  hardenSettingsUi();
  const cards = document.getElementById("decisionCards");
  if (!cards) return;
  const contexts = SYMBOLS.map((symbol) => {
    const market = state.markets.get(symbol);
    const ticker = state.tickers.get(symbol);
    const signal = state.signals.get(symbol);
    return market && signal ? { market, ticker, signal } : null;
  }).filter(Boolean);
  if (!contexts.length) {
    cards.innerHTML = `<p class="empty-copy">BTC- en ETH-data worden geladen…</p>`;
    return;
  }
  renderDecisionCards(cards, contexts);
}

async function loadDecisionData() {
  ensurePanel();
  hardenSettingsUi();
  try {
    const [markets, tickers] = await Promise.all([client.getInstruments(), client.getTickers()]);
    for (const market of markets) if (SYMBOLS.includes(market.symbol)) state.markets.set(market.symbol, market);
    for (const ticker of tickers) if (SYMBOLS.includes(ticker.symbol)) mergeTicker(ticker.symbol, ticker);
    await Promise.all(SYMBOLS.flatMap((symbol) => Object.keys(TIMEFRAMES).map(async (interval) => {
      state.candles[symbol] ||= {};
      state.candles[symbol][interval] = await client.getCandles(symbol, interval, MARKET_LIMITS.chartHistory);
    })));
    SYMBOLS.forEach(evaluate);
    state.ready = true;
    render();
    client.connectPublic(SYMBOLS, {
      getBookOptions(symbol) {
        const market = state.markets.get(symbol);
        return { contractSize: market?.contractSize || 1, targetNotionalUSD: 1000 };
      },
      onTicker(symbol, ticker) {
        if (!SYMBOLS.includes(symbol)) return;
        mergeTicker(symbol, ticker);
        evaluate(symbol);
        render();
      },
      onBookMetrics(symbol, metrics) {
        if (!SYMBOLS.includes(symbol)) return;
        mergeTicker(symbol, metrics);
        evaluate(symbol);
        render();
      },
      onBookInvalid(symbol) {
        if (!SYMBOLS.includes(symbol)) return;
        mergeTicker(symbol, { bookValidated: false });
        evaluate(symbol);
        render();
      },
    });
  } catch (error) {
    const cards = document.getElementById("decisionCards");
    if (cards) cards.innerHTML = `<p class="empty-copy">Decision Desk kon Kraken-data niet volledig laden. De bestaande scanner blijft actief.</p>`;
    console.warn("Decision Desk unavailable", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  ensurePanel();
  hardenSettingsUi();
  loadDecisionData();
});
