import { describe, expect, it } from "vitest";
import { desiredSimpleQueue, queueMatchesDesired, queueTargetsIp, type EffectiveBandwidthPolicy } from "@/server/bandwidth";
import { enabledFastTrackRules } from "@/server/bandwidth-service";

const limited: EffectiveBandwidthPolicy = {
  source: "peer", sourceName: "Peer override", downloadBps: 20_000_000n, uploadBps: 5_000_000n,
  burstDownloadBps: null, burstUploadBps: null, burstThresholdDownloadBps: null,
  burstThresholdUploadBps: null, burstTimeSeconds: null,
};

describe("RouterOS Simple Queue mapping", () => {
  it("writes RouterOS max-limit in upload/download order", () => {
    const desired = desiredSimpleQueue({ id: "3a62fc9b-152e-4be2-a55a-cddae6d5934e", name: "Example Peer", clientIp: "10.20.30.5" }, limited);
    expect(desired?.maxLimit).toBe("5000000/20000000");
    expect(desired?.target).toBe("10.20.30.5/32");
  });

  it("normalizes RouterOS rate suffixes during verification", () => {
    const desired = desiredSimpleQueue({ id: "3a62fc9b-152e-4be2-a55a-cddae6d5934e", name: "Example Peer", clientIp: "10.20.30.5" }, limited)!;
    expect(queueMatchesDesired({ id: "*1", ...desired, maxLimit: "5M/20M", dynamic: false, invalid: false }, desired)).toBe(true);
  });

  it("detects a non-owned queue whose target subnet contains the peer", () => {
    expect(queueTargetsIp({ id: "*1", name: "existing", target: "10.20.30.0/24", maxLimit: "1M/1M", burstLimit: "0/0", burstThreshold: "0/0", burstTime: "0s/0s", disabled: false, comment: "manual", dynamic: false, invalid: false }, "10.20.30.5")).toBe(true);
  });

  it("detects enabled FastTrack rules that can bypass Simple Queues",()=>{
    expect(enabledFastTrackRules([{ ".id":"*F1",chain:"forward",action:"fasttrack-connection",disabled:"no" }])).toHaveLength(1);
    expect(enabledFastTrackRules([{ ".id":"*F2",chain:"forward",action:"fasttrack-connection",disabled:"yes" }])).toHaveLength(0);
  });
});
