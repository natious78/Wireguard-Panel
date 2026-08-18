import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, BookOpenCheck, Filter, Search } from "lucide-react";
import { query } from "@/lib/db";
import { EmptyState, PageHeader, StatusBadge } from "@/components/ui";

type Row={id:string;created_at:Date;username:string|null;action:string;result:string;router_name:string|null;peer_name:string|null;details:Record<string,unknown>;ip_address:string|null;total_count:string};
type SortKey="timestamp"|"user"|"action"|"target"|"result"|"ip";
type Direction="asc"|"desc";

const orderBy:Record<SortKey,string>={
  timestamp:"a.created_at",user:"coalesce(a.username,'system')",action:"a.action",
  target:"coalesce(p.name,r.name,'Application')",result:"a.result",ip:"a.ip_address",
};

export const metadata={title:"Audit Logs"};

export default async function AuditPage({searchParams}:{searchParams:Promise<{q?:string;result?:string;page?:string;sort?:string}>}){
  const p=await searchParams;
  const q=p.q||"";
  const resultFilter=p.result||"";
  const page=Math.max(1,Number(p.page)||1);
  const [requestedField,requestedDirection]=(p.sort||"timestamp_desc").split("_");
  const field=(requestedField in orderBy?requestedField:"timestamp") as SortKey;
  const direction:Direction=requestedDirection==="asc"?"asc":"desc";
  const sort=`${field}_${direction}`;
  const limit=75;
  const result=await query<Row>(`SELECT a.*,r.name router_name,p.name peer_name,count(*) OVER()::text total_count
    FROM audit_logs a LEFT JOIN routers r ON r.id=a.router_id LEFT JOIN peers p ON p.id=a.peer_id
    WHERE ($1='' OR a.action ILIKE '%'||$1||'%' OR coalesce(a.username,'') ILIKE '%'||$1||'%' OR coalesce(r.name,'') ILIKE '%'||$1||'%' OR coalesce(p.name,'') ILIKE '%'||$1||'%')
      AND ($2='' OR a.result=$2)
    ORDER BY ${orderBy[field]} ${direction},a.created_at DESC LIMIT $3 OFFSET $4`,[q,resultFilter,limit,(page-1)*limit]);
  const total=Number(result.rows[0]?.total_count||0);
  const base=new URLSearchParams();
  if(q)base.set("q",q);
  if(resultFilter)base.set("result",resultFilter);
  const pageHref=(nextPage:number)=>{const params=new URLSearchParams(base);params.set("sort",sort);params.set("page",String(nextPage));return `/audit?${params.toString()}`};
  return <>
    <PageHeader title="Audit logs" description="Administrative and system actions without credentials, private keys, or encryption material."/>
    <section className="card">
      <form className="table-toolbar">
        <div className="search"><Search/><input name="q" defaultValue={q} placeholder="Search action, user, router, peer…" aria-label="Search audit logs"/></div>
        <select name="result" defaultValue={resultFilter} aria-label="Filter audit result"><option value="">All results</option><option value="success">Success</option><option value="warning">Warning</option><option value="failure">Failure</option></select>
        <input type="hidden" name="sort" value={sort}/><button className="button button-small"><Filter/>Apply</button>
      </form>
      {result.rows.length?<div className="table-wrap"><table><thead><tr>
        <SortHeader label="Timestamp" field="timestamp" current={sort} base={base}/><SortHeader label="User" field="user" current={sort} base={base}/><SortHeader label="Action" field="action" current={sort} base={base}/><SortHeader label="Target" field="target" current={sort} base={base}/><SortHeader label="Result" field="result" current={sort} base={base}/><SortHeader label="Source IP" field="ip" current={sort} base={base}/>
      </tr></thead><tbody>{result.rows.map(a=><tr key={a.id}><td>{new Date(a.created_at).toLocaleString()}</td><td>{a.username||"system"}</td><td className="cell-main">{a.action.replaceAll("_"," ")}</td><td><div>{a.peer_name||a.router_name||"Application"}</div>{a.peer_name&&a.router_name&&<div className="cell-sub">{a.router_name}</div>}</td><td><StatusBadge status={a.result}/></td><td className="mono">{a.ip_address||"—"}</td></tr>)}</tbody></table></div>:<EmptyState icon={BookOpenCheck} title="No audit events" message="Administrative and synchronization activity will be recorded here."/>}
    </section>
    {total>limit&&<div className="actions" style={{justifyContent:"flex-end",marginTop:12}}><span className="cell-sub">{total} events</span>{page>1&&<Link className="button button-small" href={pageHref(page-1)}>Previous</Link>}{page*limit<total&&<Link className="button button-small" href={pageHref(page+1)}>Next</Link>}</div>}
  </>;
}

function SortHeader({label,field,current,base}:{label:string;field:SortKey;current:string;base:URLSearchParams}){
  const [active,direction]=current.split("_");
  const isActive=active===field;
  const next:Direction=isActive&&direction==="asc"?"desc":"asc";
  const params=new URLSearchParams(base);
  params.set("sort",`${field}_${next}`);
  const Icon=!isActive?ArrowUpDown:direction==="asc"?ArrowUp:ArrowDown;
  return <th aria-sort={isActive?(direction==="asc"?"ascending":"descending"):"none"}><Link className="sort-link" href={`/audit?${params.toString()}`}>{label}<Icon aria-hidden="true"/></Link></th>;
}
