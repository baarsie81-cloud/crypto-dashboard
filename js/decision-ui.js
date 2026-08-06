const finite = (value) => Number.isFinite(Number(value));
const fmt = (value, digits = 2) => finite(value) ? Number(value).toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits }) : "—";
const price = (value) => {
  const n = Number(value);
  if (!(n > 0)) return "—";
  const digits = n < 1 ? 5 : n < 100 ? 3 : 2;
  return `$${fmt(n, digits)}`;
};
const tone = (value) => value === "BULLISH" || value === "LONG" ? "positive" : value === "BEARISH" || value === "SHORT" ? "negative" : "neutral";
const horizon = (signal, key) => signal?.timeframeBias?.[key] === "LONG" ? "Bullish" : signal?.timeframeBias?.[key] === "SHORT" ? "Bearish" : "Neutraal";

export function decisionCardModel({ market, ticker = {}, signal } = {}) {
  if (!market || !signal) return null;
  const plan = signal.plan;
  const support = signal.structure?.nearestSupport;
  const resistance = signal.structure?.nearestResistance;
  return {
    symbol: market.symbol,
    label: market.label,
    lastPrice: ticker.lastPrice || ticker.markPrice,
    longScore: signal.longScore ?? 0,
    shortScore: signal.shortScore ?? 0,
    confidence: signal.confidence ?? 0,
    setupConfidence: signal.setupConfidence ?? 0,
    marketRegime: signal.marketRegime || "NEUTRAAL",
    tradeQuality: signal.tradeQuality || "D",
    status: signal.status || "GEEN TRADE",
    horizon24h: horizon(signal, "60"),
    horizon7d: horizon(signal, "240"),
    horizon30d: horizon(signal, "D"),
    support,
    resistance,
    plan,
    executionScore: signal.executionScore ?? 0,
    bookValidated: ticker.bookValidated === true,
  };
}

export function renderDecisionCard(model) {
  if (!model) return `<article class="decision-card decision-card-empty"><p>Data laden…</p></article>`;
  const plan = model.plan;
  const setup = plan ? plan.type.replaceAll("_", " ") : "Geen setup";
  const rr = plan?.rr2 > 0 ? `${fmt(plan.rr2, 1)}R naar doel 2` : "—";
  const wait = plan?.waitFor || "Wacht op een geldige marktstructuur en actuele orderboekbevestiging.";
  return `<article class="decision-card" data-symbol="${model.symbol}">
    <header><div><span class="decision-eyebrow">${model.label}</span><strong>${price(model.lastPrice)}</strong></div><div class="quality-badge quality-${model.tradeQuality.toLowerCase().replace("+", "plus")}">${model.tradeQuality}</div></header>
    <div class="decision-score-grid">
      <div><span>Long</span><strong class="positive">${model.longScore}</strong></div>
      <div><span>Short</span><strong class="negative">${model.shortScore}</strong></div>
      <div><span>Confidence</span><strong>${model.confidence}</strong></div>
      <div><span>Setup</span><strong>${model.setupConfidence}</strong></div>
    </div>
    <div class="decision-meta"><span>Regime <b class="${tone(model.marketRegime)}">${model.marketRegime}</b></span><span>Uitvoering <b>${model.executionScore}/100</b></span><span>L2 <b class="${model.bookValidated ? "positive" : "negative"}">${model.bookValidated ? "bevestigd" : "wachten"}</b></span></div>
    <div class="decision-horizons"><span>24u <b>${model.horizon24h}</b></span><span>7d <b>${model.horizon7d}</b></span><span>30d <b>${model.horizon30d}</b></span></div>
    <div class="decision-levels">
      <div><span>Steun</span><b>${model.support ? `${price(model.support.low)} – ${price(model.support.high)}` : "—"}</b></div>
      <div><span>Weerstand</span><b>${model.resistance ? `${price(model.resistance.low)} – ${price(model.resistance.high)}` : "—"}</b></div>
    </div>
    <div class="decision-setup"><span class="setup-type">${setup}</span>${plan ? `<dl><dt>Entry</dt><dd>${price(plan.entryLow)} – ${price(plan.entryHigh)}</dd><dt>Invalidatie</dt><dd>${price(plan.stop)}</dd><dt>Doel 1</dt><dd>${price(plan.target1)}</dd><dt>Doel 2</dt><dd>${price(plan.target2)}</dd><dt>R/R</dt><dd>${rr}</dd></dl>` : ""}</div>
    <p class="wait-rule"><strong>Wacht op:</strong> ${wait}</p>
  </article>`;
}

export function renderDecisionCards(container, contexts = []) {
  if (!container) return;
  container.innerHTML = contexts.map((context) => renderDecisionCard(decisionCardModel(context))).join("");
}
