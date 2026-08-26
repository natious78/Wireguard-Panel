import {audit} from "@/lib/audit";
import {fail,handleApiError} from "@/lib/api";
import {requireUser} from "@/lib/auth";
import {clientForRouter,getRouter} from "@/server/router-repository";

export async function GET(_request:Request,context:{params:Promise<{id:string}>}){
  const auth=await requireUser("router:manage");if(!auth.user)return fail(auth.error,auth.status);const{id}=await context.params;let client:ReturnType<typeof clientForRouter>|undefined;
  try{
    const router=await getRouter(id);client=clientForRouter(router);const[facts,interfaces,peers,addresses,routes,nat,simpleQueues,queueTrees,mangle,filters]=await Promise.all([client.testConnection(),client.getInterfaces(),client.getPeers(),client.getAddresses(),client.getRoutes(),client.getNatRules(),client.getSimpleQueues(),client.getQueueTrees(),client.getMangleRules(),client.getFilterRules()]);
    const snapshot={schema:"wireguard-control.router-snapshot.v1",capturedAt:new Date().toISOString(),router:{name:router.name,facts},wireguard:{interfaces,peers:peers.map(peer=>({id:peer.id,interfaceName:peer.interfaceName,name:peer.name,comment:peer.comment,publicKey:peer.publicKey,allowedAddress:peer.allowedAddress,endpointAddress:peer.endpointAddress,endpointPort:peer.endpointPort,persistentKeepalive:peer.persistentKeepalive,disabled:peer.disabled}))},network:{addresses,routes,nat},shaping:{simpleQueues,queueTrees,mangle,filters}};
    await audit({user:auth.user,action:"router_configuration_snapshot_downloaded",routerId:id,result:"success",details:{interfaces:interfaces.length,peers:peers.length,simpleQueues:simpleQueues.length}});return new Response(JSON.stringify(snapshot,null,2)+"\n",{headers:{"Content-Type":"application/json; charset=utf-8","Content-Disposition":`attachment; filename="${safeName(router.name)}-routeros-snapshot.json"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"}});
  }catch(error){return handleApiError(error)}finally{await client?.close()}
}
function safeName(value:string){return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||"router"}
