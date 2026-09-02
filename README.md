# WireGuard Control

WireGuard Control is a self-hosted operations console for WireGuard peers on multiple MikroTik RouterOS v7 devices. It talks to RouterOS from the server, imports existing configuration without taking ownership of it, detects out-of-band changes, and provides encrypted client configuration and QR export for peers created by the application.

The web application is available at `http://SERVER-IP:2040`. It is also a Progressive Web App (PWA): behind HTTPS (or on `localhost`) supported browsers can install it as a standalone desktop/mobile app. The management APIs remain network-only and are never queued as offline mutations.

## Deployment options

- **Docker Compose (recommended):** runs separate application, worker, and PostgreSQL services on a normal Linux/Windows Docker host.
- **MikroTik RouterOS containers:** runs a combined application/worker image and PostgreSQL directly on supported RouterOS hardware. Follow the dedicated [RouterOS container guide](docs/MIKROTIK_CONTAINER.md); Docker Compose commands do not run in a RouterOS terminal.

Do not commit `.env`, PostgreSQL data, database dumps, or exported container images. RouterOS `.tar` archives are build artifacts and must be generated or attached to a release, not stored in Git.

## What is included

- Native RouterOS API (8728/8729) and RouterOS REST adapters behind one service interface
- Multiple routers, connection tests, RouterOS facts, interface discovery, and safe periodic synchronization
- Existing peer import with `Imported` origin and no automatic deletion or overwrite
- Managed peer creation, transactional IP-pool allocation, duplicate prevention, editing, enable/disable, expiration, explicit key rotation, and confirmed deletion
- Optional one-time, daily, weekly, and monthly RX+TX traffic quotas with counter-reset-safe accounting and automatic per-peer RouterOS enforcement
- Peer comments synchronized with RouterOS, configurable quota timezone/boundaries, warning states, manual usage reset, and audited temporary re-enable
- WireGuard Curve25519 keys, optional pre-shared keys, protected `.conf` export, and official-client-compatible PNG/SVG QR generation from the current encrypted configuration
- Application-side WireGuard IPAM with confirmed subnet suggestions, reservations, imported-address detection, utilization, and transactional allocation
- RouterOS-duration-aware handshake status (`Online`, `Recently Active`, `Offline`, `Never Connected`, `Disabled`, and `Router Unreachable`)
- PostgreSQL-backed users, sessions, routers, interfaces, peers, traffic aggregates, durable operations, drift records, settings, and audit logs
- Scrypt password hashing, database sessions, CSRF checks, login throttling, RBAC, AES-256-GCM secret encryption, and redacted errors
- Responsive light/dark admin UI, sortable/filterable tables, CSV/manual bulk creation with protected ZIP results, PWA manifest/service worker, and install icons
- A separate worker container with independent health-tracked jobs for connectivity, synchronization, traffic, quotas, expiration, bandwidth verification, retention, and reconciliation
- Health checks, migration locking, non-root runtime, persistent PostgreSQL storage, and `restart: unless-stopped`
- Unit tests for critical security, allocation, configuration, reconciliation, permissions, expiration, RouterOS duration parsing, bandwidth direction, CSV/ZIP, and mocked MikroTik lifecycle behavior

## Architecture

```text
Browser / installed PWA
          |
          | session + CSRF protected HTTP
          v
  Next.js application :2040 ---- PostgreSQL
          |
          | native API or REST (credentials decrypted server-side only)
          v
  MikroTik RouterOS v7

  Background worker ---- periodic sync + expiration enforcement
```

No browser bundle contains MikroTik credentials, WireGuard private keys, or the application encryption key. The application only exposes explicitly implemented RouterOS operations; there is no arbitrary command console.

## Requirements

- Docker Engine 24+ and Docker Compose v2
- A modern RouterOS v7 release with WireGuard support
- Network reachability from the Docker host to each router's API address/port
- 1 GB RAM minimum; 2 GB recommended
- Accurate time on the Docker host and routers

## Quick start with Docker Compose

```bash
git clone https://github.com/natious78/Wireguard-Panel.git
cd Wireguard-Panel
cp .env.example .env
```

Generate secrets. Do not reuse either value:

