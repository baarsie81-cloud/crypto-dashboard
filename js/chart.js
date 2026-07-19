import { ema } from "./indicators.js";

const COLORS = {
  grid: "rgba(132, 153, 163, 0.14)",
  text: "#94a3aa",
  green: "#62d44c",
  red: "#ff5656",
  amber: "#ffbd2e",
  blue: "#3497e9",
  zone: "rgba(98, 212, 76, 0.12)",
};

function compactNumber(value) {
  return Intl.NumberFormat("nl-NL", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}
function priceLabel(value) {
  if (!Number.isFinite(value)) return "—";
  const digits = value < 0.001 ? 8 : value < 1 ? 5 : value < 100 ? 3 : 1;
  return value.toLocaleString("nl-NL", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export class SignalChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d");
    this.data = { candles: [], signal: null, interval: "60" };
    this.resizeObserver = new ResizeObserver(() => this.draw());
    this.resizeObserver.observe(canvas.parentElement);
  }

  update(candles, signal, interval = "60") {
    this.data = { candles: (candles || []).slice(-100), signal, interval };
    this.draw();
  }

  draw() {
    const { candles, signal } = this.data;
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(rect.width * ratio);
    this.canvas.height = Math.round(rect.height * ratio);
    const context = this.context;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);
    if (candles.length < 3) {
      context.fillStyle = COLORS.text;
      context.font = "500 14px system-ui";
      context.fillText("Candles worden geladen…", 22, 36);
      return;
    }

    const width = rect.width;
    const height = rect.height;
    const margins = { top: 24, right: 76, bottom: 28, left: 12 };
    const volumeHeight = Math.max(55, height * 0.19);
    const priceBottom = height - margins.bottom - volumeHeight - 10;
    const plotWidth = width - margins.left - margins.right;
    const planPrices = signal?.plan
      ? [signal.plan.entryLow, signal.plan.entryHigh, signal.plan.stop, signal.plan.target1, signal.plan.target2]
      : [];
    const lows = candles.map((candle) => candle.low).concat(planPrices);
    const highs = candles.map((candle) => candle.high).concat(planPrices);
    let minPrice = Math.min(...lows);
    let maxPrice = Math.max(...highs);
    const padding = (maxPrice - minPrice || maxPrice * 0.01) * 0.08;
    minPrice -= padding;
    maxPrice += padding;
    const x = (index) => margins.left + (index + 0.5) * (plotWidth / candles.length);
    const y = (price) => margins.top + (maxPrice - price) / (maxPrice - minPrice) * (priceBottom - margins.top);

    context.lineWidth = 1;
    context.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (let line = 0; line <= 5; line += 1) {
      const py = margins.top + (priceBottom - margins.top) / 5 * line;
      const price = maxPrice - (maxPrice - minPrice) / 5 * line;
      context.strokeStyle = COLORS.grid;
      context.beginPath();
      context.moveTo(margins.left, py);
      context.lineTo(width - margins.right, py);
      context.stroke();
      context.fillStyle = COLORS.text;
      context.fillText(priceLabel(price), width - margins.right + 9, py + 4);
    }

    if (signal?.plan) {
      const { entryLow, entryHigh, stop, target1, target2 } = signal.plan;
      context.fillStyle = COLORS.zone;
      context.fillRect(margins.left, y(entryHigh), plotWidth, Math.max(2, y(entryLow) - y(entryHigh)));
      const levels = [
        { value: stop, label: "Stop", color: COLORS.red },
        { value: target1, label: "Doel 1", color: COLORS.green },
        { value: target2, label: "Doel 2", color: COLORS.green },
      ];
      context.setLineDash([5, 5]);
      levels.forEach(({ value, label, color }) => {
        context.strokeStyle = color;
        context.beginPath();
        context.moveTo(width - margins.right - Math.min(280, plotWidth * 0.35), y(value));
        context.lineTo(width - margins.right, y(value));
        context.stroke();
        context.fillStyle = color;
        context.fillText(`${label}  ${priceLabel(value)}`, width - margins.right - 130, y(value) - 6);
      });
      context.setLineDash([]);
    }

    const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);
    const candleWidth = Math.max(2, Math.min(9, plotWidth / candles.length * 0.66));
    candles.forEach((candle, index) => {
      const bullish = candle.close >= candle.open;
      const color = bullish ? COLORS.green : COLORS.red;
      const px = x(index);
      context.strokeStyle = color;
      context.beginPath();
      context.moveTo(px, y(candle.high));
      context.lineTo(px, y(candle.low));
      context.stroke();
      context.fillStyle = color;
      const top = y(Math.max(candle.open, candle.close));
      const bottom = y(Math.min(candle.open, candle.close));
      context.fillRect(px - candleWidth / 2, top, candleWidth, Math.max(1.5, bottom - top));
      const volumeTop = height - margins.bottom - candle.volume / maxVolume * volumeHeight;
      context.globalAlpha = 0.58;
      context.fillRect(px - candleWidth / 2, volumeTop, candleWidth, height - margins.bottom - volumeTop);
      context.globalAlpha = 1;
    });

    const closes = candles.map((candle) => candle.close);
    const lines = [
      { values: ema(closes, 20), color: COLORS.blue },
      { values: ema(closes, 50), color: COLORS.amber },
    ];
    lines.forEach(({ values, color }) => {
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.beginPath();
      let started = false;
      values.forEach((value, index) => {
        if (!Number.isFinite(value)) return;
        if (!started) { context.moveTo(x(index), y(value)); started = true; }
        else context.lineTo(x(index), y(value));
      });
      context.stroke();
    });

    context.fillStyle = COLORS.text;
    context.font = "11px system-ui";
    const labelStep = Math.max(1, Math.floor(candles.length / 5));
    candles.forEach((candle, index) => {
      if (index % labelStep !== 0) return;
      const date = new Date(candle.start);
      const label = this.data.interval === "D"
        ? date.toLocaleDateString("nl-NL", { day: "numeric", month: "short" })
        : date.toLocaleDateString("nl-NL", { day: "numeric", month: "short", hour: "2-digit" });
      context.fillText(label, x(index) - 16, height - 8);
    });
    context.fillStyle = COLORS.green;
    context.fillText(`Volume ${compactNumber(candles.at(-1).volume)}`, margins.left + 8, priceBottom + 28);
  }
}
