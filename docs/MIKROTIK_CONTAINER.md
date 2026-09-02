# MikroTik RouterOS Container deployment

This guide deploys WireGuard Control on RouterOS v7 using RouterOS `/container`. It does not require Docker, Docker Compose, systemd, the Docker socket, privileged mode, or host networking on the router.

## Support status and non-negotiable constraints

RouterOS supports Linux containers on `arm`, `arm64`, and x86/CHR when the matching `container` package is installed. This application image supports **linux/arm64 and linux/amd64 only**. ARM32 MikroTik devices are not supported by this build because the Node.js/Next.js runtime dependency chain is not validated there.

MikroTik requires physical confirmation to enable container device mode. MikroTik also strongly recommends external storage and warns that containers increase the router's attack surface. Read the official [Container](https://help.mikrotik.com/docs/spaces/ROS/pages/84901929/Container), [Device-mode](https://help.mikrotik.com/docs/spaces/ROS/pages/93749258/Device-mode), and [Packages](https://help.mikrotik.com/docs/spaces/ROS/pages/40992872/Packages) documentation before deployment.

The core deployment intentionally uses two containers:

1. `wg-app`: Next.js web/API plus the background scheduler in one container.
2. `wg-db`: PostgreSQL 17 with one persistent data mount.

One container was rejected as a production architecture. The application uses PostgreSQL `INET`, `CIDR`, `JSONB`, advisory locks, row locks, interval/date functions, and PostgreSQL conflict semantics for race-free IP allocation and quota accounting. A superficial SQLite conversion would weaken correctness. Bundling PostgreSQL into the web image would make lifecycle, recovery, upgrades, and backups less reliable.

There is no Redis, cache container, Docker socket, or privileged container. A third reverse-proxy container such as Caddy is optional when the UI must be published over trusted HTTPS.

## Current architecture audit

| Area | Implementation |
|---|---|
| Frontend/backend | Next.js 15 App Router, React 19, server-rendered UI and route handlers |
| Database | PostgreSQL 17 through `pg`; four existing migrations plus constrained-runtime migration |
| Worker | TypeScript scheduler for traffic, health, sync, expiration, bandwidth, reconciliation, aggregation, and cleanup |
| Cache/Redis | None |
| Normal Docker deployment | `app`, `worker`, and `postgres` Compose services |
| MikroTik deployment | Combined `app+worker`, plus PostgreSQL on one shared veth; optional HTTPS proxy |
| Durable data | PostgreSQL database and the separately protected `APP_ENCRYPTION_KEY` |
| Temporary data | QR PNG/SVG is generated on request; no QR image, build cache, or temporary config is persisted |
| Diagnostic logs | stdout/stderr only; successful polls are silent; repeated failures are state-deduplicated |
| Audit logs | Compact database events with configurable retention; no passwords, private configurations, or RouterOS response dumps |
| Architectures | `linux/amd64`, `linux/arm64` |

## Database and write behavior

Quota counters and last observed RouterOS counters are committed on every successful traffic poll so a restart does not reset quota usage or double-count traffic. High-frequency history rows are separately throttled by `rawTrafficSampleSeconds` (300 seconds by default). Aggregation runs hourly by default and maintains hourly, daily, and monthly totals. Raw, hourly, daily, and audit retention are bounded.

PostgreSQL remains the correct database for this application. Do not replace it with a SQLite file from another build.

## Hardware eligibility

Run these commands first:

```routeros
/system/resource/print
/system/package/print
/system/device-mode/print
/disk/print detail
```

Check `architecture-name`, `total-memory`, `free-memory`, CPU count, RouterOS version, installed packages, and external disk health.

Development measurements on Docker Desktop with 45 configured peers and an unreachable router, before the RouterOS-specific combined image optimization, were:

| Component | Idle resident memory |
|---|---:|
| Web process | about 89 MiB |
| Worker process | about 59 MiB |
| PostgreSQL | about 58 MiB |
| Total application stack | about 206 MiB |
| Earlier application image | about 217 MB |
| Existing database | 41 MB; 30 MB was legacy high-frequency traffic table/bloat |

The final combined RouterOS image was also measured for 30 seconds on Docker Desktop with an empty database and no routers or peers:

