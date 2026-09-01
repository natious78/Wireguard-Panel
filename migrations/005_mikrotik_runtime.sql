-- Low-write runtime defaults for constrained RouterOS container deployments.

ALTER TABLE peers
  ADD COLUMN IF NOT EXISTS last_traffic_snapshot_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS traffic_snapshots_capture_idx ON traffic_snapshots(captured_at);
CREATE INDEX IF NOT EXISTS traffic_aggregates_type_time_idx ON traffic_usage_aggregates(bucket_type,bucket_start);

INSERT INTO settings(key,value) VALUES
  ('performance_policy','{"trafficPollSeconds":30,"syncIntervalSeconds":300,"routerHealthSeconds":60,"bandwidthSeconds":300,"operationReconciliationSeconds":60,"trafficAggregationSeconds":3600,"maintenanceSeconds":21600,"rawTrafficSampleSeconds":300,"auditRetentionDays":180,"logLevel":"info"}'::jsonb)
ON CONFLICT(key) DO NOTHING;
