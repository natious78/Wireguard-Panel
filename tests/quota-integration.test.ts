import { afterAll, beforeAll, describe, expect, it } from "vitest";

const integration = process.env.QUOTA_INTEGRATION === "true" ? describe : describe.skip;

integration("PostgreSQL-backed quota enforcement", () => {
  let routerId="";
  let remoteId="";
  let peerId="";

  beforeAll(async()=>{
    const [{query},{encryptSecret},{MockRouterOsClient},{generateWireGuardKeys},{syncRouter}]=await Promise.all([
      import("@/lib/db"),import("@/lib/security"),import("@/server/routeros/mock-client"),import("@/server/wireguard"),import("@/server/sync"),
    ]);
    const remote=new MockRouterOsClient();
    const key=generateWireGuardKeys().publicKey;
    remoteId=await remote.createPeer({interfaceName:"wg-demo",publicKey:key,allowedAddress:"10.44.0.88/32",comment:"Quota integration peer",persistentKeepalive:25});
    const router=await query<{id:string}>(`INSERT INTO routers(name,management_ip,api_port,api_type,use_tls,verify_tls,username_encrypted,password_encrypted,endpoint_ip,wireguard_port)
      VALUES($1,'192.0.2.10',8728,'native',false,true,$2,$3,'198.51.100.10',51820) RETURNING id`,[`Quota integration ${Date.now()}`,encryptSecret("test"),encryptSecret("test")]);
    routerId=router.rows[0].id;
    await syncRouter(routerId);
    const peer=await query<{id:string}>("SELECT id FROM peers WHERE router_id=$1 AND public_key=$2",[routerId,key]);
    peerId=peer.rows[0].id;
    await query(`UPDATE peers SET quota_limit_bytes=$2,quota_period='daily',quota_period_started_at=now()-interval '1 hour',quota_period_ends_at=now()+interval '23 hours' WHERE id=$1`,[peerId,(1024n**2n).toString()]);
  });

  afterAll(async()=>{
    const [{query},{MockRouterOsClient}]=await Promise.all([import("@/lib/db"),import("@/server/routeros/mock-client")]);
    await new MockRouterOsClient().deletePeer(remoteId).catch(()=>undefined);
    if(routerId)await query("DELETE FROM routers WHERE id=$1",[routerId]);
  });

  it("disables only the over-quota peer and re-enables it at the next period",async()=>{
    const [{query},{pollRouterTraffic},{MockRouterOsClient,setMockPeerTraffic}]=await Promise.all([
      import("@/lib/db"),import("@/server/traffic-accounting"),import("@/server/routeros/mock-client"),
    ]);
    setMockPeerTraffic(remoteId,700n*1024n,400n*1024n);
    const enforced=await pollRouterTraffic(routerId);
    if(enforced.failed){const failure=await query<{details:{error?:string}}>("SELECT details FROM audit_logs WHERE peer_id=$1 AND action='peer_traffic_poll_failed' ORDER BY created_at DESC LIMIT 1",[peerId]);throw new Error(failure.rows[0]?.details.error||"Traffic polling failed without an audit error")}
    expect(enforced).toMatchObject({failed:0,disabled:1});
    const reached=await query<{disabled:boolean;disabled_reason:string;quota_usage_when_disabled:string}>("SELECT disabled,disabled_reason,quota_usage_when_disabled FROM peers WHERE id=$1",[peerId]);
    expect(reached.rows[0]).toMatchObject({disabled:true,disabled_reason:"quota"});
    expect(BigInt(reached.rows[0].quota_usage_when_disabled)).toBeGreaterThanOrEqual(1024n**2n);
    expect((await new MockRouterOsClient().getPeers()).find(peer=>peer.id===remoteId)?.disabled).toBe(true);

    await query("UPDATE peers SET quota_period_ends_at=now()-interval '1 second' WHERE id=$1",[peerId]);
    const reset=await pollRouterTraffic(routerId);
    expect(reset.reenabled).toBe(1);
    const active=await query<{disabled:boolean;disabled_reason:string|null;period_rx_bytes:string;period_tx_bytes:string}>("SELECT disabled,disabled_reason,period_rx_bytes,period_tx_bytes FROM peers WHERE id=$1",[peerId]);
    expect(active.rows[0]).toMatchObject({disabled:false,disabled_reason:null,period_rx_bytes:"0",period_tx_bytes:"0"});
    expect((await new MockRouterOsClient().getPeers()).find(peer=>peer.id===remoteId)?.disabled).toBe(false);
  });
});
