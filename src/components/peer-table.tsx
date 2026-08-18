"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Download, Eye, LoaderCircle, Power, PowerOff, Trash2 } from "lucide-react";
import { api } from "@/lib/client-api";
import { QuotaUsage, StatusBadge } from "./ui";
import { HandshakeActivity } from "./ui";

type QuotaPeriod="one_time"|"daily"|"weekly"|"monthly";
export type PeerTableRow={
  id:string;name:string;description:string|null;router_name:string;interface_name:string;client_ip:string|null;public_key:string;
  origin:string;status:string;last_handshake_at:string|null;expires_at:string|null;rx:string;tx:string;currentUsage:string;
  periodUsageBytes:string;quotaLimit:string;quotaLimitBytes:string|null;quotaPeriod:QuotaPeriod|null;conflict_type:string|null;
};

export function PeerTable({rows,sort,queryString}:{rows:PeerTableRow[];sort:string;queryString:string}) {
  const router=useRouter();
  const [selected,setSelected]=useState<string[]>([]);
  const [loading,setLoading]=useState(false);
  const all=rows.length>0&&selected.length===rows.length;
  const bulk=async(action:"enable"|"disable"|"delete")=>{
    if(action==="delete"&&!confirm(`Permanently delete ${selected.length} selected peers from their MikroTik routers and the local database?`))return;
    setLoading(true);
    try{const result=await api<{failed:number}>("/api/peers/bulk",{method:"POST",body:JSON.stringify({ids:selected,action})});setSelected([]);router.refresh();if(result.failed)alert(`${result.failed} peer actions failed because of conflicts or router errors.`)}catch(e){alert(e instanceof Error?e.message:"Bulk action failed")}finally{setLoading(false)}
  };
  return <>
    {selected.length>0&&<div className="table-toolbar"><strong>{selected.length} selected</strong><button className="button button-small" onClick={()=>bulk("enable")} disabled={loading}><Power/>Enable</button><button className="button button-small" onClick={()=>bulk("disable")} disabled={loading}><PowerOff/>Disable</button><button className="button button-small button-danger" onClick={()=>bulk("delete")} disabled={loading}>{loading?<LoaderCircle className="spin"/>:<Trash2/>}Delete</button></div>}
    <div className="table-wrap"><table className="peers-table"><thead><tr>
      <th><input type="checkbox" aria-label="Select all peers" checked={all} onChange={event=>setSelected(event.target.checked?rows.map(row=>row.id):[])}/></th>
      <SortTh label="User / peer" field="name" sort={sort} queryString={queryString}/><th>Comment</th><SortTh label="IP" field="ip" sort={sort} queryString={queryString}/><SortTh label="Router" field="router" sort={sort} queryString={queryString}/><SortTh label="Status" field="status" sort={sort} queryString={queryString}/><SortTh label="Last handshake" field="handshake" sort={sort} queryString={queryString}/><SortTh label="RX" field="rx" sort={sort} queryString={queryString}/><SortTh label="TX" field="tx" sort={sort} queryString={queryString}/><SortTh label="Current usage" field="usage" sort={sort} queryString={queryString}/><SortTh label="Traffic limit" field="limit" sort={sort} queryString={queryString}/><SortTh label="Usage %" field="quota" sort={sort} queryString={queryString}/><SortTh label="Expires" field="expires" sort={sort} queryString={queryString}/><th><span className="sr-only">Actions</span></th>
    </tr></thead><tbody>{rows.map(peer=><tr key={peer.id}>
      <td><input type="checkbox" aria-label={`Select ${peer.name}`} checked={selected.includes(peer.id)} onChange={event=>setSelected(event.target.checked?[...selected,peer.id]:selected.filter(id=>id!==peer.id))}/></td>
      <td><div className="cell-main"><a href={`/peers/${peer.id}`}>{peer.name}</a></div><div className="cell-sub">{peer.origin}{peer.conflict_type&&<> · <span className="text-warning">conflict</span></>}</div></td>
      <td><span className="peer-comment">{peer.description||"—"}</span></td>
      <td className="mono">{peer.client_ip||"—"}</td>
      <td><div>{peer.router_name}</div><div className="cell-sub">{peer.interface_name}</div></td>
      <td><StatusBadge status={peer.status}/></td>
      <td><HandshakeActivity at={peer.last_handshake_at} status={peer.status}/></td>
      <td className="mono">{peer.rx}</td><td className="mono">{peer.tx}</td>
      <td><strong>{peer.currentUsage}</strong></td>
      <td><div>{peer.quotaLimit}</div>{peer.quotaPeriod&&<div className="cell-sub">{peer.quotaPeriod.replace("one_time","total")}</div>}</td>
      <td><QuotaUsage usedBytes={peer.periodUsageBytes} limitBytes={peer.quotaLimitBytes} period={peer.quotaPeriod} compact/></td>
      <td>{peer.expires_at?new Date(peer.expires_at).toLocaleString():"Never"}</td>
      <td><div className="table-actions"><a className="button button-small icon-button" href={`/peers/${peer.id}`} aria-label={`View ${peer.name}`}><Eye/></a>{peer.origin==="managed"&&<a className="button button-small icon-button" href={`/api/peers/${peer.id}/config`} aria-label={`Download ${peer.name} configuration`}><Download/></a>}</div></td>
    </tr>)}</tbody></table></div>
  </>;
}

function SortTh({label,field,sort,queryString}:{label:string;field:string;sort:string;queryString:string}){const active=sort.startsWith(`${field}_`);const descending=active&&sort.endsWith("_desc");const next=`${field}_${active&&!descending?"desc":"asc"}`;const href=`/peers?${queryString?`${queryString}&`:""}sort=${next}`;const Icon=!active?ArrowUpDown:descending?ArrowDown:ArrowUp;return <th aria-sort={active?(descending?"descending":"ascending"):"none"}><a className="sort-link" href={href}>{label}<Icon aria-hidden="true"/></a></th>}
