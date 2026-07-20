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
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

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

function formatPrice(value, tickSize = 0.01) {
  return formatNumber(value, Math.max(2, decimalsForStep(tickSize)));
}

function formatQuantity(value, qtyStep) {
  return formatNumber(value, decimalsForStep(qtyStep));
}

function formatTime(timestamp) {
  const number = Number(timestamp);
  if (!Number.isFinite(number)) return "—";
  return new Date(number).toLocaleString("nl-NL", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
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
    ? `Doel 1: 50% (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}) · Doel 2: 50% (${formatQuantity(plan.exits.target2Qty, plan.qtyStep)})`
    : `Doel 1: 100% (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)})`;
  return [
    `HANDMATIGE BYBIT EU ORDERKAART — ${plan.pairLabel}`,
    `${plan.direction} · score ${plan.score}/100 · 1u ${plan.timeframeBias["60"]} · 4u ${plan.timeframeBias["240"]} · 1d ${plan.timeframeBias.D}`,
    `Limietprijs: ${formatPrice(plan.entry, plan.tickSize)} USDC`,
    `Entryzone: ${formatPrice(plan.entryLow, plan.tickSize)} – ${formatPrice(plan.entryHigh, plan.tickSize)} USDC`,
    `Hoeveelheid: ${formatQuantity(plan.quantity, plan.qtyStep)} ${plan.base}`,
    `Orderwaarde: ${formatNumber(plan.notional)} USDC · eigen margin: ${formatNumber(plan.ownMargin)} USDC · leverage: ${plan.leverage}x`,
    `Stop: ${formatPrice(plan.stop, plan.tickSize)} · doel 1: ${formatPrice(plan.target1, plan.tickSize)} · doel 2: ${formatPrice(plan.target2, plan.tickSize)}`,
    exits,
    `Geschatte handelskosten + spread: ${formatNumber(plan.estimatedCosts)} USDC`,
    `Maximaal gepland verlies: ${formatNumber(plan.maxPlannedLoss)} USDC (budget ${formatNumber(plan.riskBudget)} USDC)`,
    plan.instruction,
    "HANDMATIG CONTROLEREN: Spot Margin-modus · collateral · actuele leenbaarheid · borrowing rate · stop-loss · terugbetaling.",
    "Borrowing fees, slippage en liquidatiekosten zijn niet vooraf meegerekend.",
    plan.bybitUrl,
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
    try {
      return normalizeJournal(JSON.parse(localStorage.getItem(STORAGE_KEYS.tradeJournal)));
    } catch {
      return [];
    }
  }

  persistJournal() {
    try {
      localStorage.setItem(STORAGE_KEYS.tradeJournal, JSON.stringify(this.journal));
    } catch {
      this.notify("Het tradejournal kon niet lokaal worden opgeslagen.");
    }
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
        <strong>${escapeHtml(context.pair?.label || "Geselecteerde markt")}</strong>
        <p>De assistent blijft geblokkeerd tot het signaal aan alle voorwaarden voldoet.</p>
        <ul>${reasons.slice(0, 4).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul>
      </div>`;
      return;
    }

    const directionClass = plan.direction === "LONG" ? "long" : "short";
    const exitText = plan.exits.mode === "50/50"
      ? `50% op doel 1 (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}) en 50% op doel 2 (${formatQuantity(plan.exits.target2Qty, plan.qtyStep)})`
      : `100% op doel 1 (${formatQuantity(plan.exits.target1Qty, plan.qtyStep)}); halve orders halen Bybits minimum niet.`;
    this.elements.manualOrderContent.innerHTML = `<article class="manual-order-card ${directionClass}">
      <div class="order-card-header">
        <div><span class="manual-only-badge">HANDMATIG · GEEN ACCOUNTKOPPELING</span><h3>${escapeHtml(plan.pairLabel)} <b>${plan.direction}</b></h3></div>
        <div class="order-score"><span>Score</span><strong>${plan.score}</strong><small>/ 100</small></div>
      </div>
      <div class="order-context">
        <span>1u <b>${escapeHtml(plan.timeframeBias["60"])}</b></span><span>4u <b>${escapeHtml(plan.timeframeBias["240"])}</b></span><span>1d <b>${escapeHtml(plan.timeframeBias.D)}</b></span><span>Spread <b>${formatNumber(plan.spreadPct, 3)}%</b></span>
      </div>
      <div class="order-layout">
        <div class="order-metrics">
          <div class="primary-metric"><span>Limietprijs</span><strong>${formatPrice(plan.entry, plan.tickSize)}</strong><small>Zone ${formatPrice(plan.entryLow, plan.tickSize)} – ${formatPrice(plan.entryHigh, plan.tickSize)}</small></div>
          <div><span>Hoeveelheid</span><strong>${formatQuantity(plan.quantity, plan.qtyStep)} ${escapeHtml(plan.base)}</strong></div>
          <div><span>Orderwaarde</span><strong>${formatNumber(plan.notional)} USDC</strong></div>
          <div><span>Eigen margin</span><strong>${formatNumber(plan.ownMargin)} USDC</strong></div>
          <div><span>Leverage</span><strong>${plan.leverage}x</strong></div>
          <div class="risk-metric"><span>Max. gepland verlies</span><strong>${formatNumber(plan.maxPlannedLoss)} USDC</strong><small>Cap ${formatNumber(plan.riskBudget)} USDC</small></div>
          <div><span>Geschatte kosten</span><strong>${formatNumber(plan.estimatedCosts)} USDC</strong><small>0,25% per zijde + spread</small></div>
        </div>
        <div class="order-levels">
          <dl>
            <div><dt>Stop-loss</dt><dd class="negative">${formatPrice(plan.stop, plan.tickSize)}</dd></div>
            <div><dt>Doel 1</dt><dd>${formatPrice(plan.target1, plan.tickSize)}</dd></div>
            <div><dt>Doel 2</dt><dd>${formatPrice(plan.target2, plan.tickSize)}</dd></div>
          </dl>
          <p class="exit-plan"><b>Exit:</b> ${escapeHtml(exitText)}</p>
          <p class="borrow-instruction"><b>${plan.direction === "LONG" ? "LONG" : "SHORT"}:</b> ${escapeHtml(plan.instruction)}</p>
        </div>
      </div>
      <div class="manual-checklist">
        <strong>Verplichte handmatige controle in Bybit EU</strong>
        <label><input type="checkbox"> Spot Margin-modus</label>
        <label><input type="checkbox"> Collateral en eigen margin</label>
        <label><input type="checkbox"> Actuele leenbaarheid en borrowing rate</label>
        <label><input type="checkbox"> Stop-loss en doelen</label>
        <label><input type="checkbox"> Terugbetaling na sluiten</label>
      </div>
      <p class="order-warning">Borrowing fees zijn variabel en niet meegerekend. Controleer ook slippage en liquidatierisico. Je plaatst en bevestigt de order altijd zelf.</p>
      <div class="order-actions">
        <button class="secondary-button" type="button" data-order-action="copy">Kopieer orderkaart</button>
        <button class="secondary-button" type="button" data-order-action="save">Bewaar als voorbereid</button>
        <button class="primary-button" type="button" data-order-action="open">Open in Bybit EU</button>
      </div>
      <div class="signal-inline-reasons"><b>Waarom:</b> ${plan.reasons.map(escapeHtml).join(" · ")}</div>
    </article>`;
  }

  renderRiskSummary() {
    const summary = journalSummary(this.journal);
    this.elements.journalRiskSummary.textContent = `Gepland risico: ${formatNumber(summary.cumulativePlannedRisk)} USDC`;
    this.elements.journalRiskSummary.classList.toggle("over-limit", summary.overRiskLimit);
  }

  renderJournal() {
    const summary = journalSummary(this.journal);
    this.renderRiskSummary();
    this.elements.journalSummary.innerHTML = `<div><span>Niet gesloten</span><strong>${summary.activeCount}</strong></div><div><span>Gepland risico</span><strong>${formatNumber(summary.cumulativePlannedRisk)} USDC</strong></div><div><span>Gesloten P&amp;L</span><strong class="${summary.closedPnl >= 0 ? "positive" : "negative"}">${formatNumber(summary.closedPnl)} USDC</strong></div>`;
    this.elements.journalWarning.hidden = !summary.overRiskLimit;
    this.elements.journalWarning.textContent = `Waarschuwing: het opgetelde geplande risico is hoger dan ${formatNumber(TRADE_DEFAULTS.cumulativeRiskWarningUSDC)} USDC. Nieuwe plannen worden niet geblokkeerd.`;
    if (!this.journal.length) {
      this.elements.journalList.innerHTML = `<div class="order-empty"><strong>Nog geen trades voorbereid</strong><p>Bewaar een geldige orderkaart om hier handmatig de voortgang bij te houden.</p></div>`;
      return;
    }
    this.elements.journalList.innerHTML = [...this.journal].sort((a, b) => b.preparedAt - a.preparedAt).map((entry) => `<article class="journal-entry" data-journal-id="${escapeHtml(entry.id)}">
      <div class="journal-entry-heading"><div><strong class="status-${entry.direction.toLowerCase()}">${escapeHtml(entry.symbol.replace(/USDC$/, "/USDC"))} ${entry.direction}</strong><span>${formatTime(entry.preparedAt)}</span></div><span>Planrisico ${formatNumber(entry.order.maxPlannedLoss)} USDC</span></div>
      <div class="journal-fields">
        <label>Status<select data-journal-field="status">${JOURNAL_STATUSES.map((status) => `<option value="${status}"${entry.status === status ? " selected" : ""}>${statusLabels[status]}</option>`).join("")}</select></label>
        <label>Werkelijke exit<input data-journal-field="actualExit" type="number" min="0" step="any" inputmode="decimal" value="${entry.actualExit ?? ""}" placeholder="Optioneel"></label>
        <label>Werkelijke P&amp;L (USDC)<input data-journal-field="actualPnl" type="number" step="any" inputmode="decimal" value="${entry.actualPnl ?? ""}" placeholder="Optioneel"></label>
      </div>
      <div class="journal-order-line"><span>Entry ${formatNumber(entry.order.entry)}</span><span>${formatNumber(entry.order.quantity, 6)} stuks</span><span>${entry.order.leverage}x</span><span>Stop ${formatNumber(entry.order.stop)}</span></div>
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
        } catch {
          this.notify("Kopiëren lukte niet. Controleer de browsertoestemming.");
        }
      }
      if (button.dataset.orderAction === "save") {
        const entry = createJournalEntry(this.currentPlan);
        if (!entry) return;
        this.journal.push(entry);
        this.persistJournal();
        this.renderJournal();
        button.textContent = "Bewaard in journal";
      }
      if (button.dataset.orderAction === "open") {
        window.open(this.currentPlan.bybitUrl, "_blank", "noopener,noreferrer");
      }
    });

    this.elements.openJournalButton.addEventListener("click", () => {
      this.renderJournal();
      this.elements.journalDialog.showModal();
    });
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
      } else if (["actualExit", "actualPnl"].includes(field)) {
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
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), journal: this.journal }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `bybit-eu-tradejournal-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async importJournal(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const imported = normalizeJournal(Array.isArray(parsed) ? parsed : parsed?.journal);
      if (!imported.length) throw new Error("Geen geldige regels gevonden");
      const merged = new Map(this.journal.map((entry) => [entry.id, entry]));
      imported.forEach((entry) => merged.set(entry.id, entry));
      this.journal = normalizeJournal([...merged.values()]);
      this.persistJournal();
      this.renderJournal();
      this.notify(`${imported.length} geldige journalregel(s) geïmporteerd.`);
    } catch (error) {
      this.notify(`Importeren mislukt: ${error.message}.`);
    } finally {
      this.elements.journalImportFile.value = "";
    }
  }
}
