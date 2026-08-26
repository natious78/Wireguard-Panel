import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { query } from "@/lib/db";
import { encryptSecret } from "@/lib/security";
import { createPool,deletePool,getPoolStats,reservePoolAddress } from "@/server/pool-service";
import { createPeer,deletePeer } from "@/server/peer-service";
import { MockRouterOsClient } from "@/server/routeros/mock-client";
import { generateWireGuardKeys } from "@/server/wireguard";

const integration=process.env.POOL_INTEGRATION==="true"?describe:describe.skip;
integration("transactional WireGuard pool lifecycle",()=>{
  let routerId="",interfaceId="",poolId="",userId="",externalId="";const peerIds:string[]=[];
  beforeAll(async()=>{
    const user=await query<{id:string}>("INSERT INTO users(username,password_hash,role) VALUES($1,'test','super_admin') RETURNING id",[`ipam-${Date.now()}`]);userId=user.rows[0].id;
    const router=await query<{id:string}>(`INSERT INTO routers(name,management_ip,api_port,api_type,use_tls,verify_tls,username_encrypted,password_encrypted,endpoint_ip,wireguard_port)
      VALUES($1,'127.0.0.1',8728,'native',false,true,$2,$3,'vpn.example.test',51820) RETURNING id`,[`IPAM ${Date.now()}`,encryptSecret("test"),encryptSecret("test")]);routerId=router.rows[0].id;
    const keys=generateWireGuardKeys();const iface=await query<{id:string}>(`INSERT INTO wireguard_interfaces(router_id,remote_id,name,listen_port,mtu,public_key,running,addresses)
      VALUES($1,$2,'wg-ipam',51820,1420,$3,true,ARRAY['10.77.0.1/29']) RETURNING id`,[routerId,`*IPAM${Date.now()}`,keys.publicKey]);interfaceId=iface.rows[0].id;
    poolId=await createPool({name:"Integration pool",routerId,interfaceId,networkCidr:"10.77.0.0/29",gatewayIp:"10.77.0.1",startIp:"10.77.0.2",endIp:"10.77.0.6",dns:"1.1.1.1",clientAllowedIps:"0.0.0.0/0",endpointHost:"vpn.example.test",endpointPort:51820,mtu:1420,persistentKeepalive:25,enabled:true,userId});
    await reservePoolAddress(poolId,"10.77.0.2","Reserved server");
    const remote=new MockRouterOsClient();externalId=await remote.createPeer({interfaceName:"wg-ipam",publicKey:generateWireGuardKeys().publicKey,allowedAddress:"10.77.0.3/32",comment:"Existing MikroTik Peer",persistentKeepalive:25});
  });
  afterAll(async()=>{for(const id of peerIds)await deletePeer(id).catch(()=>undefined);if(externalId)await new MockRouterOsClient().deletePeer(externalId).catch(()=>undefined);if(poolId)await query("DELETE FROM wireguard_pool_addresses WHERE pool_id=$1 AND state='reserved'",[poolId]).catch(()=>undefined);if(poolId)await deletePool(poolId).catch(()=>undefined);if(routerId)await query("DELETE FROM routers WHERE id=$1",[routerId]).catch(()=>undefined);if(userId)await query("DELETE FROM users WHERE id=$1",[userId]).catch(()=>undefined)});
  it("validates, reserves, rechecks MikroTik, and allocates distinct addresses concurrently",async()=>{
    const make=(name:string)=>createPeer({routerId,interfaceId,poolId,assignmentMode:"automatic",name,userId,usePresharedKey:false});
    const[first,second]=await Promise.all([make("Concurrent A"),make("Concurrent B")]);peerIds.push(first.id,second.id);
    expect(new Set([first.clientIp,second.clientIp])).toEqual(new Set(["10.77.0.4","10.77.0.5"]));
    const stats=await getPoolStats(poolId);expect(stats).toEqual({total:5,used:2,reserved:1,available:2});
    const stored=await query<{pool_id:string;qr_config_hash:string|null;qr_png_encrypted:string|null;qr_svg_encrypted:string|null}>("SELECT pool_id,qr_config_hash,qr_png_encrypted,qr_svg_encrypted FROM peers WHERE id=ANY($1::uuid[]) ORDER BY client_ip",[peerIds]);
    expect(stored.rows.every(row=>row.pool_id===poolId&&row.qr_config_hash&&row.qr_png_encrypted===null&&row.qr_svg_encrypted===null)).toBe(true);
  });
  it("reports the live MikroTik owner for a conflicting manual IP",async()=>{
    await expect(createPeer({routerId,interfaceId,poolId,assignmentMode:"manual",requestedIp:"10.77.0.3",name:"Conflict",userId})).rejects.toThrow(/Existing MikroTik Peer/);
  });
});
