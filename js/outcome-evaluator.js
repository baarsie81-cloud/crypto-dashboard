const finite = (value) => value !== null && value !== undefined && value !== "" && typeof value !== "boolean" && Number.isFinite(Number(value));
const HOUR = 60 * 60 * 1000;

function hit(candle, direction, level, type) {
  if (direction === "LONG") return type === "stop" ? Number(candle.low) <= level : Number(candle.high) >= level;
  return type === "stop" ? Number(candle.high) >= level : Number(candle.low) <= level;
}

function pendingOutcome(horizonHours, evaluatedAt, coverageReason, candleCount = 0) {
  return {
    evaluationHorizon: `${horizonHours}h`,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    outcomeStatus: "PENDING_DATA",
    dataComplete: false,
    coverageReason,
    candleCount,
    ambiguous: false,
    rawResultR: null,
    splitResultR: null,
    resultR: null,
  };
}

function coveredCandles(candles, { createdAt, horizonEnd, evaluatedAt, candleIntervalMs }) {
  const overlapping = candles
    .filter((candle) => Number(candle?.start) < horizonEnd && Number(candle?.start) + candleIntervalMs > createdAt)
    .sort((a, b) => Number(a.start) - Number(b.start));
  if (overlapping.some((candle) => ![candle.start, candle.open, candle.high, candle.low, candle.close].every(finite)
    || Number(candle.high) < Number(candle.low))) {
    return { complete: false, reason: "INVALID_CANDLE", rows: [] };
  }
  const rows = [...new Map(overlapping
    .filter((candle) => Number(candle.start) + candleIntervalMs <= evaluatedAt)
    .map((candle) => [Number(candle.start), candle])).values()];
  if (!rows.length) return { complete: false, reason: "NO_CLOSED_CANDLES", rows };
  if (Number(rows[0].start) > createdAt || Number(rows[0].start) + candleIntervalMs <= createdAt) {
    return { complete: false, reason: "START_NOT_COVERED", rows };
  }
  for (let index = 1; index < rows.length; index += 1) {
    if (Number(rows[index].start) > Number(rows[index - 1].start) + candleIntervalMs) {
      return { complete: false, reason: "CANDLE_GAP", rows };
    }
  }
  if (Number(rows.at(-1).start) + candleIntervalMs < horizonEnd) {
    return { complete: false, reason: "END_NOT_COVERED", rows };
  }
  return { complete: true, reason: null, rows };
}