| Measurement | Result |
|---|---:|
| Combined web + worker average memory | 90.0 MiB |
| PostgreSQL average memory | 23.4 MiB |
| Combined average | 113.4 MiB |
| Combined peak | 116.5 MiB |
| AMD64 application image | 105,283,108 bytes (100.4 MiB) |
| ARM64 application image | 105,810,869 bytes (100.9 MiB) |
| Empty database | 9,262,771 bytes (8.8 MiB) |

Both the native AMD64 and emulated ARM64 production images completed a full build. These are development-host measurements, not RouterOS hardware certification. Active 10/100/500-peer RouterOS measurements still require the target device and valid router credentials. Do not treat either table as a guarantee.

Practical admission policy:

| MikroTik RAM | Suitability |
|---|---|
| Below 512 MB | Not supported |
| 512 MB | Not recommended; too little safety margin for RouterOS and image extraction |
| 1 GB | Minimum candidate for a small deployment after on-device testing |
| 2 GB or more | Recommended for up to roughly 100–250 peers, subject to measured CPU and storage results |
| 500+ peers | Run the application on an external Linux server |

Routing, firewall, NAT, WireGuard, queues, DNS, DHCP, and management always take priority. If free RAM during normal router load is less than 350–400 MiB before container deployment, use an external server.

## Build and publish the images

From an amd64/arm64 build host with Docker Buildx:

```bash
IMAGE=ghcr.io/your-org/wireguard-control VERSION=1.1.0 docker buildx bake --push
```

Build only the MikroTik image:

```bash
IMAGE=ghcr.io/your-org/wireguard-control VERSION=1.1.0 docker buildx bake mikrotik --push
```

For an offline ARM64 import:

```bash
docker buildx build --platform linux/arm64 -f Dockerfile.mikrotik -t wireguard-control:mikrotik --load .
docker save wireguard-control:mikrotik -o wireguard-control-arm64.tar
```

Upload the tar to the external disk, then use the `file=` form shown later. Never build secrets into the image. RouterOS must recognize the archive as a Docker image archive and show a populated `tag`, `os`, `arch`, and `image-id` after extraction. If it reports `no config found in manifest`, convert the image to legacy Docker archive format with Skopeo or publish it to a registry; repeatedly importing the incompatible archive will not fix it.

## Reference network and storage layout

The commands below use these concrete example values. Change them to avoid overlap with existing routes:

```text
Router/LAN address:       192.168.88.1
Trusted admin subnet:     192.168.88.0/24
Container subnet:         172.31.204.0/24
Container gateway:        172.31.204.1
Shared container veth:    172.31.204.2
Application port:         2040/tcp
External disk:            disk1
Persistent root:          disk1/wg-manager
```

Recommended external storage is an SSD or NVMe device. MikroTik recommends external media capable of approximately 100 MB/s sequential I/O and 10K random IOPS. USB flash drives are acceptable only for testing or light workloads and should be treated as consumable media. Do not place PostgreSQL on RouterBOARD internal flash.

Persistent layout:

```text
disk1/wg-manager/postgres       PostgreSQL data
disk1/wg-manager/app-data       mounted for storage visibility; no routine application files
disk1/wg-manager/backups        database backups
disk1/wg-manager/images         extracted container root filesystems
disk1/wg-manager/tmp            image extraction temporary data
```

## Step-by-step RouterOS deployment

### 1. Verify RouterOS, architecture, resources, and package

```routeros
/system/resource/print
/system/package/print where name="container"
/system/device-mode/print
```

Use the current stable RouterOS v7 release. The application image requires `arm64` or x86/CHR capable of running `linux/amd64` images. If `container` is missing, install the matching MikroTik `container` NPK for the exact RouterOS version and architecture, then reboot:

```routeros
/system/reboot
```

On RouterOS 7.18 or later, WinBox/WebFig can use **System → Packages → Check for Updates**, enable the available `container` package, then **Apply Changes**. Manual NPK upload remains the deterministic method.

### 2. Enable container device mode

```routeros
/system/device-mode/update container=yes
```

Physically press the required button or perform the requested cold power cycle within the displayed activation window. Verify after reboot:

```routeros
/system/device-mode/print
```

`container` must show `yes`.

### 3. Prepare external storage

Format and mount the external disk using **System → Disks** or the commands appropriate for that disk. Confirm the mounted name and free space:

