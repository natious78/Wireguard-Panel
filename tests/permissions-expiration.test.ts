import { describe,expect,it } from "vitest";
import { can } from "@/lib/auth";
import { peerStatus } from "@/server/status";
describe("permissions and expiration status",()=>{
 it("enforces viewer, operator, and administrator boundaries",()=>{const base={id:"1",username:"u"};expect(can({...base,role:"viewer"},"read")).toBe(true);expect(can({...base,role:"viewer"},"write")).toBe(false);expect(can({...base,role:"operator"},"delete")).toBe(false);expect(can({...base,role:"admin"},"settings")).toBe(true)});
 it("gives disabled and expired states priority over handshake activity",()=>{const now=new Date("2026-08-18T10:00:00Z");expect(peerStatus({disabled:false,expired:true,last_handshake_at:now},now)).toBe("expired");expect(peerStatus({disabled:true,expired:false,last_handshake_at:now},now)).toBe("disabled");expect(peerStatus({disabled:false,expired:false,last_handshake_at:null},now)).toBe("never")});
 it("shows a reached quota even during a temporary re-enable",()=>{const now=new Date("2026-08-18T10:00:00Z");expect(peerStatus({disabled:false,expired:false,last_handshake_at:now,quota_reached_at:now},now)).toBe("traffic_limit_reached")});
});
