import { getDatabase, databaseConfigured, isAuthorizedCollector } from "../../server/database.js";
import { jsonResponse, requestMethod } from "../../server/http.js";
import { runPaperExecution } from "../../server/paper-runner.js";

export const config = { maxDuration: 60 };

export default async function handler(request, response) {
  if (!["GET", "POST"].includes(requestMethod(request))) return jsonResponse(response, 405, { error: "Alleen GET of POST is toegestaan." }, { allow: "GET, POST" });
  if (!isAuthorizedCollector(request)) return jsonResponse(response, 401, { error: "Paper-runner autorisatie ontbreekt." });
  if (!databaseConfigured()) return jsonResponse(response, 503, { error: "DATABASE_URL ontbreekt; paper execution blijft veilig uitgeschakeld." });
  try {
    const result = await runPaperExecution({ sql: getDatabase() });
    return jsonResponse(response, 200, result, { "cache-control": "no-store" });
  } catch (error) {
    console.error("Paper execution failed", error);
    return jsonResponse(response, 503, { error: "Paper execution is mislukt." }, { "cache-control": "no-store" });
  }
}
