-- Durable operations, drift tracking, policy inheritance, bandwidth shaping, worker health, and archival.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = CASE role WHEN 'admin' THEN 'super_admin' WHEN 'operator' THEN 'administrator' WHEN 'viewer' THEN 'read_only' ELSE role END;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('super_admin','administrator','read_only'));

ALTER TABLE routers
  ADD COLUMN IF NOT EXISTS default_interface_id UUID REFERENCES wireguard_interfaces(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_pool_id UUID REFERENCES wireguard_pools(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS default_dns TEXT,
  ADD COLUMN IF NOT EXISTS default_client_allowed_ips TEXT,
  ADD COLUMN IF NOT EXISTS default_endpoint TEXT,
  ADD COLUMN IF NOT EXISTS default_mtu INTEGER CHECK (default_mtu BETWEEN 576 AND 9000),
  ADD COLUMN IF NOT EXISTS default_persistent_keepalive INTEGER CHECK (default_persistent_keepalive BETWEEN 0 AND 65535),
  ADD COLUMN IF NOT EXISTS default_quota_bytes BIGINT CHECK (default_quota_bytes IS NULL OR default_quota_bytes > 0),
  ADD COLUMN IF NOT EXISTS default_quota_period TEXT CHECK (default_quota_period IS NULL OR default_quota_period IN ('one_time','daily','weekly','monthly')),
  ADD COLUMN IF NOT EXISTS default_bandwidth_mode TEXT NOT NULL DEFAULT 'global' CHECK (default_bandwidth_mode IN ('global','unlimited','custom')),
  ADD COLUMN IF NOT EXISTS default_download_bps BIGINT CHECK (default_download_bps IS NULL OR default_download_bps > 0),
  ADD COLUMN IF NOT EXISTS default_upload_bps BIGINT CHECK (default_upload_bps IS NULL OR default_upload_bps > 0),
  ADD COLUMN IF NOT EXISTS default_expiration_days INTEGER CHECK (default_expiration_days IS NULL OR default_expiration_days > 0),
  ADD COLUMN IF NOT EXISTS api_latency_ms INTEGER CHECK (api_latency_ms IS NULL OR api_latency_ms >= 0),
  ADD COLUMN IF NOT EXISTS clock_difference_seconds INTEGER,
  ADD COLUMN IF NOT EXISTS last_successful_connection_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failed_operation_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_failed_operation TEXT,
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS bandwidth_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  download_bps BIGINT,
  upload_bps BIGINT,
  burst_download_bps BIGINT,
  burst_upload_bps BIGINT,
  burst_threshold_download_bps BIGINT,
  burst_threshold_upload_bps BIGINT,
  burst_time_seconds INTEGER,
  system BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((download_bps IS NULL AND upload_bps IS NULL) OR (download_bps > 0 AND upload_bps > 0)),
  CHECK (burst_time_seconds IS NULL OR burst_time_seconds BETWEEN 1 AND 3600)
);

CREATE TABLE IF NOT EXISTS peer_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  pool_id UUID REFERENCES wireguard_pools(id) ON DELETE SET NULL,
  dns TEXT,
  client_allowed_ips TEXT,
  mtu INTEGER CHECK (mtu IS NULL OR mtu BETWEEN 576 AND 9000),
  persistent_keepalive INTEGER CHECK (persistent_keepalive IS NULL OR persistent_keepalive BETWEEN 0 AND 65535),
  quota_limit_bytes BIGINT CHECK (quota_limit_bytes IS NULL OR quota_limit_bytes > 0),
  quota_period TEXT CHECK (quota_period IS NULL OR quota_period IN ('one_time','daily','weekly','monthly')),
  bandwidth_profile_id UUID REFERENCES bandwidth_profiles(id) ON DELETE SET NULL,
  expiration_days INTEGER CHECK (expiration_days IS NULL OR expiration_days > 0),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS profile_id UUID REFERENCES peer_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bandwidth_mode TEXT NOT NULL DEFAULT 'default' CHECK (bandwidth_mode IN ('default','unlimited','custom','profile')),
  ADD COLUMN IF NOT EXISTS bandwidth_profile_id UUID REFERENCES bandwidth_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS bandwidth_source TEXT NOT NULL DEFAULT 'global' CHECK (bandwidth_source IN ('peer','profile','router','global','unlimited')),
  ADD COLUMN IF NOT EXISTS download_limit_bps BIGINT CHECK (download_limit_bps IS NULL OR download_limit_bps > 0),
  ADD COLUMN IF NOT EXISTS upload_limit_bps BIGINT CHECK (upload_limit_bps IS NULL OR upload_limit_bps > 0),
  ADD COLUMN IF NOT EXISTS burst_download_bps BIGINT,
  ADD COLUMN IF NOT EXISTS burst_upload_bps BIGINT,
  ADD COLUMN IF NOT EXISTS burst_threshold_download_bps BIGINT,
  ADD COLUMN IF NOT EXISTS burst_threshold_upload_bps BIGINT,
  ADD COLUMN IF NOT EXISTS burst_time_seconds INTEGER CHECK (burst_time_seconds IS NULL OR burst_time_seconds BETWEEN 1 AND 3600),
  ADD COLUMN IF NOT EXISTS bandwidth_sync_state TEXT NOT NULL DEFAULT 'not_configured' CHECK (bandwidth_sync_state IN ('not_configured','pending','synced','changed_externally','conflict','error','router_unreachable','missing','duplicate','pending_cleanup')),
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_status IN ('creating','active','partial','needs_reconciliation','failed','pending_cleanup','archived')),
  ADD COLUMN IF NOT EXISTS sync_state TEXT NOT NULL DEFAULT 'synced' CHECK (sync_state IN ('synced','pending','changed_externally','conflict','error','router_unreachable')),
  ADD COLUMN IF NOT EXISTS desired_state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_applied_state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE wireguard_interfaces
  ADD COLUMN IF NOT EXISTS sync_state TEXT NOT NULL DEFAULT 'synced' CHECK (sync_state IN ('synced','pending','changed_externally','conflict','error','router_unreachable')),
  ADD COLUMN IF NOT EXISTS desired_state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_applied_state JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS last_remote_state JSONB NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS managed_router_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
  object_type TEXT NOT NULL CHECK (object_type IN ('simple_queue','queue_tree','mangle_rule')),
  remote_id TEXT,
  ownership_comment TEXT NOT NULL,
  expected_state JSONB NOT NULL DEFAULT '{}',
  last_observed_state JSONB,
  fingerprint TEXT,
  sync_state TEXT NOT NULL DEFAULT 'pending' CHECK (sync_state IN ('pending','synced','changed_externally','conflict','missing','duplicate','error','router_unreachable','pending_cleanup')),
  last_verified_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(router_id, object_type, ownership_comment)
);
CREATE INDEX IF NOT EXISTS managed_objects_peer_idx ON managed_router_objects(peer_id);

