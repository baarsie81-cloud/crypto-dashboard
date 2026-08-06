import { renderDecisionCards } from "./decision-ui.js";

function context(symbol) {
  const state = globalThis.__cryptoDashboardState;
  if (!state) return null;
  const market = state.marketBySymbol?.get(symbol);
  const ticker = state.tickers?.get(symbol);
  const signal = state.signals?.get(symbol);
  return market && signal ? { market, ticker, signal } : null;
}

function ensurePanel() {
  let section = document.getElementById("decisionDesk");
  if (section) return section;
  const grid = document.querySelector(".dashboard-grid");
  if (!grid) return null;
  section = document.createElement("section");
  section.id = "decisionDesk";
  section.className = "decision-desk panel";
  section.innerHTML = `<div class="panel-heading decision-heading"><div><h2>BTC & ETH Decision Desk</h2><span>Richting + kwaliteit + uitvoerbaarheid</span></div><small>Een hoge score is geen trade zonder bevestigde setup.</small></div><div id="decisionCards" class="decision-cards"></div>`;
  const manual = document.getElementById("manualOrderPanel");
  grid.insertBefore(section, manual || null);
  return section;
}

function hardenSettingsUi() {
  const leverage = document.getElementById("maxLeverage");
  if (leverage) {
    [...leverage.options].forEach((option) => { if (Number(option.value) > 4) option.remove(); });
    leverage.max = "4";
  }
  const risk = document.getElementById("riskPercentage");
  if (risk) { risk.max = "2"; if (Number(risk.value) > 2) risk.value = "1"; }
  const dialog = document.getElementById("settingsDialog");
  if (dialog) {
    dialog.querySelectorAll(".field-note").forEach((note) => {
      if (/10%|10x|leverage/i.test(note.textContent)) note.textContent = "Veilige standaard: 1% risico per trade en maximaal 3x leverage; de engine kan lager adviseren en blokkeert boven 4x.";
    });
  }
}

function render() {
  const section = ensurePanel();
  hardenSettingsUi();
  if (!section) return;
  const cards = document.getElementById("decisionCards");
  renderDecisionCards(cards, [context("PF_XBTUSD"), context("PF_ETHUSD")].filter(Boolean));
  if (!cards.children.length) cards.innerHTML = `<p class="empty-copy">BTC- en ETH-data worden geladen…</p>`;
}

window.addEventListener("crypto-dashboard-render", render);
window.addEventListener("DOMContentLoaded", () => {
  render();
  const observer = new MutationObserver(() => render());
  const marker = document.getElementById("lastUpdated");
  if (marker) observer.observe(marker, { childList: true, subtree: true, characterData: true });
});
