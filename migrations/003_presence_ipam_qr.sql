ALTER TABLE routers
  ADD COLUMN IF NOT EXISTS stats_poll_status TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS last_stats_poll_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_stats_success_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_stats_error TEXT;

DO $$ BEGIN
  ALTER TABLE routers ADD CONSTRAINT routers_stats_poll_status_check
    CHECK (stats_poll_status IN ('unknown','reachable','unreachable'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS remote_disabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS last_statistics_poll_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_online_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_handshake_raw TEXT,
  ADD COLUMN IF NOT EXISTS last_handshake_parse_valid BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS qr_config_hash TEXT,
  ADD COLUMN IF NOT EXISTS qr_png_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS qr_svg_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS qr_generated_at TIMESTAMPTZ;

UPDATE peers SET
  remote_disabled = COALESCE(remote_disabled, disabled),
  last_statistics_poll_at = COALESCE(last_statistics_poll_at, last_counter_observed_at),
  last_online_at = COALESCE(last_online_at, last_seen_at)
WHERE remote_disabled IS NULL OR last_statistics_poll_at IS NULL OR last_online_at IS NULL;

CREATE TABLE IF NOT EXISTS wireguard_pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  interface_id UUID NOT NULL REFERENCES wireguard_interfaces(id) ON DELETE CASCADE,
  address_family SMALLINT NOT NULL DEFAULT 4 CHECK (address_family IN (4,6)),
  network_cidr CIDR NOT NULL,
  gateway_ip INET NOT NULL,
  start_ip INET NOT NULL,
  end_ip INET NOT NULL,
  dns TEXT NOT NULL DEFAULT '1.1.1.1',
  client_allowed_ips TEXT NOT NULL DEFAULT '0.0.0.0/0',
  endpoint_host TEXT,
  endpoint_port INTEGER CHECK (endpoint_port BETWEEN 1 AND 65535),
  mtu INTEGER NOT NULL DEFAULT 1420 CHECK (mtu BETWEEN 576 AND 9000),
  persistent_keepalive INTEGER NOT NULL DEFAULT 25 CHECK (persistent_keepalive BETWEEN 0 AND 65535),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(interface_id, name),
  CHECK (family(network_cidr) = address_family),
  CHECK (family(gateway_ip) = address_family AND family(start_ip) = address_family AND family(end_ip) = address_family),
  CHECK (gateway_ip <<= network_cidr AND start_ip <<= network_cidr AND end_ip <<= network_cidr),
  CHECK (start_ip <= end_ip),
  CHECK (NOT (gateway_ip BETWEEN start_ip AND end_ip)),
  CHECK (host(start_ip) <> host(network(network_cidr)) AND host(end_ip) <> host(network(network_cidr))),
  CHECK (address_family = 6 OR (host(start_ip) <> host(broadcast(network_cidr)) AND host(end_ip) <> host(broadcast(network_cidr))))
);
CREATE INDEX IF NOT EXISTS wireguard_pools_scope_idx ON wireguard_pools(router_id, interface_id);

ALTER TABLE peers ADD COLUMN IF NOT EXISTS pool_id UUID REFERENCES wireguard_pools(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS peers_pool_idx ON peers(pool_id);

CREATE TABLE IF NOT EXISTS wireguard_pool_addresses (
  id BIGSERIAL PRIMARY KEY,
  pool_id UUID NOT NULL REFERENCES wireguard_pools(id) ON DELETE CASCADE,
  router_id UUID NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
  interface_id UUID NOT NULL REFERENCES wireguard_interfaces(id) ON DELETE CASCADE,
  ip_address INET NOT NULL,
  state TEXT NOT NULL DEFAULT 'available' CHECK (state IN ('available','reserved','allocated','router')),
  peer_id UUID REFERENCES peers(id) ON DELETE SET NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(pool_id, ip_address),
  UNIQUE(router_id, ip_address),
  UNIQUE(peer_id),
  CHECK ((state = 'allocated') = (peer_id IS NOT NULL)),
  CHECK (state <> 'reserved' OR comment IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS pool_addresses_state_idx ON wireguard_pool_addresses(pool_id, state, ip_address);

INSERT INTO wireguard_pools(name,router_id,interface_id,network_cidr,gateway_ip,start_ip,end_ip,dns,client_allowed_ips,endpoint_host,endpoint_port,mtu,persistent_keepalive)
SELECT i.name || ' pool',i.router_id,i.id,network(a.address::inet)::cidr,host(a.address::inet)::inet,
       host(i.client_pool_start::inet)::inet,host(i.client_pool_end::inet)::inet,i.default_dns,i.default_allowed_ips,
       coalesce(r.endpoint_hostname,r.endpoint_ip,r.management_ip),coalesce(r.wireguard_port,i.listen_port),i.mtu,25
FROM wireguard_interfaces i
JOIN routers r ON r.id=i.router_id
JOIN LATERAL (
  SELECT address FROM unnest(i.addresses) address
  WHERE address::cidr >>= i.client_pool_start::inet
  ORDER BY masklen(address::cidr) DESC LIMIT 1
) a ON true
WHERE i.client_pool_start IS NOT NULL AND i.client_pool_end IS NOT NULL
ON CONFLICT(interface_id,name) DO NOTHING;

UPDATE peers p SET pool_id=wp.id
FROM wireguard_pools wp
WHERE p.pool_id IS NULL AND p.interface_id=wp.interface_id AND p.client_ip IS NOT NULL
  AND p.client_ip::inet >= wp.start_ip AND p.client_ip::inet <= wp.end_ip;

INSERT INTO wireguard_pool_addresses(pool_id,router_id,interface_id,ip_address,state,peer_id,comment)
SELECT p.pool_id,p.router_id,p.interface_id,p.client_ip::inet,'allocated',p.id,p.name
FROM peers p WHERE p.pool_id IS NOT NULL AND p.client_ip IS NOT NULL
ON CONFLICT(router_id,ip_address) DO NOTHING;