```routeros
/disk/print detail
/file/print where name~"disk1"
```

Create directories from WinBox **Files** or through a temporary container shell if your RouterOS build does not expose directory creation in CLI. The final paths must match the mount commands below.

### 4. Create the container bridge and shared veth interface

```routeros
/interface/bridge/add name=br-wg-containers comment="WireGuard Control containers"
/ip/address/add address=172.31.204.1/24 interface=br-wg-containers comment="WireGuard Control container gateway"
/interface/veth/add name=veth-wg address=172.31.204.2/24 gateway=172.31.204.1
/interface/bridge/port/add bridge=br-wg-containers interface=veth-wg
```

Assign both `wg-app` and `wg-db` to `veth-wg`. RouterOS supports one veth for multiple containers; those containers share a network namespace and communicate through loopback. This avoids relying on Docker-style service discovery or cross-veth container routing. PostgreSQL remains unexposed because no destination NAT forwards port 5432.

### 5. Add outbound NAT

```routeros
/ip/firewall/nat/add chain=srcnat action=masquerade src-address=172.31.204.0/24 comment="WG Control container egress"
```

The database shares the application veth but is reachable only inside that namespace on loopback. Do not create a destination-NAT rule for port 5432.

### 6. Restrict management access to the trusted LAN

Forward only port 2040 from the router's LAN address and only from the admin subnet:

```routeros
/ip/firewall/nat/add chain=dstnat action=dst-nat protocol=tcp src-address=192.168.88.0/24 dst-address=192.168.88.1 dst-port=2040 to-addresses=172.31.204.2 to-ports=2040 comment="WG Control admin UI"
/ip/firewall/filter/add chain=forward action=accept protocol=tcp src-address=192.168.88.0/24 dst-address=172.31.204.2 dst-port=2040 connection-state=new comment="Allow trusted WG Control UI"
```

Place the accept rule before the router's final forward-chain drop. Do not create a WAN port forward. For remote administration, use WireGuard to enter the trusted admin network.

### 7. Create a least-privilege RouterOS API account

For the native RouterOS API used by this application:

```routeros
/user/group/add name=wg-control policy=read,write,api,rest-api
/user/add name=wg-control group=wg-control address=172.31.204.2/32 password="CHANGE_TO_A_LONG_RANDOM_ROUTER_PASSWORD"
```

Do not grant `policy`, `sensitive`, `reboot`, `ssh`, `ftp`, `sniff`, or `romon`. `write` is required because the application creates/disables/deletes peers and manages queues. If a feature fails with a RouterOS permission error, review the exact command before widening this group.

Prefer `api-ssl` with a valid certificate. Restrict the service to the application IP:

```routeros
/ip/service/set api disabled=yes
/ip/service/set api-ssl disabled=no port=8729 address=172.31.204.2/32 tls-version=only-1.2
```

If certificate setup is not complete, a temporary unencrypted API restricted to the isolated container IP can be used during commissioning, then removed:

```routeros
/ip/service/set api disabled=no port=8728 address=172.31.204.2/32
```

Never expose RouterOS API ports to WAN.

### 8. Configure image extraction

```routeros
/container/config/set registry-url=https://registry-1.docker.io tmpdir=disk1/wg-manager/tmp memory-high=512M
```

For GHCR, set `registry-url=https://ghcr.io`. Private registries can use `/container/config` username/password on RouterOS versions that support registry authentication.

### 9. Create persistent mounts

```routeros
/container/mounts/add list=wg-db-mounts src=disk1/wg-manager/postgres dst=/var/lib/postgresql/data
/container/mounts/add list=wg-db-mounts src=disk1/wg-manager/backups dst=/backup
/container/mounts/add list=wg-app-mounts src=disk1/wg-manager/app-data dst=/data
```

Only PostgreSQL data and deliberate backups are persistent. QR images and client config exports are generated on demand.

### 10. Configure PostgreSQL environment

Replace both `CHANGE_...` values before executing:

```routeros
/container/envs/add list=wg-db-env key=POSTGRES_DB value=wireguard_control
/container/envs/add list=wg-db-env key=POSTGRES_USER value=wireguard_control
/container/envs/add list=wg-db-env key=POSTGRES_PASSWORD value="CHANGE_TO_A_LONG_RANDOM_DATABASE_PASSWORD"
/container/envs/add list=wg-db-env key=PGDATA value=/var/lib/postgresql/data/pgdata
/container/envs/add list=wg-db-env key=POSTGRES_INITDB_ARGS value="--encoding=UTF8 --locale=C"
```

### 11. Configure application environment

Generate secrets on a trusted computer, not in RouterOS logs:

```bash
openssl rand -base64 32
openssl rand -base64 36
```

The first value is `APP_ENCRYPTION_KEY`; the second can be used as the initial admin password. RouterOS environment lists are configuration, not a dedicated secrets vault. Router administrators with sufficient privileges may be able to view them. Protect RouterOS administrator access and keep an offline copy of `APP_ENCRYPTION_KEY` in a password manager. Losing or changing that key makes stored MikroTik credentials and managed WireGuard private keys undecryptable.

```routeros
/container/envs/add list=wg-app-env key=NODE_ENV value=production
/container/envs/add list=wg-app-env key=APP_URL value=http://192.168.88.1:2040
/container/envs/add list=wg-app-env key=PORT value=2040
/container/envs/add list=wg-app-env key=HOSTNAME value=0.0.0.0
/container/envs/add list=wg-app-env key=DB_HOST value=127.0.0.1
/container/envs/add list=wg-app-env key=DB_PORT value=5432
/container/envs/add list=wg-app-env key=DB_NAME value=wireguard_control
/container/envs/add list=wg-app-env key=DB_USER value=wireguard_control
/container/envs/add list=wg-app-env key=DB_PASSWORD value="CHANGE_TO_THE_SAME_DATABASE_PASSWORD"
/container/envs/add list=wg-app-env key=APP_ENCRYPTION_KEY value="CHANGE_TO_32_BYTE_BASE64_KEY"
/container/envs/add list=wg-app-env key=ADMIN_USERNAME value=admin
/container/envs/add list=wg-app-env key=ADMIN_PASSWORD value="CHANGE_TO_A_LONG_RANDOM_ADMIN_PASSWORD"
/container/envs/add list=wg-app-env key=SESSION_TTL_HOURS value=12
/container/envs/add list=wg-app-env key=MIKROTIK_STATS_INTERVAL value=30
/container/envs/add list=wg-app-env key=SYNC_INTERVAL_SECONDS value=300
/container/envs/add list=wg-app-env key=ROUTER_HEALTH_INTERVAL_SECONDS value=60
/container/envs/add list=wg-app-env key=BANDWIDTH_INTERVAL_SECONDS value=300
/container/envs/add list=wg-app-env key=OPERATION_RECONCILIATION_INTERVAL_SECONDS value=60
/container/envs/add list=wg-app-env key=RAW_TRAFFIC_SAMPLE_SECONDS value=300
/container/envs/add list=wg-app-env key=TRAFFIC_AGGREGATION_INTERVAL_SECONDS value=3600
/container/envs/add list=wg-app-env key=MAINTENANCE_INTERVAL_SECONDS value=21600
/container/envs/add list=wg-app-env key=AUDIT_RETENTION_DAYS value=180
/container/envs/add list=wg-app-env key=LOG_LEVEL value=info
/container/envs/add list=wg-app-env key=HEALTH_WORKER_STALE_SECONDS value=900
/container/envs/add list=wg-app-env key=STORAGE_WARNING_PERCENT value=80
/container/envs/add list=wg-app-env key=STORAGE_CRITICAL_PERCENT value=90
/container/envs/add list=wg-app-env key=EXPIRATION_INTERVAL_SECONDS value=60
/container/envs/add list=wg-app-env key=ROUTER_CONNECT_TIMEOUT_MS value=8000
/container/envs/add list=wg-app-env key=ONLINE_THRESHOLD_SECONDS value=180
/container/envs/add list=wg-app-env key=RECENT_THRESHOLD_SECONDS value=900
/container/envs/add list=wg-app-env key=PERSISTENT_DATA_PATH value=/data
/container/envs/add list=wg-app-env key=DEMO_MODE value=false
```

This application does not use a static `SESSION_SECRET`: session tokens are cryptographically random and only their hashes are stored. Do not invent or bake an unused secret into the image.