```bash
openssl rand -base64 32  # use as APP_ENCRYPTION_KEY
openssl rand -base64 48  # use as POSTGRES_PASSWORD; URL encoding is not required in Compose
```

Edit `.env` and set at minimum:

```dotenv
POSTGRES_PASSWORD=<long-random-database-password>
ADMIN_USERNAME=admin
ADMIN_PASSWORD=<strong-password-at-least-12-characters>
APP_ENCRYPTION_KEY=<exactly-32-random-bytes-as-base64>
APP_URL=http://SERVER-IP:2040
```

Then start the stack:

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:2040/health
```

Open `http://SERVER-IP:2040`. The first startup creates the administrator only if the `users` table is empty. Later changes to `ADMIN_PASSWORD` do not overwrite an existing account.

All three services use `restart: unless-stopped`, so they resume after a host reboot when Docker starts.

Compose passes the database host, name, user, and password as separate fields. Passwords containing URL-reserved characters such as `/`, `@`, `#`, and `%` are supported without percent-encoding. If you run the application outside Compose and use `DATABASE_URL` instead, percent-encode those characters as required by PostgreSQL connection URI syntax.

### Upgrading an existing installation

Back up the database, then rebuild in place:

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app worker
```

The entrypoint applies pending migrations under a PostgreSQL advisory lock before the app or worker starts. The named database volume is preserved. Do not use `docker compose down -v` for an upgrade; `-v` deletes the database volume.

Treat any secret pasted into chat, a ticket, or a shell transcript as compromised. On an empty installation, regenerate it before first use. On an installation containing data, do not blindly change `APP_ENCRYPTION_KEY`: existing router credentials and managed peer key material were encrypted with the old key and must be deliberately re-encrypted or re-entered. Changing `ADMIN_PASSWORD` in `.env` also does not replace an administrator that already exists.

To rotate an existing installation safely, stop the application writers, keep the new key in `.env`, and run the one-time transactional rotation with the previous key supplied only to the temporary container:

```bash
docker compose stop app worker
OLD_APP_ENCRYPTION_KEY='previous-key' docker compose run --rm -e OLD_APP_ENCRYPTION_KEY app node dist/rotate-encryption-key.cjs
docker compose up -d app worker
```

The rotation verifies every encrypted value and rolls back the entire database transaction if any value cannot be decrypted. Never delete the old key until the rotation and a configuration download have been verified.

## Install as an app

WireGuard Control includes a web app manifest, 192/512 PNG icons, standalone display mode, and a conservative service worker. Browser security rules require a secure context for installation: use `https://` through a trusted local reverse proxy, or test on `localhost`. Plain `http://SERVER-IP:2040` remains available as required, but most browsers will not show an install prompt for a non-localhost HTTP origin.

Once served over HTTPS, use the in-app **Install** prompt or the browser's **Install app** menu. Offline mode only provides the cached sign-in shell; router reads and mutations deliberately fail when the server is unreachable rather than pretending stale data is live.

## MikroTik setup

### Native API (recommended when the app and router share a trusted management network)

Create a dedicated group and user. RouterOS policy permissions are coarse-grained: `write` permits configuration changes beyond WireGuard, even though this application only implements WireGuard operations. Restrict the user and service to the Docker host's management address.

```routeros
/user/group/add name=wg-control policy=read,write,api
/user/add name=wg-control group=wg-control password="REPLACE_WITH_A_LONG_PASSWORD" address=APP_SERVER_IP/32
/ip/service/set api disabled=no port=8728 address=APP_SERVER_IP/32
```

Port `8728` is only the RouterOS default. If `/ip/service/print detail where name="api"` shows a custom port, enter that exact port in the application. For an application running on the same RouterOS device, use the router-side container gateway as the management IP—not `127.0.0.1`, the public hostname, or the application container address.

For native API over TLS, configure RouterOS `api-ssl`, a certificate trusted by the Docker host, port 8729, and select **Use TLS** in the router form. Do not disable certificate verification except during a controlled bootstrap.

### REST API

Use `rest-api` instead of `api` in the group:

```routeros
/user/group/add name=wg-control-rest policy=read,write,rest-api
/user/add name=wg-control-rest group=wg-control-rest password="REPLACE_WITH_A_LONG_PASSWORD" address=APP_SERVER_IP/32
```

