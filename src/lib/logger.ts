import { env } from "./env";

export type LogLevel = "error" | "warn" | "info" | "debug";

const priorities: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };
let activeLevel: LogLevel | undefined;
const faults = new Map<string, { signature: string; lastLoggedAt: number }>();
const MAX_FAULT_KEYS = 256;

export function setLogLevel(level: LogLevel) {
  activeLevel = level;
}

export function log(level: LogLevel, message: string, details?: Record<string, unknown>) {
  const configured = activeLevel ?? env().LOG_LEVEL;
  if (priorities[level] > priorities[configured]) return;
  const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details, jsonReplacer)}` : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}\n`;
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line);
}

export function logFault(key: string, signature: string, message: string, details?: Record<string, unknown>, reminderMs = 15 * 60_000) {
  const now = Date.now();
  const previous = faults.get(key);
  if (!previous || previous.signature !== signature || now - previous.lastLoggedAt >= reminderMs) {
    log("error", message, details);
    rememberFault(key, signature, now);
  }
}

export function logRecovery(key: string, message: string, details?: Record<string, unknown>) {
  if (!faults.delete(key)) return;
  log("info", message, details);
}

function rememberFault(key: string, signature: string, lastLoggedAt: number) {
  if (!faults.has(key) && faults.size >= MAX_FAULT_KEYS) {
    const oldest = faults.keys().next().value as string | undefined;
    if (oldest) faults.delete(oldest);
  }
  faults.set(key, { signature, lastLoggedAt });
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}
