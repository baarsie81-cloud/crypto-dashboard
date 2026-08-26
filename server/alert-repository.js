import { createPaperTradeFromAlert } from "./paper-repository.js";

export async function recordSentTradeAlert(sql, { alertKey, symbol, direction, score, tradeQuality, setupFingerprint, payload, sentAt } = {}) {
  if (!alertKey || !symbol || !direction || !setupFingerprint || !payload) throw new Error("Ongeldig alertrecord");
  const rows = await sql.query(`
    INSERT INTO public.sent_trade_alerts (
      alert_key,symbol,direction,score,trade_quality,setup_fingerprint,payload,sent_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    ON CONFLICT(alert_key) DO NOTHING
    RETURNING id,alert_key,sent_at
  `, [
    alertKey,
    symbol,
    direction,
    Math.round(Number(score) || 0),
    tradeQuality || "UNKNOWN",
    setupFingerprint,
    JSON.stringify(payload),
    sentAt || new Date().toISOString(),
  ]);
  const saved = rows[0] || null;
  if (saved) {
    try {
      await createPaperTradeFromAlert(sql, {
        sourceAlertKey: alertKey,
        alert: payload,
        createdAt: saved.sent_at,
      });
    } catch (error) {
      console.warn("Paper order kon niet direct worden aangemaakt; backfill herstelt dit later", error);
    }
  }
  return saved;
}
