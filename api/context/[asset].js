const ALLOWED = new Set(["btc", "eth"]);
const clamp = (n, min, max) => Math.min(max, Math.max(min, Number(n) || 0));

async function json(url, timeout = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": "crypto-dashboard-context/1.0" }, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function scoreMomentum(change24h, change7d) {
  return clamp((Number(change24h) || 0) * 4 + (Number(change7d) || 0) * 1.2, -100, 100);
}

function scoreSentiment(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  // Sentiment is intentionally contrarian only at extremes and weak near neutral.
  if (n <= 15) return 30;
  if (n <= 30) return 12;
  if (n >= 85) return -30;
  if (n >= 70) return -12;
  return clamp((n - 50) * 0.2, -5, 5);
}

function component(score, confidence, summary, sources = []) {
  return { score: clamp(score, -100, 100), confidence: clamp(confidence, 0, 100), summary, sources };
}

export default async function handler(request, response) {
  const asset = String(request.query?.asset || "").toLowerCase();
  if (!ALLOWED.has(asset)) return response.status(404).json({ error: "unknown asset" });
  const now = Date.now();
  const slug = asset === "btc" ? "bitcoin" : "ethereum";
  const sources = [];
  let ticker = null;
  let fearGreed = null;
  try {
    const payload = await json(`https://api.alternative.me/v2/ticker/${slug}/?structure=array`);
    ticker = Array.isArray(payload?.data) ? payload.data[0] : Object.values(payload?.data || {})[0];
    sources.push({ name: "Alternative.me Crypto API", url: `https://api.alternative.me/v2/ticker/${slug}/`, publishedAt: Number(ticker?.last_updated) * 1000 || now });
  } catch {}
  try {
    const payload = await json("https://api.alternative.me/fng/?limit=1&format=json");
    fearGreed = payload?.data?.[0] || null;
    sources.push({ name: "Alternative.me Fear & Greed", url: "https://api.alternative.me/fng/", publishedAt: Number(fearGreed?.timestamp) * 1000 || now });
  } catch {}

  const quote = ticker?.quotes?.USD || {};
  const change24h = Number(quote.percentage_change_24h);
  const change7d = Number(quote.percentage_change_7d);
  const momentum = Number.isFinite(change24h) ? scoreMomentum(change24h, change7d) : 0;
  const sentiment = fearGreed ? scoreSentiment(fearGreed.value) : 0;
  const marketConfidence = ticker ? 80 : 0;
  const sentimentConfidence = fearGreed ? 65 : 0;
  const marketSources = sources.filter((source) => source.name.includes("Crypto API"));
  const sentimentSources = sources.filter((source) => source.name.includes("Fear & Greed"));

  const components = {
    macro: component(0, 0, "Geen betrouwbare keyless macrofeed gekoppeld; neutraal en zonder score-impact."),
    etf: component(0, 0, "Geen betrouwbare keyless ETF-flowfeed gekoppeld; neutraal en zonder score-impact."),
    onchain: component(momentum * 0.35, marketConfidence * 0.6, ticker ? `Publieke marktproxy: ${change24h.toFixed(2)}% in 24u en ${Number(change7d || 0).toFixed(2)}% in 7d.` : "Marktproxy niet beschikbaar.", marketSources),
    stablecoins: component(0, 0, "Geen gevalideerde stablecoin-liquidityfeed gekoppeld; neutraal."),
    regulation: component(0, 0, "Regelgevingsnieuws vereist geverifieerde event-input; neutraal zonder event."),
    security: component(0, 0, "Security-events vereisen geverifieerde event-input; neutraal zonder event."),
    news: component(sentiment + momentum * 0.15, Math.max(sentimentConfidence, marketConfidence * 0.5), fearGreed ? `Sentiment ${fearGreed.value}/100 (${fearGreed.value_classification}); gecombineerd met recente marktbeweging.` : "Alleen marktbeweging beschikbaar.", [...sentimentSources, ...marketSources]),
  };
  const active = Object.values(components).filter((item) => item.confidence >= 35 && item.sources?.length);
  const confidence = active.length ? active.reduce((sum, item) => sum + item.confidence, 0) / active.length : 0;
  const uniqueSources = [...new Map(sources.map((source) => [source.url, source])).values()];
  const generatedAt = now;
  response.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=120");
  return response.status(200).json({
    version: 1,
    asset: asset.toUpperCase(),
    generatedAt,
    expiresAt: generatedAt + 10 * 60 * 1000,
    confidence: Math.round(confidence),
    components,
    sources: uniqueSources,
    producer: { mode: "automatic-public-data", limitations: ["Geen ETF/macro/on-chain-provider wordt gegokt wanneer een betrouwbare keyless feed ontbreekt.", "Deze producer kan geen trade vrijgeven; technische setup en L2-gates blijven leidend."] },
  });
}
