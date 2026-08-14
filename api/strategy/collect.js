import { getDatabase, databaseConfigured, isAuthorizedCollector } from "../../server/database.js";
import { collectStrategySnapshot } from "../../server/kraken-strategy-collector.js";
import { jsonResponse, requestMethod } from "../../server/http.js";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(requestMethod(request))) return jsonResponse(response, 405, { error: "Alleen GET of POST is toegestaan." }, { allow: "GET, POST" });
  if (!isAuthorizedCollector(request)) return jsonResponse(response, 401, { error: "Collector-autorisatie ontbreekt." });
  if (!databaseConfigured()) return jsonResponse(response, 503, { error: "DATABASE_URL ontbreekt; collector blijft veilig uitgeschakeld." });
  try {
    const result = await collectStrategySnapshot({ sql: getDatabase() });
    return jsonResponse(response, 200, result, { "cache-control": "no-store" });
  } catch (error) {
    console.error("Strategy collection failed", error);
    return jsonResponse(response, 503, { error: "Strategiecollectie is mislukt; er zijn geen onbetrouwbare signalen opgeslagen." });
  }
}