CREATE TABLE IF NOT EXISTS management_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','active','partial','needs_reconciliation','failed','completed','pending_cleanup')),
  router_id UUID REFERENCES routers(id) ON DELETE SET NULL,
  peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key TEXT UNIQUE,
  steps JSONB NOT NULL DEFAULT '[]',
  context JSONB NOT NULL DEFAULT '{}',
  last_error TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS operations_reconcile_idx ON management_operations(status,next_retry_at);

CREATE TABLE IF NOT EXISTS configuration_drifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  peer_id UUID REFERENCES peers(id) ON DELETE CASCADE,
  object_type TEXT NOT NULL CHECK (object_type IN ('peer','interface','bandwidth')),
  object_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('changed_externally','conflict','error','router_unreachable')),
  application_state JSONB NOT NULL DEFAULT '{}',
  synchronized_state JSONB NOT NULL DEFAULT '{}',
  router_state JSONB NOT NULL DEFAULT '{}',
  differences JSONB NOT NULL DEFAULT '[]',
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IS NULL OR resolution IN ('keep_router','apply_application','dismissed')),
  resolved_by UUID REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE(object_type,object_id)
);
CREATE INDEX IF NOT EXISTS drift_open_idx ON configuration_drifts(router_id,resolved_at);

CREATE TABLE IF NOT EXISTS worker_job_health (
  job_name TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','running','healthy','degraded','failed')),
  last_started_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ,
  last_duration_ms INTEGER,
  details JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS traffic_usage_aggregates (
  peer_id UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  bucket_type TEXT NOT NULL CHECK (bucket_type IN ('hour','day','month')),
  bucket_start TIMESTAMPTZ NOT NULL,
  rx_bytes BIGINT NOT NULL DEFAULT 0 CHECK (rx_bytes >= 0),
  tx_bytes BIGINT NOT NULL DEFAULT 0 CHECK (tx_bytes >= 0),
  sample_count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(peer_id,bucket_type,bucket_start)
);

CREATE TABLE IF NOT EXISTS peer_archives (
  archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  peer_id UUID NOT NULL,
  router_id UUID,
  interface_id UUID,
  pool_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  client_ip TEXT,
  created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifetime_rx_bytes BIGINT NOT NULL DEFAULT 0,
  lifetime_tx_bytes BIGINT NOT NULL DEFAULT 0,
  quota_history JSONB NOT NULL DEFAULT '[]',
  deletion_details JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS peer_archives_deleted_idx ON peer_archives(deleted_at DESC);

INSERT INTO settings(key,value) VALUES
  ('bandwidth_defaults','{"mode":"unlimited","downloadBps":null,"uploadBps":null}'::jsonb),
  ('retention_policy','{"rawTrafficHours":24,"hourlyDays":90,"dailyMonths":24,"archiveDeletedPeers":true}'::jsonb)
ON CONFLICT(key) DO NOTHING;

-- QR images contain private keys. Keep only a hash marker; render PNG/SVG dynamically from encrypted configuration.
UPDATE peers SET qr_png_encrypted=NULL,qr_svg_encrypted=NULL WHERE qr_png_encrypted IS NOT NULL OR qr_svg_encrypted IS NOT NULL;

INSERT INTO bandwidth_profiles(name,description,download_bps,upload_bps,system) VALUES
  ('Unlimited','No application-managed bandwidth queue',NULL,NULL,true),
  ('5 Mbps','Symmetric 5 Mbps limit',5000000,5000000,true),
  ('10 Mbps','Symmetric 10 Mbps limit',10000000,10000000,true),
  ('20 Mbps','Symmetric 20 Mbps limit',20000000,20000000,true),
  ('50 Mbps','Symmetric 50 Mbps limit',50000000,50000000,true),
  ('100 Mbps','Symmetric 100 Mbps limit',100000000,100000000,true),
  ('Standard','20 Mbps download / 10 Mbps upload',20000000,10000000,true),
  ('Premium','100 Mbps download / 50 Mbps upload',100000000,50000000,true),
  ('Guest','5 Mbps download / 2 Mbps upload',5000000,2000000,true)
ON CONFLICT(name) DO NOTHING;

INSERT INTO peer_profiles(name,description,client_allowed_ips,mtu,persistent_keepalive,bandwidth_profile_id)
SELECT 'Standard User','General-purpose subscriber profile','0.0.0.0/0',1420,25,id FROM bandwidth_profiles WHERE name='Standard'
ON CONFLICT(name) DO NOTHING;
