export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
export function average(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

export function sma(values, period) {
  const output = Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return output;
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    sum += Number.isFinite(value) ? value : 0;
    if (index >= period) {
      const previous = Number(values[index - period]);
      sum -= Number.isFinite(previous) ? previous : 0;
    }
    if (index >= period - 1) output[index] = sum / period;
  }
  return output;
}

export function ema(values, period) {
  const output = Array(values.length).fill(null);
  if (!Number.isInteger(period) || period < 1 || values.length < period) return output;
  const seed = average(values.slice(0, period).map(Number));
  if (!Number.isFinite(seed)) return output;
  const multiplier = 2 / (period + 1);
  output[period - 1] = seed;
  for (let index = period; index < values.length; index += 1) {
    const value = Number(values[index]);
    output[index] = Number.isFinite(value)
      ? (value - output[index - 1]) * multiplier + output[index - 1]
      : output[index - 1];
  }
  return output;
}

export function rsi(values, period = 14) {
  const output = Array(values.length).fill(null);
  if (values.length <= period) return output;
  let gains = 0;
  let losses = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = Number(values[index]) - Number(values[index - 1]);
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }
  let averageGain = gains / period;
  let averageLoss = losses / period;
  output[period] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  for (let index = period + 1; index < values.length; index += 1) {
    const change = Number(values[index]) - Number(values[index - 1]);
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    output[index] = averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss);
  }
  return output;
}

export function macd(values, fast = 12, slow = 26, signalPeriod = 9) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = values.map((_, index) => {
    if (!Number.isFinite(fastLine[index]) || !Number.isFinite(slowLine[index])) return null;
    return fastLine[index] - slowLine[index];
  });

  const compact = line.filter(Number.isFinite);
  const compactSignal = ema(compact, signalPeriod);
  const signal = Array(values.length).fill(null);
  let compactIndex = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (!Number.isFinite(line[index])) continue;
    signal[index] = compactSignal[compactIndex];
    compactIndex += 1;
  }
  const histogram = line.map((value, index) =>
    Number.isFinite(value) && Number.isFinite(signal[index]) ? value - signal[index] : null,
  );
  return { line, signal, histogram };
}

export function atr(candles, period = 14) {
  const ranges = candles.map((candle, index) => {
    const high = Number(candle.high);
    const low = Number(candle.low);
    if (index === 0) return high - low;
    const previousClose = Number(candles[index - 1].close);
    return Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  });
  const output = Array(candles.length).fill(null);
  if (candles.length < period) return output;
  let value = average(ranges.slice(0, period));
  output[period - 1] = value;
  for (let index = period; index < ranges.length; index += 1) {
    value = (value * (period - 1) + ranges[index]) / period;
    output[index] = value;
  }
  return output;
}

export function closedCandles(candles, intervalMs, nowMs = Date.now()) {
  return candles.filter((candle) => Number(candle.start) + intervalMs <= nowMs);
}

export function lastFinite(values, offset = 0) {
  let skipped = 0;
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (!Number.isFinite(values[index])) continue;
    if (skipped === offset) return values[index];
    skipped += 1;
  }
  return null;
}
