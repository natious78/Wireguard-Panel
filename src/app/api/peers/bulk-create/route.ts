import {NextRequest} from "next/server";
import {z} from "zod";
import {audit} from "@/lib/audit";
import {fail,handleApiError} from "@/lib/api";
import {can,requireUser} from "@/lib/auth";
import {csvLine,parseCsv} from "@/lib/csv";
import {validateCsrf} from "@/lib/csrf";
import {query} from "@/lib/db";
import {createZip} from "@/lib/zip";
import {createPeer,getPeerConfig} from "@/server/peer-service";

const schema=z.object({routerId:z.string().uuid(),interfaceId:z.string().uuid(),poolId:z.string().uuid(),defaultProfileId:z.string().uuid().nullable().optional(),csv:z.string().min(1).max(200_000),confirmed:z.literal(true)});
type Profile={id:string;name:string;pool_id:string|null;dns:string|null;client_allowed_ips:string|null;mtu:number|null;persistent_keepalive:number|null;quota_limit_bytes:string|null;quota_period:"one_time"|"daily"|"weekly"|"monthly"|null;bandwidth_profile_id:string|null;expiration_days:number|null};
type BandwidthProfile={id:string;name:string};

export async function POST(request:NextRequest){
  const auth=await requireUser("peer:create");if(!auth.user)return fail(auth.error,auth.status);if(!can(auth.user,"peer:download_config"))return fail("Downloading generated configurations is not permitted for this account.",403);if(!(await validateCsrf(request)))return fail("Security token expired.",403);
  try{
    const input=schema.parse(await request.json());const rawRows=parseCsv(input.csv);if(rawRows.length>50)throw new Error("A bulk operation can create at most 50 peers.");const names=rawRows.map(row=>row.name.trim().toLowerCase());if(new Set(names).size!==names.length)throw new Error("CSV peer names must be unique within this batch.");
    const [profilesResult,bandwidthResult,scope]=await Promise.all([
      query<Profile>("SELECT id,name,pool_id,dns,client_allowed_ips,mtu,persistent_keepalive,quota_limit_bytes,quota_period,bandwidth_profile_id,expiration_days FROM peer_profiles WHERE enabled ORDER BY name"),
      query<BandwidthProfile>("SELECT id,name FROM bandwidth_profiles WHERE enabled ORDER BY name"),
      query("SELECT p.id FROM wireguard_pools p JOIN wireguard_interfaces i ON i.id=p.interface_id WHERE p.id=$1 AND p.router_id=$2 AND p.interface_id=$3 AND p.enabled=true AND i.router_id=$2",[input.poolId,input.routerId,input.interfaceId]),
    ]);if(!scope.rowCount)throw new Error("The selected pool, interface, and router do not form an enabled provisioning scope.");
    const profiles=profilesResult.rows;const bandwidthProfiles=bandwidthResult.rows;const fallback=profiles.find(profile=>profile.id===input.defaultProfileId)??null;if(input.defaultProfileId&&!fallback)throw new Error("The default user profile was not found or is disabled.");
    const results:Array<{row:number;name:string;ok:boolean;id?:string;ip?:string;error?:string}>=[];const configs:Array<{name:string;data:string}>=[];
    for(let index=0;index<rawRows.length;index++){
      const row=rawRows[index];const name=row.name.trim();
      try{
        if(!name||name.length>120)throw new Error("Name is required and must be 120 characters or fewer.");const profile=row.profile?profiles.find(item=>item.name.toLowerCase()===row.profile.toLowerCase()):fallback;if(row.profile&&!profile)throw new Error(`Profile '${row.profile}' was not found or is disabled.`);if(profile?.pool_id&&profile.pool_id!==input.poolId)throw new Error(`Profile '${profile.name}' belongs to a different pool.`);
        const bandwidth=parseBandwidth(row.bandwidth,bandwidthProfiles);const quota=parseQuota(row.quota,profile);const expiration=parseExpiration(row.expiration,profile);
        const created=await createPeer({routerId:input.routerId,interfaceId:input.interfaceId,poolId:input.poolId,assignmentMode:"automatic",name,description:row.comment||undefined,profileId:profile?.id??null,dnsServer:profile?.dns??undefined,clientAllowedIps:profile?.client_allowed_ips??undefined,mtu:profile?.mtu??undefined,persistentKeepalive:profile?.persistent_keepalive??undefined,quotaBytes:quota.bytes,quotaPeriod:quota.period,expiresAt:expiration,usePresharedKey:false,...bandwidth,userId:auth.user.id});
        const config=await getPeerConfig(created.id);configs.push({name:`configs/${String(index+1).padStart(2,"0")}-${safeName(name)}.conf`,data:config.config});results.push({row:index+2,name,ok:true,id:created.id,ip:created.clientIp});await audit({user:auth.user,action:"peer_bulk_created",routerId:input.routerId,peerId:created.id,result:"success",details:{row:index+2,name,clientIp:created.clientIp}});
      }catch(error){const message=error instanceof Error?error.message:"Peer creation failed";results.push({row:index+2,name:name||`Row ${index+2}`,ok:false,error:message});await audit({user:auth.user,action:"peer_bulk_created",routerId:input.routerId,result:"failure",details:{row:index+2,name:name||null,error:message}})}
    }
    const report=[csvLine(["row","name","status","peer_id","ip","error"]),...results.map(item=>csvLine([item.row,item.name,item.ok?"created":"failed",item.id,item.ip,item.error]))].join("\r\n")+"\r\n";const body=createZip([...configs,{name:"results.csv",data:report}]);const created=results.filter(item=>item.ok).length,failed=results.length-created;
    return new Response(new Uint8Array(body),{headers:{"Content-Type":"application/zip","Content-Disposition":`attachment; filename="wireguard-bulk-${stamp(new Date())}.zip"`,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","X-Bulk-Created":String(created),"X-Bulk-Failed":String(failed)}});
  }catch(error){return handleApiError(error)}
}

function parseBandwidth(value:string|undefined,profiles:BandwidthProfile[]){const raw=value?.trim()??"";if(!raw||raw.toLowerCase()==="default")return{bandwidthMode:"default" as const};if(raw.toLowerCase()==="unlimited")return{bandwidthMode:"unlimited" as const};const profile=profiles.find(item=>item.name.toLowerCase()===raw.toLowerCase());if(profile)return{bandwidthMode:"profile" as const,bandwidthProfileId:profile.id};const match=raw.match(/^(\d+(?:\.\d+)?)\s*(?:mbps|m)?\s*[\/:]\s*(\d+(?:\.\d+)?)\s*(?:mbps|m)?$/i);if(!match)throw new Error("Bandwidth must be default, unlimited, a profile name, or download/upload Mbps such as 20/10.");return{bandwidthMode:"custom" as const,downloadLimitBps:BigInt(Math.round(Number(match[1])*1e6)),uploadLimitBps:BigInt(Math.round(Number(match[2])*1e6))}}
function parseQuota(value:string|undefined,profile:Profile|null|undefined){const raw=value?.trim()??"";if(!raw)return{bytes:profile?.quota_limit_bytes?BigInt(profile.quota_limit_bytes):null,period:profile?.quota_limit_bytes?profile.quota_period??"monthly":null};if(raw.toLowerCase()==="unlimited")return{bytes:null,period:null};const match=raw.match(/^(\d+(?:\.\d+)?)\s*(mb|gb|tb)$/i);if(!match)throw new Error("Quota must be unlimited or a value such as 100GB.");const multiplier:{[key:string]:number}={mb:1e6,gb:1e9,tb:1e12};return{bytes:BigInt(Math.round(Number(match[1])*multiplier[match[2].toLowerCase()])),period:(profile?.quota_period??"monthly") as "one_time"|"daily"|"weekly"|"monthly"}}
function parseExpiration(value:string|undefined,profile:Profile|null|undefined){if(value?.trim()){const parsed=new Date(value);if(Number.isNaN(parsed.getTime())||parsed<=new Date())throw new Error("Expiration must be a valid future date.");return parsed}return profile?.expiration_days?new Date(Date.now()+profile.expiration_days*86_400_000):null}
function safeName(value:string){return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,80)||"wireguard-peer"}
function stamp(value:Date){return value.toISOString().replace(/[-:]/g,"").slice(0,15).replace("T","-")}
