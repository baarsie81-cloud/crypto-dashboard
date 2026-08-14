import { STRATEGY_LIMITS } from "./strategy-config.js";

export const SCORE_BANDS = Object.freeze([
  { key: "85+", label: "85+ PRIME", matches: (row) => (row.signalTier ?? row.signal_tier) === "PRIME" && Number(row.score) >= 85 },
  { key: "82-84", label: "82–84 OPPORTUNITY", matches: (row) => (row.signalTier ?? row.signal_tier) === "OPPORTUNITY" && Number(row.score) >= 82 && Number(row.score) <= 84 },
  { key: "82-84-shadow", label: "82–84 SHADOW", matches: (row) => (row.signalTier ?? row.signal_tier) === "SHADOW" && Number(row.score) >= 82 && Number(row.score) <= 84 },
  { key: "80-81", label: "80–81 SHADOW", matches: (row) => (row.signalTier ?? row.signal_tier) === "SHADOW" && Number(row.score) >= 80 && Number(row.score) <= 81 },
  { key: "78-79", label: "78–79 SHADOW", matches: (row) => (row.signalTier ?? row.signal_tier) === "SHADOW" && Number(row.score) >= 78 && Number(row.score) <= 79 },
]);

const average = (rows, selector) => rows.length ? rows.reduce((sum, row) => sum + (Number(selector(row)) || 0), 0) / rows.length : 0;
const rate = (rows, selector) => rows.length ? rows.filter(selector).length / rows.length * 100 : 0;

export function summarizeStrategyRows(rows = []) {
  const tierCounts = { PRIME: 0, OPPORTUNITY: 0, SHADOW: 0 };
  rows.forEach((row) => { if (tierCounts[row.signalTier ?? row.signal_tier] !== undefined) tierCounts[row.signalTier ?? row.signal_tier] += 1; });
  const bands = SCORE_BANDS.map((band) => {
    const bandRows = rows.filter((row) => band.matches(row));
    const evaluated = bandRows.filter((row) => ![null, undefined].includes(row.resultR ?? row.result_r) || row.ambiguous === true);
    const selected = evaluated.filter((row) => ![null, undefined].includes(row.resultR ?? row.result_r));
    return {
      key: band.key,
      label: band.label,
      setupCount: bandRows.length,
      sampleSize: selected.length,
      sufficientSample: selected.length >= STRATEGY_LIMITS.minimumAnalyticsSample,
      winRate: rate(selected, (row) => Number(row.splitResultR ?? row.split_result_r ?? row.resultR ?? row.result_r) > 0),
      t1HitRate: rate(selected, (row) => row.t1Hit === true || row.t1_hit === true),
      t2HitRate: rate(selected, (row) => row.t2Hit === true || row.t2_hit === true),
      stopRate: rate(selected, (row) => row.stopHit === true || row.stop_hit === true),
      averageMfeR: average(selected, (row) => row.mfeR ?? row.mfe_r),
      averageMaeR: average(selected, (row) => row.maeR ?? row.mae_r),
      averageResultR: average(selected, (row) => row.splitResultR ?? row.split_result_r ?? row.resultR ?? row.result_r),
      expectancyR: average(selected, (row) => row.splitResultR ?? row.split_result_r ?? row.resultR ?? row.result_r),
      ambiguousCount: evaluated.filter((row) => row.ambiguous === true).length,
    };
  });
  return { tierCounts, bands, minimumSample: STRATEGY_LIMITS.minimumAnalyticsSample };
}
