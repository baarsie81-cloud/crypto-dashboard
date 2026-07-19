export const CORE_PAIRS = Object.freeze([
  { symbol: "BTCUSDC", label: "BTC/USDC", base: "BTC" },
  { symbol: "ETHUSDC", label: "ETH/USDC", base: "ETH" },
  { symbol: "SOLUSDC", label: "SOL/USDC", base: "SOL" },
  { symbol: "XRPUSDC", label: "XRP/USDC", base: "XRP" },
  { symbol: "DOGEUSDC", label: "DOGE/USDC", base: "DOGE" },
  { symbol: "HYPEUSDC", label: "HYPE/USDC", base: "HYPE" },
  { symbol: "AVAXUSDC", label: "AVAX/USDC", base: "AVAX" },
  { symbol: "AAVEUSDC", label: "AAVE/USDC", base: "AAVE" },
]);

export const API_BASE = "https://api.bybit.eu";
export const WS_URL = "wss://stream.bybit.eu/v5/public/spot";

export const TIMEFRAMES = Object.freeze({
  "60": { label: "1u", milliseconds: 60 * 60 * 1000, history: 260 },
  "240": { label: "4u", milliseconds: 4 * 60 * 60 * 1000, history: 260 },
  D: { label: "1d", milliseconds: 24 * 60 * 60 * 1000, history: 260 },
});
export const STORAGE_KEYS = Object.freeze({
  settings: "bybit-eu-signal-settings-v1",
  snapshot: "bybit-eu-market-cache-v1",
  backtest: "bybit-eu-backtest-v1",
});

export const SIGNAL_LIMITS = Object.freeze({
  staleAfterMs: 60_000,
  actionableScore: 70,
  watchScore: 55,
  actionableSpreadPct: 0.15,
  maximumSpreadPct: 0.25,
  defaultMaxLeverage: 10,
});
