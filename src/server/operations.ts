import { query } from "@/lib/db";
import { redactError } from "@/lib/security";

export type OperationStatus="creating"|"active"|"partial"|"needs_reconciliation"|"failed"|"completed"|"pending_cleanup";

export async function startOperation(input:{type:string;routerId?:string|null;peerId?:string|null;userId?:string|null;idempotencyKey?:string|null;context?:Record<string,unknown>}) {
  const result=await query<{id:string}>(`INSERT INTO management_operations(operation_type,status,router_id,peer_id,requested_by,idempotency_key,context)
    VALUES($1,'creating',$2,$3,$4,$5,$6) ON CONFLICT(idempotency_key) DO UPDATE SET updated_at=now() RETURNING id`,
    [input.type,input.routerId??null,input.peerId??null,input.userId??null,input.idempotencyKey??null,JSON.stringify(input.context??{})]);
  return result.rows[0].id;
}

export async function operationStep(operationId:string,step:string,status:"started"|"succeeded"|"failed"|"rolled_back",details:Record<string,unknown>={}) {
  await query(`UPDATE management_operations SET steps=steps||$2::jsonb,status=CASE WHEN status='creating' THEN 'active' ELSE status END,updated_at=now() WHERE id=$1`,
    [operationId,JSON.stringify([{step,status,at:new Date().toISOString(),details}])]);
}

export async function finishOperation(operationId:string,status:OperationStatus="completed",context?:Record<string,unknown>) {
  await query(`UPDATE management_operations SET status=$2,context=CASE WHEN $3::jsonb IS NULL THEN context ELSE context||$3::jsonb END,last_error=NULL,finished_at=CASE WHEN $2 IN ('completed','failed') THEN now() ELSE finished_at END,updated_at=now() WHERE id=$1`,
    [operationId,status,context?JSON.stringify(context):null]);
}

export async function failOperation(operationId:string,error:unknown,status:Extract<OperationStatus,"failed"|"partial"|"needs_reconciliation"|"pending_cleanup">="failed",context?:Record<string,unknown>) {
  const message=redactError(error);const retry=status==="needs_reconciliation"||status==="pending_cleanup";
  await query(`UPDATE management_operations SET status=$2,last_error=$3,retry_count=retry_count+1,
    next_retry_at=CASE WHEN $4 THEN now()+(LEAST(3600,power(2,LEAST(retry_count,11))*15)::text||' seconds')::interval ELSE NULL END,
    context=CASE WHEN $5::jsonb IS NULL THEN context ELSE context||$5::jsonb END,finished_at=CASE WHEN $2='failed' THEN now() ELSE finished_at END,updated_at=now() WHERE id=$1`,
    [operationId,status,message,retry,context?JSON.stringify(context):null]);
}

export async function updateWorkerHealth(jobName:string,input:{status:"running"|"healthy"|"degraded"|"failed";startedAt?:Date;success?:boolean;error?:unknown;nextRunAt?:Date;durationMs?:number;details?:Record<string,unknown>}) {
  const error=input.error?redactError(input.error):null;
  await query(`INSERT INTO worker_job_health(job_name,status,last_started_at,last_success_at,last_failure_at,last_error,consecutive_failures,next_run_at,last_duration_ms,details,updated_at)
    VALUES($1,$2,$3,CASE WHEN $4 THEN now() END,CASE WHEN $5::text IS NOT NULL THEN now() END,$5,CASE WHEN $5::text IS NULL THEN 0 ELSE 1 END,$6,$7,$8,now())
    ON CONFLICT(job_name) DO UPDATE SET status=excluded.status,last_started_at=COALESCE(excluded.last_started_at,worker_job_health.last_started_at),
      last_success_at=CASE WHEN $4 THEN now() ELSE worker_job_health.last_success_at END,
      last_failure_at=CASE WHEN $5::text IS NOT NULL THEN now() ELSE worker_job_health.last_failure_at END,
      last_error=$5,consecutive_failures=CASE WHEN $4 THEN 0 WHEN $5::text IS NOT NULL THEN worker_job_health.consecutive_failures+1 ELSE worker_job_health.consecutive_failures END,
      next_run_at=$6,last_duration_ms=$7,details=$8,updated_at=now()`,
    [jobName,input.status,input.startedAt??null,Boolean(input.success),error,input.nextRunAt??null,input.durationMs??null,JSON.stringify(input.details??{})]);
}

export function fieldDifferences(application:Record<string,unknown>,synchronized:Record<string,unknown>,current:Record<string,unknown>) {
  const fields=new Set([...Object.keys(application),...Object.keys(synchronized),...Object.keys(current)]);
  return [...fields].flatMap((field)=>{
    const app=application[field],base=synchronized[field],router=current[field];
    if(JSON.stringify(app)===JSON.stringify(router))return[];
    return[{field,application:app??null,lastSynchronized:base??null,router:router??null,applicationChanged:JSON.stringify(app)!==JSON.stringify(base),routerChanged:JSON.stringify(router)!==JSON.stringify(base)}];
  });
}
