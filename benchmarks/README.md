# Runtime benchmark procedure

Run each scenario only after the target peer count exists and the router credentials are valid. The script does not fabricate peers or silently mutate RouterOS.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/benchmark-runtime.ps1 -Scenario idle -DurationSeconds 300
powershell -ExecutionPolicy Bypass -File scripts/benchmark-runtime.ps1 -Scenario 10-peers -DurationSeconds 600
powershell -ExecutionPolicy Bypass -File scripts/benchmark-runtime.ps1 -Scenario 100-peers -DurationSeconds 600
powershell -ExecutionPolicy Bypass -File scripts/benchmark-runtime.ps1 -Scenario traffic-poll -DurationSeconds 300
```

For the combined MikroTik simulation:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/benchmark-runtime.ps1 -Scenario idle -DurationSeconds 300 -Containers wgmt-test-app-1,wgmt-test-db-1 -DatabaseContainer wgmt-test-db-1 -ApplicationImage wireguard-control:mikrotik
```

For `sync`, trigger one full synchronization immediately after starting the sampler. For `bulk-qr`, request the QR endpoint for the intended managed peers while sampling. For `cleanup`, run the traffic retention job while sampling. Preserve the JSON output with the RouterOS model, architecture, RouterOS version, peer count, polling settings, and storage type.

The benchmark reports Docker container memory/CPU, block I/O, process count, image size, database size, peer count, traffic snapshot count, and audit-row count. Docker Desktop measurements are a development baseline, not proof of RouterOS hardware behavior.

The checked-in `docker-desktop-idle-2026-09-01.json` result records the final combined-image baseline. Keep future results separate and include the MikroTik model, RouterOS version, architecture, peer count, polling policy, and disk type.
