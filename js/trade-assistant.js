import { STORAGE_KEYS, TRADE_DEFAULTS } from "./constants.js";
import {
  JOURNAL_STATUSES,
  createJournalEntry,
  createManualTradePlan,
  journalSummary,
  normalizeJournal,
} from "./trade-planner.js";

const statusLabels = Object.freeze({
  voorbereid: "Voorbereid",
  "order geplaatst": "Order geplaatst",
  geopend: "Geopend",
  gesloten: "Gesloten",
});

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#039;");

function decimalsForStep(step) {
  const text = String(step).toLowerCase();
  if (text.includes("e-")) return Math.min(8, Number(text.split("e-")[1]) || 0);
  return Math.min(8, (text.split(".")[1] || "").length);
}

function formatNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

const formatPrice = (value, tickSize = 0.01) => formatNumber(value, Math.max(2, decimalsForStep(tickSize)));
const formatQuantity = (value, qtyStep) => formatNumber(value, decimalsForStep(qtyStep));
const formatPct = (fraction, digits = 4) => `${(Number(fraction || 0) * 100).toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

function formatTime(timestamp) {
  const number = Number(timestamp);
  return Number.isFinite(number)
    ? new Date(number).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "—";
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function planAsText(plan) {
  const exits = plan.exits.mode === "50/50"
    ? `Doel 1 reduce-only: 50% (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}) · Doel 2 reduce-only: 50% (${formatQuantity(plan.exits.target2Qty, plan.qtyStep)})`
    : `Doel 1 reduce-only: 100% (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)})`;
  const funding = plan.fundingEffectUSDPerHour < 0 ? "geschatte betaling" : "geschatte ontvangst";
  return [
    `HANDMATIGE KRAKEN PRO FUTURES-ORDERKAART — ${plan.pairLabel}`,
    `Symbool: ${plan.symbol} · ${plan.direction} · score ${plan.score}/100`,
    `1u ${plan.timeframeBias["60"]} · 4u ${plan.timeframeBias["240"]} · 1d ${plan.timeframeBias.D}`,
    `Limietprijs: ${formatPrice(plan.entry, plan.tickSize)} USD`,
    `Entryzone: ${formatPrice(plan.entryLow, plan.tickSize)} – ${formatPrice(plan.entryHigh, plan.tickSize)} USD`,
    `Hoeveelheid: ${formatQuantity(plan.quantity, plan.qtyStep)} contracten`,
    `Notional: $${formatNumber(plan.notionalUSD)} · benodigde margin: $${formatNumber(plan.ownMarginUSD)} / €${formatNumber(plan.ownMarginEUR)} · leverage: ${plan.leverage}x`,
    `Stop reduce-only: ${formatPrice(plan.stop, plan.tickSize)} · doel 1: ${formatPrice(plan.target1, plan.tickSize)} · doel 2: ${formatPrice(plan.target2, plan.tickSize)}`,
    exits,
    `Geschatte takerkosten + spread: $${formatNumber(plan.estimatedCostsUSD)}`,
    `Maximaal gepland verlies: €${formatNumber(plan.maxPlannedLossEUR)} / $${formatNumber(plan.maxPlannedLossUSD)} (risicobudget €${formatNumber(plan.riskBudgetEUR)})`,
    `Funding ${formatPct(plan.fundingRate)} per uur: ${funding} $${formatNumber(Math.abs(plan.fundingEffectUSDPerHour), 4)} per uur bij gelijkblijvend tarief.`,
    plan.instruction,
    "HANDMATIG CONTROLEREN: isolated margin · liquidatieprijs · contracthoeveelheid · reduce-only stop · reduce-only doelen · funding.",
    "Het dashboard leest geen account, posities, fills of saldo en plaatst nooit orders.",
    plan.marketUrl,
    `Fallback Kraken Pro: ${plan.krakenProUrl}`,
  ].join("\n");
}

export class ManualTradeAssistant {
  constructor({ elements, getContext, notify = () => {} }) {
    this.elements = elements;
    this.getContext = getContext;
    this.notify = notify;
    this.currentPlan = null;
    this.journal = this.loadJournal();
    this.bindEvents();
    this.renderJournal();
  }

  loadJournal() {
    try { return normalizeJournal(JSON.parse(localStorage.getItem(STORAGE_KEYS.tradeJournal))); }
    catch { return []; }
  }

  persistJournal() {
    try { localStorage.setItem(STORAGE_KEYS.tradeJournal, JSON.stringify(this.journal)); }
    catch { this.notify("Het tradejournal kon niet lokaal worden opgeslagen."); }
  }

  render() {
    const context = this.getContext();
    this.currentPlan = createManualTradePlan(context);
    const plan = this.currentPlan;
    this.renderRiskSummary();
    if (!plan.eligible) {
      const reasons = plan.blockedReasons?.length ? plan.blockedReasons : ["Er is nu geen vrijgegeven handmatig tradeplan."];
      this.elements.manualOrderContent.innerHTML = `<div class="order-empty">
        <span class="manual-only-badge">GEEN ORDERKAART</span>
        <strong>${escapeHtml(context.market?.label || "Geselecteerde markt")}</strong>
        <p>De assistent blijft geblokkeerd tot het signaal en de Kraken-futuresdata aan alle voorwaarden voldoen.</p>
        <ul>${reasons.slice(0, 5).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      </div>`;
      return;
    }

    const directionClass = plan.direction === "LONG" ? "long" : "short";
    const exitText = plan.exits.mode === "50/50"
      ? `50% op doel 1 (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}) en 50% op doel 2 (${formatQuantity(plan.exits.target2Qty, plan.qtyStep)})`
      : `100% op doel 1 (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}); halve contractorders halen de minimale lotgrootte niet.`;
    const fundingTone = plan.fundingEffectUSDPerHour < 0 ? "negative" : "positive";
    const fundingAction = plan.fundingEffectUSDPerHour < 0 ? "betaling" : "ontvangst";
    this.elements.manualOrderContent.innerHTML = `<article class="manual-order-card ${directionClass}">
      <div class="order-card-header">
        <div><span class="manual-only-badge">HANDMATIG · GEEN ACCOUNTKOPPELING</span><h3>${escapeHtml(plan.pairLabel)} <b>${plan.direction}</b></h3></div>
        <div class="order-score"><span>Score</span><strong>${plan.score}</strong><small>/100</small></div>
      </div>
      <div class="order-context">
        <span>Symbool <b>${escapeHtml(plan.symbol)}</b></span><span>1u <b>${plan.timeframeBias["60"]}</b></span>
        <span>4u <b>${plan.timeframeBias["240"]}</b></span><span>1d <b>${plan.timeframeBias.D}</b></span>
        <span>Spread <b>${formatNumber(plan.spreadPct, 3)}%</b></span><span>Premium <b>${formatNumber(plan.premiumPct, 3)}%</b></span>
      </div>
      <div class="order-layout">
        <div class="order-metrics">
          <div class="primary-metric"><span>Contracthoeveelheid</span><strong>${formatQuantity(plan.quantity, plan.qtyStep)}</strong><small>${escapeHtml(plan.base)} lineair perpetual</small></div>
          <div><span>Limietprijs</span><strong>$${formatPrice(plan.entry, plan.tickSize)}</strong><small>Entryzone $${formatPrice(plan.entryLow, plan.tickSize)} – $${formatPrice(plan.entryHigh, plan.tickSize)}</small></div>
          <div><span>Notional</span><strong>$${formatNumber(plan.notionalUSD)}</strong><small>EUR/USD ${formatNumber(plan.eurUsd, 4)}</small></div>
          <div><span>Eigen margin</span><strong>€${formatNumber(plan.ownMarginEUR)}</strong><small>$${formatNumber(plan.ownMarginUSD)} · isolated ${plan.leverage}x</small></div>
          <div><span>Takerkosten + spread</span><strong>$${formatNumber(plan.estimatedCostsUSD)}</strong><small>Makerindicatie $${formatNumber(plan.makerFeesUSD)}</small></div>
          <div class="risk-metric"><span>Max. gepland verlies</span><strong>€${formatNumber(plan.maxPlannedLossEUR)}</strong><small>Risicobudget €${formatNumber(plan.riskBudgetEUR)}</small></div>
        </div>
        <div class="order-levels">
          <dl><div><dt>Stop reduce-only</dt><dd class="stop-value">$${formatPrice(plan.stop, plan.tickSize)}</dd></div><div><dt>Doel 1</dt><dd>$${formatPrice(plan.target1, plan.tickSize)}</dd></div><div><dt>Doel 2</dt><dd>$${formatPrice(plan.target2, plan.tickSize)}</dd></div></dl>
          <p class="exit-plan"><strong>Exitverdeling:</strong> ${escapeHtml(exitText)}</p>
          <p class="borrow-instruction">${escapeHtml(plan.instruction)}</p>
          <p class="funding-line ${fundingTone}"><strong>Funding:</strong> ${formatPct(plan.fundingRate)} per uur · geschatte ${fundingAction} $${formatNumber(Math.abs(plan.fundingEffectUSDPerHour), 4)}/uur.</p>
        </div>
      </div>
      <div class="manual-checklist"><strong>Verplicht controleren</strong>
        <label><input type="checkbox"> Isolated margin</label><label><input type="checkbox"> Hoeveelheid</label>
        <label><input type="checkbox"> Liquidatieprijs in Kraken</label><label><input type="checkbox"> Stop reduce-only</label>
        <label><input type="checkbox"> Doelen reduce-only</label><label><input type="checkbox"> Funding</label>
      </div>
      <p class="order-warning">${plan.warnings.map(escapeHtml).join(" · ")}</p>
      <div class="order-actions"><button class="secondary-button" type="button" data-order-action="copy">Kopieer orderkaart</button><button class="secondary-button" type="button" data-order-action="save">Bewaar in journal</button><button class="primary-button" type="button" data-order-action="open">Open markt in Kraken</button></div>
      <p class="signal-inline-reasons">${plan.reasons.map((reason) => `✓ ${escapeHtml(reason)}`).join(" &nbsp; ")}</p>
    </article>`;
  }

  renderRiskSummary() {
    const summary = journalSummary(this.journal);
    this.elements.journalRiskSummary.textContent = `Gepland risico: €${formatNumber(summary.cumulativePlannedRiskEUR)}`;
    this.elements.journalRiskSummary.classList.toggle("over-limit", summary.overRiskLimit);
  }

  renderJournal() {
    const summary = journalSummary(this.journal);
    this.renderRiskSummary();
    this.elements.journalSummary.innerHTML = `<div><span>Actieve plannen</span><strong>${summary.activeCount}</strong></div><div><span>Opgeteld gepland risico</span><strong>€${formatNumber(summary.cumulativePlannedRiskEUR)}</strong></div><div><span>Werkelijke gesloten P&amp;L</span><strong class="${summary.closedPnlEUR >= 0 ? "positive" : "negative"}">€${formatNumber(summary.closedPnlEUR)}</strong></div>`;
    this.elements.journalWarning.hidden = !summary.overRiskLimit;
    this.elements.journalWarning.textContent = `Waarschuwing: het opgetelde geplande risico is hoger dan €${formatNumber(TRADE_DEFAULTS.cumulativeRiskWarningEUR)}. Nieuwe plannen worden niet geblokkeerd.`;
    if (!this.journal.length) {
      this.elements.journalList.innerHTML = `<div class="order-empty"><strong>Nog geen Kraken-trades voorbereid</strong><p>Bewaar een geldige futures-orderkaart om hier handmatig de voortgang bij te houden.</p></div>`;
      return;
    }
    this.elements.journalList.innerHTML = [...this.journal].sort((a, b) => b.preparedAt - a.preparedAt).map((entry) => `<article class="journal-entry" data-journal-id="${escapeHtml(entry.id)}">
      <div class="journal-entry-heading"><div><strong class="status-${entry.direction.toLowerCase()}">${escapeHtml(entry.pairLabel)} ${entry.direction}</strong><span>${formatTime(entry.preparedAt)}</span></div><span>Planrisico €${formatNumber(entry.order.maxPlannedLossEUR)}</span></div>
      <div class="journal-fields">
        <label>Status<select data-journal-field="status">${JOURNAL_STATUSES.map((status) => `<option value="${status}"${entry.status === status ? " selected" : ""}>${statusLabels[status]}</option>`).join("")}</select></label>
        <label>Werkelijke exit<input data-journal-field="actualExit" type="number" min="0" step="any" inputmode="decimal" value="${entry.actualExit ?? ""}" placeholder="Optioneel"></label>
        <label>Werkelijke P&amp;L (EUR)<input data-journal-field="actualPnlEUR" type="number" step="any" inputmode="decimal" value="${entry.actualPnlEUR ?? ""}" placeholder="Optioneel"></label>
      </div>
      <div class="journal-order-line"><span>Entry $${formatNumber(entry.order.entry)}</span><span>${formatNumber(entry.order.quantity, 6)} contracten</span><span>${entry.order.leverage}x isolated</span><span>Stop $${formatNumber(entry.order.stop)}</span></div>
    </article>`).join("");
  }

  bindEvents() {
    this.elements.manualOrderContent.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-order-action]");
      if (!button || !this.currentPlan?.eligible) return;
      if (button.dataset.orderAction === "copy") {
        try {
          await copyText(planAsText(this.currentPlan));
          const original = button.textContent;
          button.textContent = "Gekopieerd";
          setTimeout(() => { button.textContent = original; }, 1_500);
        } catch { this.notify("Kopiëren lukte niet. Controleer de browsertoestemming."); }
      }
      if (button.dataset.orderAction === "save") {
        const entry = createJournalEntry(this.currentPlan);
        if (!entry) return;
        this.journal.push(entry);
        this.persistJournal();
        this.renderJournal();
        button.textContent = "Bewaard in journal";
      }
      if (button.dataset.orderAction === "open") window.open(this.currentPlan.marketUrl, "_blank", "noopener,noreferrer");
    });
    this.elements.openJournalButton.addEventListener("click", () => { this.renderJournal(); this.elements.journalDialog.showModal(); });
    this.elements.closeJournalButton.addEventListener("click", () => this.elements.journalDialog.close());
    this.elements.journalList.addEventListener("change", (event) => {
      const field = event.target.dataset.journalField;
      const container = event.target.closest("[data-journal-id]");
      if (!field || !container) return;
      const entry = this.journal.find((item) => item.id === container.dataset.journalId);
      if (!entry) return;
      if (field === "status" && JOURNAL_STATUSES.includes(event.target.value)) {
        entry.status = event.target.value;
        entry.closedAt = entry.status === "gesloten" ? Date.now() : null;
      } else if (["actualExit", "actualPnlEUR"].includes(field)) {
        const value = event.target.value.trim();
        entry[field] = value === "" ? null : Number(value);
      }
      entry.updatedAt = Date.now();
      this.journal = normalizeJournal(this.journal);
      this.persistJournal();
      this.renderJournal();
    });
    this.elements.exportJournalButton.addEventListener("click", () => this.exportJournal());
    this.elements.importJournalButton.addEventListener("click", () => this.elements.journalImportFile.click());
    this.elements.journalImportFile.addEventListener("change", (event) => this.importJournal(event.target.files?.[0]));
  }

  exportJournal() {
    const payload = JSON.stringify({ version: 2, venue: "Kraken Pro", exportedAt: new Date().toISOString(), journal: this.journal }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `kraken-pro-futures-tradejournal-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async importJournal(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.venue && parsed.venue !== "Kraken Pro") throw new Error("dit is geen Kraken Pro-journal");
      const source = Array.isArray(parsed) ? parsed : parsed?.journal;
      const imported = normalizeJournal(source);
      if (!imported.length) throw new Error("geen geldige Kraken versie-2-regels gevonden");
      const merged = new Map(this.journal.map((entry) => [entry.id, entry]));
      imported.forEach((entry) => merged.set(entry.id, entry));
      this.journal = normalizeJournal([...merged.values()]);
      this.persistJournal();
      this.renderJournal();
      this.notify(`${imported.length} geldige Kraken-journalregel(s) geïmporteerd.`);
    } catch (error) {
      this.notify(`Importeren mislukt: ${error.message}. Journals van andere handelsplatformen worden bewust niet gemengd.`);
    } finally { this.elements.journalImportFile.value = ""; }
  }
}
