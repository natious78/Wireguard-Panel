import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).optional(),
  DB_HOST: z.string().min(1).optional(),
  DB_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  DB_NAME: z.string().min(1).optional(),
  DB_USER: z.string().min(1).optional(),
  DB_PASSWORD: z.string().min(1).optional(),
  APP_URL: z.string().url().default("http://localhost:2040"),
  APP_ENCRYPTION_KEY: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  ROUTER_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
  MIKROTIK_STATS_INTERVAL: z.coerce.number().int().min(10).max(3600).default(30),
  ROUTER_HEALTH_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  BANDWIDTH_INTERVAL_SECONDS: z.coerce.number().int().min(60).max(86400).default(300),
  OPERATION_RECONCILIATION_INTERVAL_SECONDS: z.coerce.number().int().min(30).max(3600).default(60),
  TRAFFIC_AGGREGATION_INTERVAL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
  MAINTENANCE_INTERVAL_SECONDS: z.coerce.number().int().min(3600).max(86400).default(21600),
  RAW_TRAFFIC_SAMPLE_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().min(0).max(3650).default(180),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  HEALTH_WORKER_STALE_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  STORAGE_WARNING_PERCENT: z.coerce.number().int().min(50).max(95).default(80),
  STORAGE_CRITICAL_PERCENT: z.coerce.number().int().min(60).max(99).default(90),
  PERSISTENT_DATA_PATH: z.string().min(1).default("/data"),
  EXPIRATION_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(60),
  ONLINE_THRESHOLD_SECONDS: z.coerce.number().int().min(30).default(180),
  RECENT_THRESHOLD_SECONDS: z.coerce.number().int().min(60).default(900),
  DEMO_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
}).superRefine((value, context) => {
  if (value.DATABASE_URL || (value.DB_HOST && value.DB_NAME && value.DB_USER && value.DB_PASSWORD)) return;
  context.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["DATABASE_URL"],
    message: "Set DATABASE_URL, or set DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD.",
  });
});

let cached: z.infer<typeof schema> | undefined;

export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