### 12. Add PostgreSQL

```routeros
/container/add remote-image=postgres:17-alpine interface=veth-wg root-dir=disk1/wg-manager/images/postgres mountlists=wg-db-mounts envlist=wg-db-env name=wg-db start-on-boot=yes logging=no
```

Wait until image extraction finishes and the status becomes `stopped`:

```routeros
/container/print detail where name="wg-db"
/container/start [find where name="wg-db"]
```

### 13. Add the application

Replace the image path with the image published by your build pipeline:

```routeros
/container/add remote-image=ghcr.io/your-org/wireguard-control:mikrotik interface=veth-wg root-dir=disk1/wg-manager/images/app mountlists=wg-app-mounts envlist=wg-app-env name=wg-app start-on-boot=yes logging=no
```

Then start it:

```routeros
/container/print detail where name="wg-app"
/container/start [find where name="wg-app"]
```

The application automatically retries if PostgreSQL is still initializing. Its entrypoint runs migrations and creates the first administrator only when no user exists.

Offline tar import replaces `remote-image=` with `file=`:

```routeros
/container/add file=disk1/wg-manager/wireguard-control-arm64.tar interface=veth-wg root-dir=disk1/wg-manager/images/app mountlists=wg-app-mounts envlist=wg-app-env name=wg-app start-on-boot=yes logging=no
```

### 14. Verify application health

From a trusted LAN workstation:

```bash
curl http://192.168.88.1:2040/health
```

Expected fields include application, database, scheduler, process memory, database size, and request latency. `/health` does not contact every managed router.

If RouterOS `fetch` is enabled:

```routeros
/tool/fetch url="http://172.31.204.2:2040/health" output=user
```

Open `http://192.168.88.1:2040`, sign in, then remove `ADMIN_PASSWORD` from the environment list because it is no longer required:

```routeros
/container/envs/remove [find where list="wg-app-env" and key="ADMIN_PASSWORD"]
```

Restart the application after changing an envlist:

```routeros
/container/stop [find where name="wg-app"]
/container/start [find where name="wg-app"]
```

### 15. Connect the first MikroTik

In the application, add the router with:

```text
Management IP: 172.31.204.1 or the router's reachable management IP
API type: Native
Port: the exact port shown by `/ip/service/print detail` (8729 for default api-ssl)
TLS: enabled
Verify TLS: enabled when the certificate chain/name is valid
Username: wg-control
Password: the dedicated API password
```

Run **Test connection**, save, synchronize, and verify interfaces, peers, last handshake, RX/TX, quota, and bandwidth state.

### 16. Verify persistence and recovery

Create or import a test peer, then record its lifetime/current usage. Restart both containers:

```routeros
/container/stop [find where name="wg-app"]
/container/stop [find where name="wg-db"]
/container/start [find where name="wg-db"]
/container/start [find where name="wg-app"]
```

Verify the user, router, peer, encrypted configuration, usage, audit history, and worker health remain present. Then perform a planned router reboot and repeat the verification.

## Performance settings

Use **Settings → Performance**. Conservative MikroTik starting values:

| Setting | Small deployment | 100–250 peers |
|---|---:|---:|
| Traffic poll | 30 seconds | 60 seconds unless quotas require 30 |
| Raw history sample | 300 seconds | 600 seconds |
| Full sync | 300 seconds | 600 seconds |
| Router health | 60 seconds | 120 seconds |
| Bandwidth reconciliation | 300 seconds | 600 seconds |
| Traffic aggregation | 3600 seconds | 3600 seconds |
| Raw retention | 24 hours | 6–12 hours |
| Hourly retention | 90 days | 30–90 days |
| Audit retention | 180 days | 90–180 days |

Unreachable routers use exponential backoff up to one hour. Routers without peers are skipped by fast traffic polling. Jobs cannot overlap with another instance of the same job. Router synchronization and health checks are sequential to avoid uncontrolled connection bursts.

## Logging

Production diagnostic logging is stdout/stderr only. `logging=no` is deliberate: it prevents routine application output from being copied into RouterOS logs. Successful polling is silent. A failure is logged on transition, when its error changes, and at a bounded reminder interval; recovery is logged once.

To diagnose temporarily:

