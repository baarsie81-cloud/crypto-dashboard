import { getDatabase, databaseConfigured } from "../../server/database.js";
import { analyticsRows } from "../../server/setup-repository.js";
import { summarizeStrategyRows } from "../../js/strategy-analytics.js";
import { jsonResponse, requestMethod } from "../../server/http.js";
import { STRATEGY_VERSION } from "../../js/strategy-config.js";

export default async function handler(request, response) {
  if (requestMethod(request) !== "GET") return jsonResponse(response, 405, { error: "Alleen GET is toegestaan." }, { allow: "GET" });
  if (!databaseConfigured()) return jsonResponse(response, 200, {
    configured: false,
    strategyVersion: STRATEGY_VERSION,
    ...summarizeStrategyRows([]),
    message: "Neon is lokaal of in deze deployment nog niet geconfigureerd.",
  }, { "cache-control": "no-store" });
  try {
    const summary = summarizeStrategyRows(await analyticsRows(getDatabase()));
    return jsonResponse(response, 200, { configured: true, strategyVersion: STRATEGY_VERSION, generatedAt: new Date().toISOString(), ...summary }, { "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120" });
  } catch (error) {
    console.error("Strategy analytics failed", error);
    return jsonResponse(response, 503, { error: "Strategievalidatie is tijdelijk niet beschikbaar." }, { "cache-control": "no-store" });
  }
}