export function evaluateSetupOutcome(setup, candles = [], {
  horizonHours = 24,
  evaluatedAt = Date.now(),
  candleIntervalMs = HOUR,
} = {}) {
  const direction = setup?.direction;
  const entry = Number(setup?.referenceEntry ?? setup?.reference_entry);
  const stop = Number(setup?.stopPrice ?? setup?.stop_price);
  const target1 = Number(setup?.target1 ?? setup?.target_1);
  const target2 = Number(setup?.target2 ?? setup?.target_2);
  const createdAt = Date.parse(setup?.createdAt ?? setup?.created_at);
  const risk = Math.abs(entry - stop);
  if (![entry, stop, target1, target2, createdAt, risk].every(finite) || !(risk > 0) || !["LONG", "SHORT"].includes(direction)) {
    return { outcomeStatus: "INVALIDATED", dataComplete: true, ambiguous: false, rawResultR: null, splitResultR: null, resultR: null };
  }
  const horizonEnd = createdAt + horizonHours * 60 * 60 * 1000;
  if (!finite(evaluatedAt)) {
    return { outcomeStatus: "INVALIDATED", dataComplete: true, ambiguous: false, rawResultR: null, splitResultR: null, resultR: null };
  }
  const evaluatedTime = Number(evaluatedAt);
  if (!(candleIntervalMs > 0) || evaluatedTime < horizonEnd) {
    return pendingOutcome(horizonHours, evaluatedAt, "HORIZON_NOT_COMPLETE");
  }
  const coverage = coveredCandles(candles, { createdAt, horizonEnd, evaluatedAt: evaluatedTime, candleIntervalMs });
  if (!coverage.complete) return pendingOutcome(horizonHours, evaluatedAt, coverage.reason, coverage.rows.length);
  const rows = coverage.rows;

  const sign = direction === "LONG" ? 1 : -1;
  const rr1 = sign * (target1 - entry) / risk;
  const rr2 = sign * (target2 - entry) / risk;
  let mfePrice = entry;
  let maePrice = entry;
  let t1Hit = false;
  let t2Hit = false;
  let stopHit = false;
  let t1HitAt = null;
  let t2HitAt = null;
  let stopHitAt = null;
  let outcomeStatus = "EXPIRED";
  let ambiguous = false;
  let ambiguityReason = null;
  let rawResultR = null;
  let splitResultR = null;

  for (const candle of rows) {
    if (direction === "LONG") {
      if (Number(candle.high) > mfePrice) mfePrice = Number(candle.high);
      if (Number(candle.low) < maePrice) maePrice = Number(candle.low);
    } else {
      if (Number(candle.low) < mfePrice) mfePrice = Number(candle.low);
      if (Number(candle.high) > maePrice) maePrice = Number(candle.high);
    }
    const candleStop = hit(candle, direction, stop, "stop");
    const candleT1 = !t1Hit && hit(candle, direction, target1, "target");
    const candleT2 = hit(candle, direction, target2, "target");
    if (candleStop && (candleT1 || (t1Hit && candleT2))) {
      ambiguous = true;
      ambiguityReason = t1Hit
        ? "Stop en Target 2 liggen in dezelfde candle; volgorde is onbekend"
        : "Stop en target liggen in dezelfde candle; volgorde is onbekend";
      outcomeStatus = "AMBIGUOUS";
      break;
    }
    if (candleStop) {
      stopHit = true;
      stopHitAt = new Date(Number(candle.start)).toISOString();
      outcomeStatus = "STOPPED";
      rawResultR = -1;
      splitResultR = t1Hit ? 0.5 * rr1 - 0.5 : -1;
      break;
    }
    if (candleT1) {
      t1Hit = true;
      t1HitAt = new Date(Number(candle.start)).toISOString();
    }
    if (candleT2) {
      if (!t1Hit) {
        t1Hit = true;
        t1HitAt = new Date(Number(candle.start)).toISOString();
      }
      t2Hit = true;
      t2HitAt = new Date(Number(candle.start)).toISOString();
      outcomeStatus = "T2_HIT";
      rawResultR = rr2;
      splitResultR = 0.5 * rr1 + 0.5 * rr2;
      break;
    }
  }

  const last = rows.at(-1);
  const closePrice24h = Number(last.close);
  if (!ambiguous && rawResultR === null) {
    const closeR = sign * (closePrice24h - entry) / risk;
    rawResultR = closeR;
    splitResultR = t1Hit ? 0.5 * rr1 + 0.5 * closeR : closeR;
    if (t1Hit) outcomeStatus = "T1_HIT";
  }
  const mfeR = sign * (mfePrice - entry) / risk;
  const maeR = sign * (maePrice - entry) / risk;
  return {
    evaluationHorizon: `${horizonHours}h`,
    evaluatedAt: new Date(evaluatedAt).toISOString(),
    mfePrice,
    maePrice,
    mfePct: sign * (mfePrice - entry) / entry * 100,
    maePct: sign * (maePrice - entry) / entry * 100,
    mfeR,
    maeR,
    t1Hit,
    t1HitAt,
    t2Hit,
    t2HitAt,
    stopHit,
    stopHitAt,
    closePrice24h,
    rawResultR,
    splitResultR,
    resultR: splitResultR,
    outcomeStatus,
    dataComplete: true,
    coverageReason: null,
    candleCount: rows.length,
    ambiguous,
    ambiguityReason,
  };
}