```routeros
/container/set wg-app logging=yes
/log/print follow where message~"wg-app|WireGuard Control|ERROR|WARN"
```

Disable it afterward:

```routeros
/container/set wg-app logging=no
```

There are no persistent application log files, so `LOG_MAX_SIZE_MB` and `LOG_MAX_FILES` are intentionally unnecessary. RouterOS controls its own log actions and retention. Audit events remain compact rows in PostgreSQL and are governed by `AUDIT_RETENTION_DAYS`/Settings → Performance.

## Backups

Mount `/backup` only on PostgreSQL. Create a compressed custom-format dump:

```routeros
/container/shell wg-db cmd="sh -c 'PGPASSWORD=\"$POSTGRES_PASSWORD\" pg_dump -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -Fc -f /backup/wireguard-control.dump'"
```

Copy `disk1/wg-manager/backups/wireguard-control.dump` to a different physical device. Separately store these in a password manager or offline vault:

- `APP_ENCRYPTION_KEY` (mandatory for decrypting stored credentials/keys)
- PostgreSQL password
- application image tag/version
- RouterOS container/network/mount configuration

Do not put the encryption key inside the database dump. Do not back up image roots, tmp extraction files, QR images, generated configs, or debug logs.

Restore procedure:

1. Stop `wg-app`.
2. Preserve the current PostgreSQL directory and take another backup if possible.
3. Restore into the matching application/database version:

```routeros
/container/shell wg-db cmd="sh -c 'PGPASSWORD=\"$POSTGRES_PASSWORD\" pg_restore -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" --clean --if-exists /backup/wireguard-control.dump'"
```

4. Ensure the original `APP_ENCRYPTION_KEY` is configured.
5. Start `wg-app`; migrations run automatically.
6. Verify login, routers, peers, traffic totals, and one managed client configuration.

Test restore on non-production storage. An untested backup is not a recovery plan.

## Updates and rollback

Before every update:

1. Read release notes and migration notes.
2. Create and copy a database backup off the router.
3. Record the current immutable image tag; do not use `latest` for production rollback.
4. Update the app image:

```routeros
/container/stop [find where name="wg-app"]
/container/update [find where name="wg-app"]
/container/start [find where name="wg-app"]
```

Verify `/health`, authentication, one router sync, online/offline status, quota state, and QR/config download. If a database migration ran, rolling the image back may also require restoring the pre-update database dump.

## WinBox map

| Task | WinBox location |
|---|---|
| Architecture/RAM/CPU | System → Resources |
| Install/verify package | System → Packages |
| External storage | System → Disks and Files |
| Device mode | System → Device Mode |
| Bridge/veth | Bridge; Interfaces → VETH |
| Container config/env/mounts | Containers → Config / Envs / Mounts |
| Firewall/NAT | IP → Firewall → Filter Rules / NAT |
| API services | IP → Services |
| API user/group | System → Users |
| Container status | Containers |
| Temporary logs | Log and Containers → Logging |

CLI is authoritative because WinBox labels can change between RouterOS versions.

## Troubleshooting

### Container does not start

```routeros
/container/print detail
/log/print where topics~"container"
/system/resource/print
/disk/print detail
```

Temporarily enable logging on only the failing container. Check image extraction completion, root-dir/mount paths, memory-max, environment variables, and database readiness.

### Image architecture mismatch

Compare:

```routeros
/system/resource/print
/container/print detail
```

Use `linux/arm64` only for `architecture-name=arm64`; use `linux/amd64` for x86/CHR. ARM32 is unsupported by this application image.

### Not enough RAM or repeated kills

```routeros
/system/resource/print
/container/print detail
```

If `memory-current` approaches `memory-max`, do not simply remove limits. Increase hardware capacity, lengthen polling intervals, reduce history retention, or move the application off-router. Remote image pulls can require substantial temporary RAM.

### Storage full or database growth

```routeros
/disk/print detail
/file/print where name~"wg-manager"
```

Open **Settings → Performance** and inspect database, traffic, audit, and available storage metrics. Reduce raw/hourly/audit retention. Do not run `VACUUM FULL` routinely; it locks tables and requires temporary free space. After upgrading from an old build that created excessive snapshots, perform one planned database maintenance operation on external storage only after a verified backup.

### Application cannot reach RouterOS API

