const select = document.getElementById("chartMarketSelect");
const decisionCards = document.getElementById("decisionCards");
const selectedPair = document.getElementById("selectedPair");

function optionRows() {
  return [...document.querySelectorAll("#decisionCards .decision-card[data-symbol]")]
    .map((card) => ({
      symbol: card.dataset.symbol,
      label: card.querySelector(".decision-eyebrow")?.textContent?.trim() || card.dataset.symbol,
    }))
    .filter((row, index, rows) => row.symbol && rows.findIndex((item) => item.symbol === row.symbol) === index)
    .slice(0, 15);
}

function currentSymbolFromLabel(rows) {
  const label = selectedPair?.textContent?.trim();
  return rows.find((row) => row.label === label)?.symbol || select?.value || rows[0]?.symbol || "";
}

function renderOptions() {
  if (!select) return;
  const rows = optionRows();
  if (!rows.length) return;
  const current = currentSymbolFromLabel(rows);
  select.innerHTML = rows.map((row) => `<option value="${row.symbol}">${row.label}</option>`).join("");
  if (rows.some((row) => row.symbol === current)) select.value = current;
  select.disabled = false;
}

function activateMarket(symbol) {
  if (!symbol) return;
  const selector = `[data-symbol="${CSS.escape(symbol)}"]`;
  const target = document.querySelector(`#marketResults ${selector}`) || document.querySelector(`#watchlist ${selector}`);
  if (target) target.click();
}

select?.addEventListener("change", () => activateMarket(select.value));

if (decisionCards) new MutationObserver(renderOptions).observe(decisionCards, { childList: true, subtree: true });
if (selectedPair) new MutationObserver(renderOptions).observe(selectedPair, { childList: true, subtree: true, characterData: true });
renderOptions();
