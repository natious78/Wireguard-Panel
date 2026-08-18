import { describe,expect,it } from "vitest";
import { classifyPeerSync } from "@/server/reconciliation";
import { remotePeerFingerprint } from "@/server/routeros";
import type { RemoteWireGuardPeer } from "@/server/routeros";
const remote:RemoteWireGuardPeer={id:"*1",interfaceName:"wg0",name:"Alice",comment:"Alice",publicKey:"public",allowedAddress:"10.0.0.2/32",endpointAddress:null,endpointPort:null,persistentKeepalive:25,disabled:false,lastHandshakeAt:null,lastHandshakeRaw:null,lastHandshakeParseValid:true,rxBytes:0n,txBytes:0n};
describe("safe synchronization classification",()=>{
 it("identifies router-only, database-only, and deleted peers",()=>{expect(classifyPeerSync(null,remote)).toBe("router_only");expect(classifyPeerSync({remoteId:null,remoteFingerprint:null,disabled:false},null)).toBe("db_only");expect(classifyPeerSync({remoteId:"*1",remoteFingerprint:"old",disabled:false},null)).toBe("deleted_externally")});
 it("detects external edits without overwriting them",()=>{const fp=remotePeerFingerprint(remote);expect(classifyPeerSync({remoteId:"*1",remoteFingerprint:fp,disabled:false},remote)).toBe("in_sync");expect(classifyPeerSync({remoteId:"*1",remoteFingerprint:fp,disabled:false},{...remote,comment:"changed"})).toBe("modified_externally");expect(classifyPeerSync({remoteId:"*1",remoteFingerprint:fp,disabled:false},{...remote,disabled:true})).toBe("disabled_externally")});
});