Enable `www-ssl`, install a trusted certificate, and restrict its source address. MikroTik explicitly discourages production REST over unencrypted HTTP because Basic credentials can be observed on the network.

The application does **not** request `policy`, `password`, `reboot`, `sniff`, `test`, `ftp`, `ssh`, `telnet`, `winbox`, or `sensitive`. It generates and stores client key material itself, so it does not need RouterOS to reveal sensitive WireGuard private keys.

### Firewall

Permit only the Docker host (or its NATed source address) to the selected API port. Do not expose 8728, 8729, 80, or 443 to the public internet solely for this application. The WireGuard UDP listen port is separate and may need its own input-chain rule.

## Add a router

1. Open **Routers → Add router**.
2. Enter a management IP, transport, port, dedicated username/password, and TLS settings.
3. Configure the public endpoint separately:
   - endpoint hostname (preferred), e.g. `vpn.example.com`;
   - public endpoint IP as fallback;
   - WireGuard endpoint port.
4. Click **Test connection**. Invalid credentials are not silently saved.
5. Click **Add and import**. Existing interfaces and peers are read and preserved.
6. Open **WireGuard Pools** (or an interface page), review the detected subnet suggestion, and explicitly create a WireGuard pool before creating managed peers.

Peer edits can change the name, synchronized comment, router, WireGuard interface, client IP, traffic limit, and expiration. Moving a managed peer to another router preserves its client public/private key pair but changes the generated server endpoint/public key context; download and deploy the newly generated client configuration. Imported peers cannot be moved across routers because their private and optional pre-shared key material is not owned by the application.

Endpoint selection is: per-peer override → router endpoint hostname → router endpoint IP → management IP. API traffic always uses the management IP.

## Synchronization and conflict safety

Each synchronization fetches RouterOS identity/resources, WireGuard interfaces and peers, IP addresses, routes, and NAT rules. The database records a fingerprint of the last observed mutable RouterOS state.

- Router-only peer: imported as `Imported`; never modified automatically.
- Database and router match: statistics and handshake timestamps update.
- Router was edited/disabled externally: a conflict is stored and shown.
- Router peer is missing: marked `deleted externally`; the database row is retained.
- Database-only peer: marked as a conflict; it is not pushed automatically.

Before an edit, enable/disable, regeneration, or deletion, the application fetches that peer again. A fingerprint mismatch returns HTTP 409 and blocks the overwrite. There is no "last writer wins" shortcut.

## Presence and handshake status

Peer presence comes from RouterOS `last-handshake`, never from RX/TX traffic. RouterOS v7 commonly returns an elapsed duration such as `22s`, `1m56s`, `10h4m29s`, or `2d22h7m7s`; the application parses that duration relative to the statistics poll time. Missing handshakes are shown as **Never Connected**, and an unrecognized value is retained as raw diagnostics without producing `Invalid Date`, `NaN`, or a false `Online` state.

The default thresholds are 180 seconds for **Online** and 900 seconds for **Recently Active**. Change them under **Settings**. Every peer retains its last successful handshake, last statistics poll, and last time it was considered online. A failed router poll marks affected peers **Router Unreachable** because their current state is unknown; it does not falsely mark all of them offline.

## WireGuard pools and address safety

WireGuard pools are application-side static IPAM, not MikroTik DHCP pools. Synchronization reads `/interface/wireguard`, `/interface/wireguard/peers`, and `/ip/address` and suggests a subnet/range, but an administrator must confirm it. Pool validation rejects addresses outside the subnet, reversed ranges, network/broadcast/router addresses, oversized ranges, and overlaps on the same router.

Automatic and manual assignment check both PostgreSQL and the current MikroTik `allowed-address` values. Imported peers reserve their addresses. Reservations are never automatically allocated, and conflict errors identify the owning peer/router/interface. Creation holds a PostgreSQL pool-row lock, re-reads the MikroTik immediately before creation, verifies the selected address again, and commits the allocation only after RouterOS confirms the peer. RouterOS failure rolls back the database reservation; deletion releases an address only after RouterOS deletion succeeds. Disabled, expired, and quota-limited peers keep their address.

