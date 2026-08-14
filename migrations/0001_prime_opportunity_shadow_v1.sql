BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS trade_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  market text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  initial_score smallint NOT NULL CHECK (initial_score BETWEEN 0 AND 100),
  signal_tier text NOT NULL CHECK (signal_tier IN ('PRIME', 'OPPORTUNITY', 'SHADOW')),
  risk_class numeric(4,2) NOT NULL CHECK (risk_class IN (1.00, 0.25, 0.00)),
  trade_quality text NOT NULL,
  confidence smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  setup_confidence smallint NOT NULL CHECK (setup_confidence BETWEEN 0 AND 100),
  setup_type text NOT NULL,
  entry_low numeric NOT NULL,
  entry_high numeric NOT NULL,
  reference_entry numeric NOT NULL,
  stop_price numeric NOT NULL,
  target_1 numeric NOT NULL,
  target_2 numeric NOT NULL,
  rr_target_1 numeric,
  rr_target_2 numeric,
  btc_regime text,
  btc_opposing_prime boolean NOT NULL DEFAULT false,
  technical_trigger text,
  trigger_confirmed boolean NOT NULL DEFAULT false,
  execution_score numeric,
  liquidity_score numeric,
  spread numeric,
  slippage numeric,
  orderbook_depth numeric,
  open_interest numeric,
  funding_rate numeric,
  volume_24h numeric,
  lifecycle_key text NOT NULL,
  dedupe_key text NOT NULL,
  strategy_version text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PROMOTED', 'INVALIDATED', 'MISSED_ENTRY', 'CHASE_BLOCKED')),
  parent_setup_id uuid REFERENCES trade_setups(id) ON DELETE SET NULL,
  previous_tier text CHECK (previous_tier IS NULL OR previous_tier IN ('PRIME', 'OPPORTUNITY', 'SHADOW')),
  promoted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (entry_low <= entry_high),
  CHECK (
    (direction = 'LONG' AND stop_price < reference_entry AND target_1 > reference_entry AND target_2 > reference_entry)
    OR
    (direction = 'SHORT' AND stop_price > reference_entry AND target_1 < reference_entry AND target_2 < reference_entry)
  )
);

CREATE TABLE IF NOT EXISTS setup_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id uuid NOT NULL REFERENCES trade_setups(id) ON DELETE CASCADE,
  evaluation_horizon text NOT NULL,
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  mfe_price numeric,
  mae_price numeric,
  mfe_pct numeric,
  mae_pct numeric,
  mfe_r numeric,
  mae_r numeric,
  t1_hit boolean NOT NULL DEFAULT false,
  t1_hit_at timestamptz,
  t2_hit boolean NOT NULL DEFAULT false,
  t2_hit_at timestamptz,
  stop_hit boolean NOT NULL DEFAULT false,
  stop_hit_at timestamptz,
  close_price_24h numeric,
  raw_result_r numeric,
  split_result_r numeric,
  result_r numeric,
  outcome_status text NOT NULL CHECK (outcome_status IN ('OPEN', 'T1_HIT', 'T2_HIT', 'STOPPED', 'EXPIRED', 'INVALIDATED', 'AMBIGUOUS')),
  ambiguous boolean NOT NULL DEFAULT false,
  ambiguity_reason text,
  UNIQUE (setup_id, evaluation_horizon)
);

CREATE TABLE IF NOT EXISTS setup_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id uuid NOT NULL REFERENCES trade_setups(id) ON DELETE CASCADE,
  previous_setup_id uuid REFERENCES trade_setups(id) ON DELETE SET NULL,
  previous_tier text NOT NULL CHECK (previous_tier IN ('PRIME', 'OPPORTUNITY', 'SHADOW')),
  new_tier text NOT NULL CHECK (new_tier IN ('PRIME', 'OPPORTUNITY', 'SHADOW')),
  previous_score smallint NOT NULL CHECK (previous_score BETWEEN 0 AND 100),
  new_score smallint NOT NULL CHECK (new_score BETWEEN 0 AND 100),
  promoted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (setup_id, previous_tier, new_tier)
);

-- Eén compacte uurwaarneming per markt volstaat voor OI-richting; er worden geen ticks bewaard.
CREATE TABLE IF NOT EXISTS strategy_market_snapshots (
  symbol text NOT NULL,
  observed_hour timestamptz NOT NULL,
  last_price numeric,
  open_interest numeric,
  funding_rate numeric,
  volume_24h numeric,
  PRIMARY KEY (symbol, observed_hour)
);

CREATE INDEX IF NOT EXISTS trade_setups_created_at_idx ON trade_setups (created_at DESC);
CREATE INDEX IF NOT EXISTS trade_setups_symbol_created_idx ON trade_setups (symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_setups_score_idx ON trade_setups (score);
CREATE INDEX IF NOT EXISTS trade_setups_tier_idx ON trade_setups (signal_tier, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_setups_status_idx ON trade_setups (status, last_seen_at);
CREATE INDEX IF NOT EXISTS trade_setups_strategy_idx ON trade_setups (strategy_version, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_setups_lifecycle_idx ON trade_setups (lifecycle_key, created_at DESC);
CREATE INDEX IF NOT EXISTS trade_setups_dedupe_idx ON trade_setups (dedupe_key);
CREATE UNIQUE INDEX IF NOT EXISTS trade_setups_active_dedupe_unique
  ON trade_setups (dedupe_key)
  WHERE status IN ('ACTIVE', 'CHASE_BLOCKED', 'MISSED_ENTRY');
CREATE INDEX IF NOT EXISTS setup_outcomes_setup_idx ON setup_outcomes (setup_id);
CREATE INDEX IF NOT EXISTS setup_outcomes_status_idx ON setup_outcomes (outcome_status, evaluated_at DESC);
CREATE INDEX IF NOT EXISTS strategy_market_snapshots_observed_idx ON strategy_market_snapshots (observed_hour DESC);

COMMIT;
