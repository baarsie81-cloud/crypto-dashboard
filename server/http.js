export function jsonResponse(response, status, payload, headers = {}) {
  Object.entries({ "content-type": "application/json; charset=utf-8", ...headers }).forEach(([key, value]) => response.setHeader?.(key, value));
  response.statusCode = status;
  if (typeof response.status === "function" && typeof response.json === "function") return response.status(status).json(payload);
  return response.end(JSON.stringify(payload));
}

export function requestMethod(request) {
  return String(request?.method || "GET").toUpperCase();
}
