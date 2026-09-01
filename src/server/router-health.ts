import { query } from "@/lib/db";
import { logFault, logRecovery } from "@/lib/logger";
import { redactError } from "@/lib/security";
import { clientForRouter, getRouter } from "./router-repository";
import type { RouterClock, RouterOsClient } from "./routeros";

export async function pollRouterHealth(routerId: string) {
  let client:RouterOsClient|undefined;
  const started = Date.now();
  try {
    const router = await getRouter(routerId);
    client = clientForRouter(router);
    const [facts, clock] = await Promise.all([client.testConnection(), client.getClock()]);
    const latencyMs = Date.now() - started;
    const clockDifferenceSeconds = routerClockDifferenceSeconds(clock);
    await query(`UPDATE routers SET connection_status='connected',identity=$2,routeros_version=$3,architecture=$4,board_name=$5,uptime=$6,
      wireguard_supported=$7,api_latency_ms=$8,clock_difference_seconds=$9,last_successful_connection_at=now(),last_error=NULL,
      last_checked_at=now(),consecutive_failures=0,next_retry_at=NULL,updated_at=now() WHERE id=$1`,
      [routerId,facts.identity,facts.version,facts.architecture,facts.boardName,facts.uptime,facts.wireguardSupported,latencyMs,clockDifferenceSeconds]);
    return { routerId, latencyMs, clockDifferenceSeconds };
  } catch (error) {
    await markRouterFailure(routerId,error);
    throw error;
  } finally { await client?.close(); }
}

export async function pollAllRouterHealth() {
  const routers = await query<{ id:string; name:string }>("SELECT id,name FROM routers WHERE enabled=true AND (next_retry_at IS NULL OR next_retry_at<=now()) ORDER BY name");
  const results:PromiseSettledResult<unknown>[]=[];
  for(const router of routers.rows){
    try{results.push({status:"fulfilled",value:await pollRouterHealth(router.id)});logRecovery(`router-health:${router.id}`,"Router connection restored",{router:router.name})}
    catch(error){const signature=redactError(error);results.push({status:"rejected",reason:error});logFault(`router-health:${router.id}`,signature,"Router became unreachable",{router:router.name,error:signature})}
  }
  return { routers:routers.rows.length,healthy:results.filter((result)=>result.status==="fulfilled").length,failed:results.filter((result)=>result.status==="rejected").length };
}

export async function markRouterFailure(routerId:string,error:unknown) {
  const message=redactError(error);
  await query(`UPDATE routers SET connection_status=CASE WHEN $2 ILIKE '%password%' OR $2 ILIKE '%username%' THEN 'auth_failed' ELSE 'offline' END,
    stats_poll_status='unreachable',last_stats_poll_at=now(),last_stats_error=$2,
    last_error=$2,last_failed_operation_at=now(),last_failed_operation=$2,last_checked_at=now(),
    consecutive_failures=consecutive_failures+1,
    next_retry_at=now()+(LEAST(3600,power(2,LEAST(consecutive_failures,11))*15)::text||' seconds')::interval,updated_at=now() WHERE id=$1`,[routerId,message]);
}

export function routerClockDifferenceSeconds(clock:RouterClock, observedAt=new Date()) {
  const date=normalizeRouterDate(clock.date);if(!date||!/^\d{2}:\d{2}:\d{2}/.test(clock.time))return null;
  const isoLocal=`${date}T${clock.time.slice(0,8)}`;
  const components=new Date(`${isoLocal}Z`);
  if(Number.isNaN(components.getTime()))return null;
  let instant=components.getTime();
  if(clock.timeZoneName){
    try{
      const formatter=new Intl.DateTimeFormat("en-CA",{timeZone:clock.timeZoneName,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",second:"2-digit",hourCycle:"h23"});
      const parts=Object.fromEntries(formatter.formatToParts(components).map((part)=>[part.type,part.value]));
      const represented=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
      instant-=represented-components.getTime();
    }catch{return null}
  }
  return Math.round((instant-observedAt.getTime())/1000);
}

function normalizeRouterDate(value:string){
  const raw=value.trim();if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
  const match=raw.match(/^(\w{3})\/(\d{1,2})\/(\d{4})$/i);if(!match)return null;
  const month:{[key:string]:string}={jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12"};
  const number=month[match[1].toLowerCase()];return number?`${match[3]}-${number}-${match[2].padStart(2,"0")}`:null;
}
