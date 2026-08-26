import { describe,expect,it } from "vitest";
import { MockRouterOsClient } from "@/server/routeros/mock-client";
import { generateWireGuardKeys } from "@/server/wireguard";
describe("mocked MikroTik peer lifecycle",()=>{
 it("creates, changes, disables, and deletes a RouterOS peer",async()=>{const client=new MockRouterOsClient();const key=generateWireGuardKeys().publicKey;const id=await client.createPeer({interfaceName:"wg-demo",publicKey:key,allowedAddress:"10.44.0.55/32",comment:"Test peer",persistentKeepalive:25});expect((await client.getPeers()).find(p=>p.id===id)?.publicKey).toBe(key);await client.updatePeer(id,{disabled:true,comment:"User A device",interfaceName:"wg-secondary"});expect((await client.getPeers()).find(p=>p.id===id)).toMatchObject({disabled:true,comment:"User A device",interfaceName:"wg-secondary"});await client.deletePeer(id);expect((await client.getPeers()).some(p=>p.id===id)).toBe(false)});
});
