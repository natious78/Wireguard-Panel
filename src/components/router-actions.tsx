"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/client-api";
import { ConfirmationDialog } from "./confirmation-dialog";

export function SyncRouterButton({ id }: { id:string }){
  const router=useRouter();const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  return <><button className="button button-small" disabled={loading} onClick={async()=>{setLoading(true);setError("");try{await api(`/api/routers/${id}/sync`,{method:"POST"});router.refresh()}catch(e){setError(e instanceof Error?e.message:"Sync failed")}finally{setLoading(false)}}}>{loading?<LoaderCircle className="spin"/>:<RefreshCw/>}{loading?"Syncing…":"Sync now"}</button>{error&&<span className="error" role="alert">{error}</span>}</>;
}

export function DeleteRouterButton({ id,name }: { id:string;name:string }){
  const router=useRouter();const [loading,setLoading]=useState(false);const[open,setOpen]=useState(false);const[error,setError]=useState("");
  const remove=async()=>{setLoading(true);setError("");try{await api(`/api/routers/${id}`,{method:"DELETE"});router.push("/routers");router.refresh()}catch(e){setError(e instanceof Error?e.message:"The router could not be deleted. Review its peers and try again.");setOpen(false)}finally{setLoading(false)}};
  return <><button className="button button-small button-danger" disabled={loading} onClick={()=>setOpen(true)}><Trash2/>Delete</button>{error&&<span className="error" role="alert">{error}</span>}{open&&<ConfirmationDialog title={`Delete “${name}”?`} description="This removes the router, its local peer inventory, and history from WireGuard Control." details={<p>The MikroTik itself is not changed. Export or back up anything you need before continuing.</p>} confirmLabel="Delete router" loading={loading} onCancel={()=>setOpen(false)} onConfirm={remove}/>}</>;
}
