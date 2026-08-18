CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'operator', 'viewer')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS login_attempts (
  identity TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  management_ip TEXT NOT NULL,
  api_port INTEGER NOT NULL CHECK (api_port BETWEEN 1 AND 65535),
  api_type TEXT NOT NULL DEFAULT 'native' CHECK (api_type IN ('native', 'rest')),
  use_tls BOOLEAN NOT NULL DEFAULT false,
  verify_tls BOOLEAN NOT NULL DEFAULT true,
  username_encrypted TEXT NOT NULL,
  password_encrypted TEXT NOT NULL,
  endpoint_hostname TEXT,
  endpoint_ip TEXT,
  wireguard_port INTEGER CHECK (wireguard_port BETWEEN 1 AND 65535),
  enabled BOOLEAN NOT NULL DEFAULT true,
  connection_status TEXT NOT NULL DEFAULT 'unknown' CHECK (connection_status IN ('unknown','connected','offline','auth_failed','timeout','api_unavailable','tls_error','unsupported')),
  identity TEXT,
  routeros_version TEXT,
  architecture TEXT,
  board_name TEXT,
  uptime TEXT,
  wireguard_supported BOOLEAN,
  last_error TEXT,
  last_checked_at TIMESTAMPTZ,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wireguard_interfaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  name TEXT NOT NULL,
  listen_port INTEGER NOT NULL CHECK (listen_port BETWEEN 1 AND 65535),
  mtu INTEGER NOT NULL DEFAULT 1420 CHECK (mtu BETWEEN 576 AND 9000),
  public_key TEXT NOT NULL,
  running BOOLEAN NOT NULL DEFAULT false,
  disabled BOOLEAN NOT NULL DEFAULT false,
  addresses TEXT[] NOT NULL DEFAULT '{}',
  client_pool_start TEXT,
  client_pool_end TEXT,
  default_dns TEXT NOT NULL DEFAULT '1.1.1.1',
  default_allowed_ips TEXT NOT NULL DEFAULT '0.0.0.0/0',
  remote_fingerprint TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(router_id, remote_id),
  UNIQUE(router_id, name)
);

CREATE TABLE IF NOT EXISTS peers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  interface_id UUID NOT NULL REFERENCES wireguard_interfaces(id) ON DELETE RESTRICT,
  remote_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'managed' CHECK (origin IN ('managed','imported')),
  public_key TEXT NOT NULL,
  private_key_encrypted TEXT,
  preshared_key_encrypted TEXT,
  client_ip TEXT,
  allowed_address TEXT NOT NULL,
  client_allowed_ips TEXT NOT NULL DEFAULT '0.0.0.0/0',
  dns_server TEXT NOT NULL DEFAULT '1.1.1.1',
  endpoint_override TEXT,
  endpoint_port_override INTEGER CHECK (endpoint_port_override BETWEEN 1 AND 65535),
  persistent_keepalive INTEGER NOT NULL DEFAULT 25 CHECK (persistent_keepalive BETWEEN 0 AND 65535),
  mtu INTEGER NOT NULL DEFAULT 1420 CHECK (mtu BETWEEN 576 AND 9000),
  disabled BOOLEAN NOT NULL DEFAULT false,
  expired BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ,
  last_handshake_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  rx_bytes BIGINT NOT NULL DEFAULT 0,
  tx_bytes BIGINT NOT NULL DEFAULT 0,
  remote_fingerprint TEXT,
  last_remote_state JSONB,
  conflict_type TEXT CHECK (conflict_type IN ('modified_externally','disabled_externally','deleted_externally','db_only')),
  conflict_details JSONB,
  last_synced_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(router_id, public_key),
  UNIQUE(router_id, remote_id),
  UNIQUE(interface_id, client_ip)
);
CREATE INDEX IF NOT EXISTS peers_router_idx ON peers(router_id);
CREATE INDEX IF NOT EXISTS peers_status_idx ON peers(disabled, expired, last_handshake_at);
CREATE INDEX IF NOT EXISTS peers_name_search_idx ON peers USING gin(to_tsvector('simple', name || ' ' || coalesce(description, '') || ' ' || public_key));

CREATE TABLE IF NOT EXISTS traffic_snapshots (
  id BIGSERIAL PRIMARY KEY,
  peer_id UUID NOT NULL REFERENCES peers(id) ON DELETE CASCADE,
  rx_bytes BIGINT NOT NULL,
  tx_bytes BIGINT NOT NULL,
  last_handshake_at TIMESTAMPTZ,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS traffic_peer_time_idx ON traffic_snapshots(peer_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','partial','failed')),
  summary JSONB NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  username TEXT,
  action TEXT NOT NULL,
  router_id UUID REFERENCES routers(id) ON DELETE SET NULL,
  peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
  result TEXT NOT NULL CHECK (result IN ('success','failure','warning')),
  details JSONB NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings(key, value) VALUES
  ('status_thresholds', '{"onlineSeconds":180,"recentSeconds":900}'::jsonb),
  ('sync', '{"intervalSeconds":300}'::jsonb)
ON CONFLICT (key) DO NOTHING;
