BEGIN;

CREATE TABLE IF NOT EXISTS public.high_beta_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  symbol text NOT NULL,
  market text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('LONG','SHORT')),
  score smallint NOT NULL CHECK (score BETWEEN 0 AND 100),
  risk_class numeric(4,2) NOT NULL DEFAULT 0.05 CHECK (risk_class = 0.05),
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
  execution_score numeric,
  spread numeric,
  slippage numeric,
  orderbook_depth numeric,
  momentum_1h_pct numeric,
  momentum_4h_pct numeric,
  volume_ratio numeric,
  open_interest_change_pct numeric,
  funding_pct_per_hour numeric,
  relative_1h_pct numeric,
  relative_4h_pct numeric,
  breakout_level numeric,
  eligible boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'WATCH' CHECK (status IN ('WATCH','ACTIVE','INVALIDATED','CHASE_BLOCKED')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text NOT NULL,
  strategy_version text NOT NULL,
  invalidated_at timestamptz,
  CHECK (entry_low <= entry_high),
  CHECK (
    (direction='LONG' AND stop_price < reference_entry AND target_1 > reference_entry AND target_2 > reference_entry)
    OR
    (direction='SHORT' AND stop_price > reference_entry AND target_1 < reference_entry AND target_2 < reference_entry)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS high_beta_setups_active_dedupe_unique
  ON public.high_beta_setups(dedupe_key)
  WHERE status IN ('WATCH','ACTIVE','CHASE_BLOCKED');
CREATE INDEX IF NOT EXISTS high_beta_setups_created_idx ON public.high_beta_setups(created_at DESC);
CREATE INDEX IF NOT EXISTS high_beta_setups_symbol_idx ON public.high_beta_setups(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS high_beta_setups_score_idx ON public.high_beta_setups(score, created_at DESC);
CREATE INDEX IF NOT EXISTS high_beta_setups_status_idx ON public.high_beta_setups(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.high_beta_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_id uuid NOT NULL REFERENCES public.high_beta_setups(id) ON DELETE CASCADE,
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
  outcome_status text NOT NULL CHECK (outcome_status IN ('OPEN','T1_HIT','T2_HIT','STOPPED','EXPIRED','INVALIDATED','AMBIGUOUS')),
  ambiguous boolean NOT NULL DEFAULT false,
  ambiguity_reason text,
  UNIQUE(setup_id, evaluation_horizon)
);

CREATE INDEX IF NOT EXISTS high_beta_outcomes_setup_idx ON public.high_beta_outcomes(setup_id);
CREATE INDEX IF NOT EXISTS high_beta_outcomes_status_idx ON public.high_beta_outcomes(outcome_status, evaluated_at DESC);

COMMIT;
