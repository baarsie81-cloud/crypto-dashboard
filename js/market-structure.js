const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function pivots(candles, radius = 2) {
  const highs = [];
  const lows = [];
  for (let index = radius; index < candles.length - radius; index += 1) {
    const row = candles[index];
    const window = candles.slice(index - radius, index + radius + 1);
    if (window.every((candidate) => Number(row.high) >= Number(candidate.high))) highs.push({ price: Number(row.high), index, start: row.start });
    if (window.every((candidate) => Number(row.low) <= Number(candidate.low))) lows.push({ price: Number(row.low), index, start: row.start });
  }
  return { highs, lows };
}

function cluster(points, tolerancePct) {
  const zones = [];
  for (const point of points.sort((a, b) => a.price - b.price)) {
    const existing = zones.find((zone) => Math.abs(zone.price - point.price) / zone.price * 100 <= tolerancePct);
    if (existing) {
      existing.points.push(point);
      existing.price = existing.points.reduce((sum, item) => sum + item.price, 0) / existing.points.length;
      existing.lastIndex = Math.max(existing.lastIndex, point.index);
    } else zones.push({ price: point.price, points: [point], lastIndex: point.index });
  }
  return zones.map((zone) => ({ ...zone, touches: zone.points.length }));
}

export function detectMarketStructure(candles = [], { atrValue, currentPrice } = {}) {
  const rows = candles.filter((row) => finite(row.high) && finite(row.low) && finite(row.close));
  if (rows.length < 30) return { supports: [], resistances: [], nearestSupport: null, nearestResistance: null, range: null };
  const price = Number(currentPrice) || Number(rows.at(-1).close);
  const atr = Number(atrValue) || price * 0.01;
  const tolerancePct = clamp((atr / price) * 35, 0.15, 1.2);
  const { highs, lows } = pivots(rows.slice(-120), 2);
  const rank = (zone) => zone.touches * 10 + zone.lastIndex / Math.max(rows.length, 1);
  const supports = cluster(lows, tolerancePct).filter((zone) => zone.price < price).sort((a, b) => rank(b) - rank(a) || b.price - a.price);
  const resistances = cluster(highs, tolerancePct).filter((zone) => zone.price > price).sort((a, b) => rank(b) - rank(a) || a.price - b.price);
  const width = Math.max(atr * 0.25, price * 0.001);
  const toZone = (zone) => zone ? { ...zone, low: zone.price - width, high: zone.price + width } : null;
  const recent = rows.slice(-20);
  return {
    supports: supports.slice(0, 4).map(toZone),
    resistances: resistances.slice(0, 4).map(toZone),
    nearestSupport: toZone(supports.sort((a, b) => b.price - a.price)[0]),
    nearestResistance: toZone(resistances.sort((a, b) => a.price - b.price)[0]),
    range: { low: Math.min(...recent.map((row) => Number(row.low))), high: Math.max(...recent.map((row) => Number(row.high))) },
  };
}

export function buildStructureSetup({ bias, price, atrValue, structure, volumeRatio = 1 }) {
  if (!["LONG", "SHORT"].includes(bias) || !finite(price) || !finite(atrValue)) return null;
  const atr = Number(atrValue);
  const support = structure?.nearestSupport;
  const resistance = structure?.nearestResistance;
  if (bias === "LONG") {
    const room = resistance ? resistance.low - price : atr * 3;
    if (resistance && room < atr * 0.75) {
      const trigger = resistance.high;
      return { type: "BREAKOUT_RETEST", entry: trigger, entryLow: resistance.low, entryHigh: resistance.high, stop: resistance.low - atr * 0.65, target1: trigger + atr * 1.5, target2: trigger + atr * 2.7, waitFor: `Wacht op een overtuigende close boven ${trigger.toFixed(2)} en een succesvolle terugtest van de uitbraakzone.`, confirmed: false };
    }
    const entry = support ? support.high : price - atr * 0.5;
    return { type: "PULLBACK_SUPPORT", entry, entryLow: support?.low ?? entry - atr * 0.2, entryHigh: support?.high ?? entry + atr * 0.2, stop: (support?.low ?? entry) - atr * 0.75, target1: resistance?.low ?? entry + atr * 1.8, target2: resistance?.high ? resistance.high + atr : entry + atr * 3, waitFor: "Wacht op een bullish rejection in de steunzone met volume boven het 20-candle gemiddelde.", confirmed: Boolean(support && price >= support.low && price <= support.high && volumeRatio >= 1.1) };
  }
  const room = support ? price - support.high : atr * 3;
  if (support && room < atr * 0.75) {
    const trigger = support.low;
    return { type: "BREAKDOWN_RETEST", entry: trigger, entryLow: support.low, entryHigh: support.high, stop: support.high + atr * 0.65, target1: trigger - atr * 1.5, target2: trigger - atr * 2.7, waitFor: `Wacht op een overtuigende close onder ${trigger.toFixed(2)} en een mislukte terugtest van de gebroken steun.`, confirmed: false };
  }
  const entry = resistance ? resistance.low : price + atr * 0.5;
  return { type: "REJECTION_RESISTANCE", entry, entryLow: resistance?.low ?? entry - atr * 0.2, entryHigh: resistance?.high ?? entry + atr * 0.2, stop: (resistance?.high ?? entry) + atr * 0.75, target1: support?.high ?? entry - atr * 1.8, target2: support?.low ? support.low - atr : entry - atr * 3, waitFor: "Wacht op een bearish rejection in de weerstandzone met duidelijke verkoopdruk.", confirmed: Boolean(resistance && price >= resistance.low && price <= resistance.high && volumeRatio >= 1.1) };
}
