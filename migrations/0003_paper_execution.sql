BEGIN;

CREATE TABLE IF NOT EXISTS public.paper_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_alert_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_evaluated_at timestamptz,
  symbol text NOT NULL,
  market text NOT NULL,
  lane text NOT NULL CHECK (lane IN ('PRIME','OPPORTUNITY','HIGH_BETA')),
  direction text NOT NULL CHECK (direction IN ('LONG','SHORT')),
  risk_class numeric(5,2) NOT NULL CHECK (risk_class IN (1.00,0.25,0.05)),
  virtual_equity_usd numeric NOT NULL DEFAULT 1000,
  base_risk_pct numeric NOT NULL DEFAULT 1,
  risk_budget_usd numeric NOT NULL,
  actual_risk_usd numeric NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('MARKET','LIMIT')),
  status text NOT NULL CHECK (status IN ('PENDING','OPEN','CLOSED','CANCELLED')),
  entry_low numeric NOT NULL,
  entry_high numeric NOT NULL,
  reference_entry numeric NOT NULL,
  fill_price numeric,
  fill_at timestamptz,
  stop_price numeric NOT NULL,
  target_1 numeric NOT NULL,
  target_2 numeric NOT NULL,
  rr_target_2 numeric,
  position_qty numeric NOT NULL,
  notional_usd numeric NOT NULL,
  t1_hit boolean NOT NULL DEFAULT false,
  t1_hit_at timestamptz,
  t2_hit boolean NOT NULL DEFAULT false,
  t2_hit_at timestamptz,
  stop_hit boolean NOT NULL DEFAULT false,
  stop_hit_at timestamptz,
  close_price numeric,
  closed_at timestamptz,
  close_reason text,
  gross_result_usd numeric,
  fees_usd numeric NOT NULL DEFAULT 0,
  slippage_usd numeric NOT NULL DEFAULT 0,
  net_result_usd numeric,
  result_r numeric,
  paper_version text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (entry_low <= entry_high)
);

CREATE TABLE IF NOT EXISTS public.paper_trade_events (
  id bigserial PRIMARY KEY,
  paper_trade_id uuid NOT NULL REFERENCES public.paper_trades(id) ON DELETE CASCADE,
  event_at timestamptz NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('ORDER_PLACED','FILLED','TP1','TP2','STOP','EXPIRED','CLOSED_24H')),
  price numeric,
  quantity numeric,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS paper_trades_status_idx ON public.paper_trades(status, updated_at);
CREATE INDEX IF NOT EXISTS paper_trades_lane_created_idx ON public.paper_trades(lane, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_trades_symbol_created_idx ON public.paper_trades(symbol, created_at DESC);
CREATE INDEX IF NOT EXISTS paper_trade_events_trade_idx ON public.paper_trade_events(paper_trade_id, event_at);

COMMIT;