Each pool page shows total, used/imported, reserved, and available counts, a utilization indicator, and a filterable/sortable address viewer. Address-family metadata is stored for future IPv6 support; allocation is intentionally IPv4-only today.

## Client QR credentials

Managed peers receive PNG and SVG QR codes generated on demand from the full current WireGuard configuration (`PrivateKey`, `Address`, `DNS`, `AllowedIPs`, `Endpoint`, and `PersistentKeepalive`). Private configuration values remain encrypted at rest with `APP_ENCRYPTION_KEY`; unnecessary QR image copies are not stored. A configuration hash is refreshed after relevant peer/key changes and checked before rendering. Viewing and downloading credentials use distinct permissions and audit events. Imported peers cannot receive a working client QR because RouterOS never exposes the client's private key.

## Expiration

The worker checks expiration every `EXPIRATION_INTERVAL_SECONDS`. Expired peers are marked expired and disabled on RouterOS; they are not deleted. If RouterOS changed externally or is unavailable, the failure is audited and retried on a later cycle. Reactivation is an explicit administrator action.

## Traffic quotas and accounting

Each peer can be Unlimited or have a custom MB, GB, or TB limit. Usage is always the combined total:

```text
Current usage = RX + TX
```

Supported periods are one-time/total, daily, weekly, and monthly. Configure the IANA timezone, week start, and monthly reset day under **Settings**. Scheduled boundaries use that timezone rather than UTC. Completed periods and manual resets are appended to `quota_period_history`; resetting current usage never deletes prior history.

The worker polls each router approximately every `MIKROTIK_STATS_INTERVAL` seconds (30 by default). It stores raw observations and non-negative deltas separately. When RouterOS counters decrease after a reboot, reconnect, or counter reset, the new counter value is treated as usage since the reset—never as negative traffic. Lifetime and current-period counters therefore survive application/container restarts and RouterOS counter resets.

When current-period RX + TX reaches the limit, the worker changes only that WireGuard peer's RouterOS `disabled` property and records the limit, period, reached time, usage at disable, and polling overshoot. WireGuard/RouterOS does not offer a native byte-perfect peer quota. Traffic transferred between polls can exceed the configured limit; a shorter interval reduces detection delay but increases RouterOS/API and database load.

At a recurring boundary, only a peer whose disable reason is `quota` is automatically re-enabled. Manually disabled and expired peers remain disabled. Administrators can change/remove a limit, reset current usage with confirmation and audit logging, or grant a one-hour temporary re-enable; usage continues accumulating during that override and enforcement resumes afterward.

## Security notes

- `APP_ENCRYPTION_KEY` must decode to exactly 32 bytes. Router passwords, managed client private keys, and pre-shared keys are encrypted with AES-256-GCM and a random nonce.
- Losing this key makes encrypted credentials and client configs unrecoverable. Back it up separately from PostgreSQL.
- Cookies are `HttpOnly` and `SameSite=Strict`; the `Secure` flag is enabled when `APP_URL` uses `https://`. Plain HTTP remains functional for the required private-network URL, but a trusted HTTPS reverse proxy is the correct production posture.
- Login attempts are throttled per source IP and username after five failures in a 15-minute window.
- All mutation APIs require an authenticated role, same-origin CSRF token, and origin match.
- Super Admin, Administrator, and Read Only roles are enforced in the authorization layer. The bootstrap user is a Super Admin. Super Admins can manage accounts under **User access**; disabling an account, changing its role, or changing its password revokes its active sessions. Read Only accounts cannot retrieve private configurations or QR codes.
- Logs and audits intentionally exclude passwords, private keys, pre-shared keys, session tokens, and the encryption key.

## Health and operations

Application/database health:

```bash
curl -fsS http://127.0.0.1:2040/health
docker compose ps
docker compose logs --tail=200 app worker db
```

`/health` does not depend on any MikroTik being online. Router status is reported separately in the dashboard.

Update:

```bash
git pull
docker compose up -d --build
```

Migrations run under a PostgreSQL advisory lock before the web process starts.

## Backup

Back up PostgreSQL and the deployment environment together. The database contains encrypted secrets; `.env` contains the key that decrypts them.

