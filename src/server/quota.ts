export type QuotaPeriod = "one_time" | "daily" | "weekly" | "monthly";
export type QuotaUnit = "MB" | "GB" | "TB";
export type QuotaPolicy = { timezone: string; weekStartsOn: number; monthlyResetDay: number };

const UNIT_BYTES: Record<QuotaUnit, number> = {
  MB: 1024 ** 2,
  GB: 1024 ** 3,
  TB: 1024 ** 4,
};

export function toQuotaBytes(value: number, unit: QuotaUnit) {
  if (!Number.isFinite(value) || value <= 0) throw new Error("Traffic limit must be greater than zero.");
  const bytes = Math.round(value * UNIT_BYTES[unit]);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("Traffic limit is too large.");
  return BigInt(bytes);
}

export function counterDelta(previous: bigint | null, current: bigint) {
  if (current < 0n) return 0n;
  if (previous === null) return 0n;
  return current >= previous ? current - previous : current;
}

export function quotaState(used: bigint, limit: bigint | null) {
  if (!limit || limit <= 0n) return { state: "unlimited" as const, percentage: null };
  const percentage = Number((used * 10_000n) / limit) / 100;
  if (used >= limit) return { state: "reached" as const, percentage };
  if (percentage >= 90) return { state: "high" as const, percentage };
  if (percentage >= 80) return { state: "warning" as const, percentage };
  return { state: "normal" as const, percentage };
}

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

export function isValidTimezone(timezone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }).format(); return true; }
  catch { return false; }
}

function zonedParts(date: Date, timezone: string): LocalParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: number("year"), month: number("month"), day: number("day"), hour: number("hour"), minute: number("minute"), second: number("second") };
}

function localToUtc(parts: LocalParts, timezone: string) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let value = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(new Date(value), timezone);
    const observedAsUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    const correction = desired - observedAsUtc;
    value += correction;
    if (correction === 0) break;
  }
  return new Date(value);
}

function shiftDate(parts: LocalParts, days: number): LocalParts {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: 0, minute: 0, second: 0 };
}

function monthDate(year: number, month: number, day: number) {
  const value = new Date(Date.UTC(year, month - 1, day));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: 0, minute: 0, second: 0 };
}

function localWeekday(parts: LocalParts) {
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

export function quotaPeriodWindow(now: Date, period: QuotaPeriod, policy: QuotaPolicy) {
  if (!isValidTimezone(policy.timezone)) throw new Error(`Invalid quota timezone: ${policy.timezone}`);
  if (period === "one_time") return { start: now, end: null };
  const local = zonedParts(now, policy.timezone);
  let startParts: LocalParts;
  let endParts: LocalParts;
  if (period === "daily") {
    startParts = { ...local, hour: 0, minute: 0, second: 0 };
    endParts = shiftDate(startParts, 1);
  } else if (period === "weekly") {
    const daysBack = (localWeekday(local) - policy.weekStartsOn + 7) % 7;
    startParts = shiftDate(local, -daysBack);
    endParts = shiftDate(startParts, 7);
  } else {
    const resetDay = Math.min(28, Math.max(1, policy.monthlyResetDay));
    const startMonthOffset = local.day >= resetDay ? 0 : -1;
    startParts = monthDate(local.year, local.month + startMonthOffset, resetDay);
    endParts = monthDate(startParts.year, startParts.month + 1, resetDay);
  }
  return { start: localToUtc(startParts, policy.timezone), end: localToUtc(endParts, policy.timezone) };
}

export function periodLabel(period: QuotaPeriod | null) {
  return period ? period.replace("one_time", "total").replaceAll("_", " ") : "unlimited";
}