```routeros
/ip/service/print where name~"api"
/user/active/print
/ip/firewall/filter/print stats where dst-port=8728 or dst-port=8729
/ping 172.31.204.2
```

Confirm the service address restriction allows `172.31.204.2/32`, the custom user address matches, the firewall accept rule precedes drop rules, and TLS name/certificate verification matches the management address.

### Port 2040 is inaccessible

```routeros
/ip/firewall/nat/print stats where dst-port=2040
/ip/firewall/filter/print stats where dst-port=2040
/container/print detail where name="wg-app"
/tool/fetch url="http://172.31.204.2:2040/health" output=user
```

If direct container health works but LAN access fails, the problem is NAT/filter ordering or the chosen router LAN address.

### DNS unavailable

Set the app container's `dns=` to a reachable internal resolver or public resolver, stop/start the container, then test endpoint hostnames again. Prefer management IPs if internal DNS cannot be made reliable.

### Database unavailable or locked

```routeros
/container/print detail where name="wg-db"
/container/set wg-db logging=yes
/log/print follow where message~"wg-db|database|postgres"
```

Check the external disk, mount path, ownership initialized by the official PostgreSQL image, password equality between envlists, and memory limit. Disable logging when finished.

### Data disappears after restart

The PostgreSQL mount is wrong or points to volatile/internal storage. Verify `mountlists=wg-db-mounts`, `src=disk1/wg-manager/postgres`, and `PGDATA=/var/lib/postgresql/data/pgdata`. Application image root directories are not database backups.

### Router reboot or application restart

Both containers need `start-on-boot=yes`. Do not copy the obsolete `auto-restart-interval` parameter from older examples; RouterOS 7.24 rejects it. Restart-policy fields vary by RouterOS release, so inspect `/container/set ?` on the target router before configuring them. PostgreSQL may take longer to initialize; the application entrypoint retries database readiness. Verify scheduler state in `/health` and **Settings → Performance**.

### All peers show Router Unreachable after changing encryption key

The database credentials for managed routers were encrypted under the previous `APP_ENCRYPTION_KEY`. Restore that key or re-enter every MikroTik API username/password on the router detail page. Encryption cannot be bypassed or reversed without the original key.

## Validation checklist

Do not call a RouterOS deployment production-ready until all items pass on the exact MikroTik model:

- Correct architecture image starts.
- `/health` reports application, database, and scheduler healthy.
- Login and RBAC work.
- PostgreSQL survives app/database restart and full router reboot.
- Dedicated RouterOS API account can test and synchronize.
- Existing interfaces/peers import without duplicates.
- Managed peer creation, deletion confirmation, QR, and config download work.
- Handshake states, RX/TX, never-connected, disabled, and router-unreachable states update correctly.
- Quota enforcement and bandwidth reconciliation work after restart.
- A tested backup restores with the original encryption key.
- Logs remain silent during success and bounded during failure.
- Raw traffic and audit retention delete old rows.
- RAM/CPU stay within a safe margin during idle, poll, full sync, QR, and bulk operations.
- External storage has alerts and at least 20% free space.

Use `scripts/benchmark-runtime.ps1` and the procedure in `benchmarks/README.md` to capture repeatable host baselines. On-device RouterOS measurement must use `/system/resource/print`, container memory fields, disk statistics, and the exact production peer/polling profile.

## Final recommendation

Current evidence supports this provisional deployment policy:

```text
Minimum MikroTik RAM:          1 GB total, only after on-device validation
Recommended MikroTik RAM:      2 GB or more
Minimum CPU:                   2 cores with spare capacity
Recommended CPU:               4 cores so RouterOS retains priority
Minimum external storage:      2 GB free after image extraction
Recommended storage:           8+ GB SSD/NVMe, 20% free-space reserve
Recommended traffic polling:   30 seconds for strict quotas; otherwise 60 seconds
Recommended raw sampling:      5–10 minutes
Reasonable MikroTik peer cap:   100 peers initially; up to 250 only after measured validation
500+ peers:                     external Linux server
```

Monthly storage and log growth must be measured on the target peer count. Diagnostic file-log growth is zero because the application does not write log files. Database growth is dominated by peer counter updates, retained traffic samples, aggregates, and audit events. Do not publish a generic monthly number as if it were measured hardware data.