```bash
mkdir -p backups
docker compose exec -T db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > backups/wireguard-control.dump
cp .env backups/wireguard-control.env
chmod 600 backups/wireguard-control.env backups/wireguard-control.dump
```

Store the two backup files in a protected location. A database dump without the original `APP_ENCRYPTION_KEY` cannot restore router passwords or managed client private keys.

## Restore on another server

1. Clone the same or a compatible application version.
2. Restore the saved `.env` first so `APP_ENCRYPTION_KEY` is unchanged.
3. Start only PostgreSQL and wait for it to be healthy.
4. Restore the custom-format dump.
5. Start the application and worker.

```bash
docker compose up -d db
docker compose exec -T db pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists < backups/wireguard-control.dump
docker compose up -d --build app worker
```

If restoring into a fresh empty database and `--clean` reports harmless missing-object messages, omit `--clean`.

## Development and tests

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Generated dependency stores, TypeScript build metadata, database backups, and Docker/RouterOS image archives are intentionally ignored. Keep release images in a container registry or GitHub Release rather than committing binary archives to the repository.

For UI development without a real router, explicitly set `DEMO_MODE=true`, start PostgreSQL, and add a router with any valid IP and credentials. Every RouterOS client is then replaced by the in-memory demo adapter. Never enable demo mode in production.

## Troubleshooting

**Authentication failed for the router**

- Confirm the dedicated username/password and the matching `api` or `rest-api` group policy.
- Confirm the user `address` restriction sees the Docker host's actual source/NAT address.
- Check RouterOS active users and logs.

**Connection timeout / API unavailable**

- From the Docker host, test TCP reachability to the configured management IP and port.
- Check `/ip/service print`, source address restrictions, VRF, routing, and firewall input rules.
- The management IP is never replaced with the public WireGuard endpoint.

**TLS error**

- The certificate must cover the host used for the API connection and chain to a CA trusted inside the container.
- Prefer fixing trust. Turning off verification permits machine-in-the-middle credential theft.

**WireGuard unsupported**

- Upgrade to RouterOS v7. The connection may work while WireGuard operations remain unsupported.

**Cannot create a peer**

- Configure a pool start/end on the selected interface.
- Synchronize to import addresses already assigned directly on RouterOS.
- If a requested IP is occupied, the error identifies it as a duplicate and creation is blocked.

**Traffic limit was exceeded slightly**

- This is expected with polling enforcement. Usage is evaluated approximately every `MIKROTIK_STATS_INTERVAL` seconds, so traffic between observations is overshoot.
- Reduce the interval cautiously; the minimum accepted value is 10 seconds.
- Confirm the worker is healthy with `docker compose ps` and inspect `docker compose logs --tail=200 worker`.

**Quota did not reset at the expected local time**

- Check the IANA timezone, week start, and monthly reset day under **Settings**.
- Confirm the host clock is accurate. Reset calculations are timezone-aware, but polling means the reset is applied on the first successful observation after the boundary.

**Imported peer has no QR/config**

- This is intentional. RouterOS does not provide the remote client's private key. Only peers whose client key material was generated and encrypted by this application can be regenerated/exported.

**Synchronization conflict**

- Inspect the peer on RouterOS and in WireGuard Control. Synchronization will not overwrite or delete either side. Resolve the external change deliberately, then synchronize again.

**Install button does not appear**

- Use a supported browser and a trusted HTTPS origin. A raw private-IP HTTP URL is not a secure context and is generally not PWA-installable.

## RouterOS implementation scope

The server uses these read paths where required:

```text
/system/resource
/system/identity
/interface/wireguard
/interface/wireguard/peers
/ip/address
/ip/route
/ip/firewall/nat
/queue/simple
/queue/tree
/ip/firewall/mangle
/ip/firewall/filter
```

Write operations are limited to WireGuard interfaces, WireGuard peers, and deterministic application-owned Simple Queues. Existing queues, queue trees, mangle rules, and FastTrack rules are inspected before shaping; conflicting or bypass-prone configurations are surfaced instead of silently stacked. The UI does not expose arbitrary RouterOS commands.

## License

WireGuard Control is released under the [MIT License](LICENSE). Copyright (c) 2026 Amir Askari.
