import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname);
const port = Number(process.env.PORT) || 4173;
const allowed = [
  { match: /^\/kraken\/instruments$/, target: () => "https://futures.kraken.com/derivatives/api/v3/instruments", cache: "public, max-age=900" },
  { match: /^\/kraken\/tickers$/, target: () => "https://futures.kraken.com/derivatives/api/v3/tickers", cache: "no-store" },
  { match: /^\/kraken\/charts\/(PF_[A-Z0-9]+USD)\/(1h|4h|1d)$/, target: (match) => `https://futures.kraken.com/api/charts/v1/trade/${match[1]}/${match[2]}`, cache: "public, max-age=60" },
  { match: /^\/kraken\/funding\/(PF_[A-Z0-9]+USD)$/, target: (match) => `https://futures.kraken.com/api/charts/v1/analytics/${match[1]}/funding`, cache: "public, max-age=300" },
  { match: /^\/kraken\/spreads\/(PF_[A-Z0-9]+USD)$/, target: (match) => `https://futures.kraken.com/api/charts/v1/analytics/${match[1]}/spreads`, cache: "public, max-age=300" },
];
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8" };

async function proxy(request, response, route, match, url) {
  try {
    const upstream = new URL(route.target(match));
    url.searchParams.forEach((value, key) => upstream.searchParams.set(key, value));
    const result = await fetch(upstream, { headers: { accept: "application/json", "user-agent": "Kraken-Pro-Signal-Desk/2" } });
    response.writeHead(result.status, { "content-type": result.headers.get("content-type") || "application/json", "cache-control": route.cache });
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: `Kraken-proxy niet bereikbaar: ${error.message}` }));
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const route = allowed.map((candidate) => ({ route: candidate, match: url.pathname.match(candidate.match) })).find(({ match }) => match);
  if (route) return proxy(request, response, route.route, route.match, url);
  if (url.pathname.startsWith("/kraken/")) {
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    return response.end(JSON.stringify({ error: "Deze Kraken-proxyroute is niet toegestaan." }));
  }
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = resolve(root, `.${pathname}`);
  if (!file.startsWith(`${root}${sep}`) || !statSafe(file)) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    return response.end("Niet gevonden");
  }
  response.writeHead(200, { "content-type": mime[extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
  createReadStream(file).pipe(response);
}).listen(port, () => console.log(`Kraken Pro Futures Signal Desk: http://localhost:${port}`));

function statSafe(file) {
  try { return statSync(file).isFile(); } catch { return false; }
}
