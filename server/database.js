import { neon } from "@neondatabase/serverless";

let cachedUrl;
let cachedSql;

export function databaseConfigured(env = process.env) {
  return typeof env.DATABASE_URL === "string" && env.DATABASE_URL.startsWith("postgres");
}

export function getDatabase(env = process.env) {
  if (!databaseConfigured(env)) throw new Error("DATABASE_URL ontbreekt; de Neon-laag is nog niet geactiveerd");
  if (!cachedSql || cachedUrl !== env.DATABASE_URL) {
    cachedUrl = env.DATABASE_URL;
    cachedSql = neon(cachedUrl);
  }
  return cachedSql;
}

export function isAuthorizedCollector(request, env = process.env) {
  const expected = env.CRON_SECRET || env.SIGNAL_INGEST_TOKEN;
  if (!expected) return false;
  const header = request?.headers?.authorization || request?.headers?.get?.("authorization") || "";
  return header === `Bearer ${expected}`;
}
