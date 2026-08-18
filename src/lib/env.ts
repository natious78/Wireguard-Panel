import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1),
  APP_URL: z.string().url().default("http://localhost:2040"),
  APP_ENCRYPTION_KEY: z.string().min(1),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  ROUTER_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(8000),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(300),
  EXPIRATION_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(60),
  ONLINE_THRESHOLD_SECONDS: z.coerce.number().int().min(30).default(180),
  RECENT_THRESHOLD_SECONDS: z.coerce.number().int().min(60).default(900),
  DEMO_MODE: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  ADMIN_USERNAME: z.string().min(1).optional(),
  ADMIN_PASSWORD: z.string().min(12).optional(),
});

let cached: z.infer<typeof schema> | undefined;

export function env() {
  if (!cached) cached = schema.parse(process.env);
  return cached;
}

export function resetEnvForTests() {
  cached = undefined;
}
