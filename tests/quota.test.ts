import { describe, expect, it } from "vitest";
import { counterDelta, quotaPeriodWindow, quotaState, toQuotaBytes } from "@/server/quota";

describe("traffic quota accounting", () => {
  it("turns router counter resets into non-negative deltas", () => {
    expect(counterDelta(1_000n, 1_250n)).toBe(250n);
    expect(counterDelta(1_000n, 125n)).toBe(125n);
    expect(counterDelta(null, 9_000n)).toBe(0n);
  });

  it("converts supported units and classifies warning thresholds", () => {
    expect(toQuotaBytes(50, "GB")).toBe(50n * 1024n ** 3n);
    const limit = 100n * 1024n ** 2n;
    expect(quotaState(79n * 1024n ** 2n, limit).state).toBe("normal");
    expect(quotaState(80n * 1024n ** 2n, limit).state).toBe("warning");
    expect(quotaState(90n * 1024n ** 2n, limit).state).toBe("high");
    expect(quotaState(limit, limit).state).toBe("reached");
  });

  it("uses configured local-time boundaries for recurring periods", () => {
    const now = new Date("2026-08-18T12:00:00Z");
    const policy = { timezone: "Asia/Tehran", weekStartsOn: 1, monthlyResetDay: 15 };
    const daily = quotaPeriodWindow(now, "daily", policy);
    expect(daily.start.toISOString()).toBe("2026-08-17T20:30:00.000Z");
    expect(daily.end?.toISOString()).toBe("2026-08-18T20:30:00.000Z");
    const weekly = quotaPeriodWindow(now, "weekly", policy);
    expect(weekly.start.toISOString()).toBe("2026-08-16T20:30:00.000Z");
    expect(weekly.end?.toISOString()).toBe("2026-08-23T20:30:00.000Z");
    const monthly = quotaPeriodWindow(now, "monthly", policy);
    expect(monthly.start.toISOString()).toBe("2026-08-14T20:30:00.000Z");
    expect(monthly.end?.toISOString()).toBe("2026-09-14T20:30:00.000Z");
  });
});
