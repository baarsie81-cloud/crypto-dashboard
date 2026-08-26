import { getDatabase, databaseConfigured } from "../../server/database.js";
import { jsonResponse, requestMethod } from "../../server/http.js";
import { PAPER_EXECUTION_VERSION } from "../../js/paper-execution.js";
import { paperAnalyticsRows } from "../../server/paper-repository.js";

const avg = (rows, fn) => rows.length ? rows.reduce((sum, row) => sum + (Number(fn(row)) || 0), 0) / rows.length : 0;
const rate = (rows, fn) => rows.length ? rows.filter(fn).length / rows.length * 100 : 0;

function summarize(rows) {
  const lanes = {};
  for (const lane of ["PRIME", "OPPORTUNITY", "HIGH_BETA"]) {
    const all = rows.filter((row) => row.lane === lane);
    const closed = all.filter((row) => row.status === "CLOSED" && row.result_r !== null);
    lanes[lane] = {
      total: all.length,
      open: all.filter((row) => row.status === "OPEN").length,
      closed: closed.length,
      expectancyR: avg(closed, (row) => row.result_r),
      winRate: rate(closed, (row) => Number(row.result_r) > 0),
      t1HitRate: rate(closed, (row) => row.t1_hit === true),
      t2HitRate: rate(closed, (row) => row.t2_hit === true),
      stopRate: rate(closed, (row) => row.stop_hit === true),
      netResultUsd: closed.reduce((sum, row) => sum + (Number(row.net_result_usd) || 0), 0),
      feesUsd: closed.reduce((sum, row) => sum + (Number(row.fees_usd) || 0), 0),
      modeledSlippageUsd: closed.reduce((sum, row) => sum + (Number(row.slippage_usd) || 0), 0),
    };
  }
  const closed = rows.filter((row) => row.status === "CLOSED" && row.result_r !== null);
  return {
    total: rows.length,
    open: rows.filter((row) => row.status === "OPEN").length,
    closed: closed.length,
    expectancyR: avg(closed, (row) => row.result_r),
    winRate: rate(closed, (row) => Number(row.result_r) > 0),
    netResultUsd: closed.reduce((sum, row) => sum + (Number(row.net_result_usd) || 0), 0),
    lanes,
  };
}

export default async function handler(request, response) {
  if (requestMethod(request) !== "GET") return jsonResponse(response, 405, { error: "Alleen GET is toegestaan." }, { allow: "GET" });
  if (!databaseConfigured()) return jsonResponse(response, 200, { configured: false, paperVersion: PAPER_EXECUTION_VERSION, ...summarize([]) }, { "cache-control": "no-store" });
  try {
    const rows = await paperAnalyticsRows(getDatabase());
    return jsonResponse(response, 200, { configured: true, paperVersion: PAPER_EXECUTION_VERSION, generatedAt: new Date().toISOString(), ...summarize(rows) }, { "cache-control": "public, max-age=20, s-maxage=30" });
  } catch (error) {
    console.error("Paper analytics failed", error);
    return jsonResponse(response, 503, { error: "Paper analytics is tijdelijk niet beschikbaar." }, { "cache-control": "no-store" });
  }
}
