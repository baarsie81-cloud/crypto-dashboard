export const REST_BASE = "/kraken";
export const WS_URL = "wss://futures.kraken.com/ws/v1";
export const PRODUCTION_URL = "https://crypto-dashboard-mu-two.vercel.app";
export const KRAKEN_PRO_URL = "https://pro.kraken.com/app/trade";

export const TIMEFRAMES = Object.freeze({
  "60": { label: "1u", resolution: "1h", milliseconds: 60 * 60 * 1000 },
  "240": { label: "4u", resolution: "4h", milliseconds: 4 * 60 * 60 * 1000 },
  D: { label: "1d", resolution: "1d", milliseconds: 24 * 60 * 60 * 1000 },
});

export const MARKET_LIMITS = Object.freeze({
  topMarkets: 30,
  scanHistory: 120,
  chartHistory: 320,
  cachedMarkets: 40,
  rankingRefreshMs: 15 * 60 * 1000,
  restFallbackMs: 60 * 1000,
});

export const STORAGE_KEYS = Object.freeze({
  settings: "kraken-pro-futures-settings-v3",
  snapshot: "kraken-pro-futures-market-cache-v3",
  backtest: "kraken-pro-futures-backtest-v3",
  tradeJournal: "kraken-pro-futures-trade-journal-v3",
});

export const SIGNAL_LIMITS = Object.freeze({
  staleAfterMs: 60_000,
  actionableScore: 80,
  actionableConfidence: 75,
  actionableSetupConfidence: 78,
  watchScore: 65,
  actionableSpreadPct: 0.10,
  maximumSpreadPct: 0.20,
  maximumEstimatedSlippagePct: 0.15,
  minimumBookDepthMultiple: 5,
  adverseFundingPctPerHour: 0.05,
  adversePremiumPct: 0.5,
  defaultMaxLeverage: 3,
  absoluteMaxLeverage: 4,
});

export const TRADE_DEFAULTS = Object.freeze({
  budgetEUR: 20,
  accountEquityEUR: 1000,
  riskPct: 1,
  maximumRiskPct: 2,
  maximumPortfolioRiskPct: 5,
  expectedHoldingHours: 24,
  makerFeeRatePerSide: 0.0002,
  takerFeeRatePerSide: 0.0005,
  defaultSlippagePct: 0.05,
  cumulativeRiskWarningEUR: 20,
});

export const CRYPTO_CATEGORIES = Object.freeze(new Set([
  "AI", "Community", "DEX", "DeFi", "DePIN", "Gaming", "Infrastructure",
  "Interoperability", "Layer 1", "Layer 2", "Meme", "NFT", "Privacy",
  "Real-world assets", "Stablecoin", "Utility", "Web3",
]));
