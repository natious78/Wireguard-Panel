import { describe,expect,it } from "vitest";
import { normalizePeer, parseRouterDate, parseRouterDurationSeconds } from "@/server/routeros/normalize";
import { peerStatus } from "@/server/status";

const observedAt=new Date("2026-08-18T12:00:00.000Z");
describe("RouterOS WireGuard presence",()=>{
  it("parses the duration forms returned by the live RouterOS 7.23.3 API",()=>{
    expect(parseRouterDurationSeconds("22s")).toBe(22);
    expect(parseRouterDurationSeconds("1m")).toBe(60);
    expect(parseRouterDurationSeconds("1m56s")).toBe(116);
    expect(parseRouterDurationSeconds("10h4m29s")).toBe(36269);
    expect(parseRouterDurationSeconds("2d22h7m7s")).toBe(252427);
    expect(parseRouterDate("1m56s",observedAt)?.toISOString()).toBe("2026-08-18T11:58:04.000Z");
  });
  it("preserves missing and invalid handshakes without creating Invalid Date",()=>{
    const base={".id":"*1",interface:"wg0","public-key":"key","allowed-address":"10.0.0.2/32",rx:"12",tx:"34",disabled:"false"};
    expect(normalizePeer(base,observedAt)).toMatchObject({lastHandshakeAt:null,lastHandshakeRaw:null,lastHandshakeParseValid:true,rxBytes:12n,txBytes:34n});
    expect(normalizePeer({...base,"last-handshake":"not-a-routeros-duration"},observedAt)).toMatchObject({lastHandshakeAt:null,lastHandshakeRaw:"not-a-routeros-duration",lastHandshakeParseValid:false});
  });
  it("prioritizes explicit and unknown states over stale handshake age",()=>{
    const thresholds={onlineSeconds:180,recentSeconds:900};
    const base={disabled:false,remote_disabled:false,expired:false,quota_reached_at:null,last_handshake_at:new Date(observedAt.getTime()-30_000),router_stats_status:"reachable"};
    expect(peerStatus(base,observedAt,thresholds)).toBe("online");
    expect(peerStatus({...base,last_handshake_at:new Date(observedAt.getTime()-300_000)},observedAt,thresholds)).toBe("recent");
    expect(peerStatus({...base,last_handshake_at:new Date(observedAt.getTime()-3600_000)},observedAt,thresholds)).toBe("offline");
    expect(peerStatus({...base,last_handshake_at:null},observedAt,thresholds)).toBe("never");
    expect(peerStatus({...base,router_stats_status:"unreachable"},observedAt,thresholds)).toBe("router_unreachable");
    expect(peerStatus({...base,remote_disabled:true},observedAt,thresholds)).toBe("disabled");
  });
});
