ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS disabled_reason TEXT,
  ADD COLUMN IF NOT EXISTS quota_limit_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS quota_period TEXT,
  ADD COLUMN IF NOT EXISTS quota_period_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quota_period_ends_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS period_rx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_tx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_rx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_tx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_observed_rx_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS last_observed_tx_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS last_counter_observed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quota_reached_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS quota_usage_when_disabled BIGINT,
  ADD COLUMN IF NOT EXISTS quota_bypass_until TIMESTAMPTZ;

UPDATE peers
SET disabled_reason = CASE WHEN expired THEN 'expired' WHEN disabled THEN 'manual' ELSE NULL END,
    lifetime_rx_bytes = GREATEST(rx_bytes, 0),
    lifetime_tx_bytes = GREATEST(tx_bytes, 0),
    last_observed_rx_bytes = GREATEST(rx_bytes, 0),
    last_observed_tx_bytes = GREATEST(tx_bytes, 0),
    last_counter_observed_at = COALESCE(last_synced_at, now())
WHERE last_observed_rx_bytes IS NULL OR last_observed_tx_bytes IS NULL;

DO $$ BEGIN
  ALTER TABLE peers ADD CONSTRAINT peers_disabled_reason_check
    CHECK (disabled_reason IS NULL OR disabled_reason IN ('manual','expired','quota'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE peers ADD CONSTRAINT peers_quota_period_check
    CHECK (quota_period IS NULL OR quota_period IN ('one_time','daily','weekly','monthly'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE peers ADD CONSTRAINT peers_quota_limit_positive_check
    CHECK (quota_limit_bytes IS NULL OR quota_limit_bytes > 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE peers ADD CONSTRAINT peers_accounting_nonnegative_check
    CHECK (period_rx_bytes >= 0 AND period_tx_bytes >= 0 AND lifetime_rx_bytes >= 0 AND lifetime_tx_bytes >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS quota_period_history (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  quota_period TEXT NOT NULL CHECK (quota_period IN ('one_time','daily','weekly','monthly')),
  configured_limit_bytes BIGINT,
  rx_bytes BIGINT NOT NULL CHECK (rx_bytes >= 0),
  tx_bytes BIGINT NOT NULL CHECK (tx_bytes >= 0),
  period_started_at TIMESTAMPTZ NOT NULL,
  period_ended_at TIMESTAMPTZ NOT NULL,
  quota_reached_at TIMESTAMPTZ,
  usage_when_disabled BIGINT,
  reset_reason TEXT NOT NULL CHECK (reset_reason IN ('scheduled','manual','configuration_changed','limit_removed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quota_history_peer_time_idx ON quota_period_history(peer_id, period_ended_at DESC);
CREATE INDEX IF NOT EXISTS peers_quota_state_idx ON peers(quota_period, quota_limit_bytes, disabled_reason);

ALTER TABLE traffic_snapshots
  ADD COLUMN IF NOT EXISTS delta_rx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delta_tx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_rx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lifetime_tx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_rx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS period_tx_bytes BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS quota_period_started_at TIMESTAMPTZ;

INSERT INTO settings(key, value) VALUES
  ('quota_policy', '{"timezone":"UTC","weekStartsOn":1,"monthlyResetDay":1}'::jsonb)
ON CONFLICT (key) DO NOTHING;
