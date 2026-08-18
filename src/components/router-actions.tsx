"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { api } from "@/lib/client-api";

export function SyncRouterButton({ id }: { id:string }){
  const router=useRouter();const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  return <><button className="button button-small" disabled={loading} onClick={async()=>{setLoading(true);setError("");try{await api(`/api/routers/${id}/sync`,{method:"POST"});router.refresh()}catch(e){setError(e instanceof Error?e.message:"Sync failed")}finally{setLoading(false)}}}>{loading?<LoaderCircle className="spin"/>:<RefreshCw/>}{loading?"Syncing…":"Sync now"}</button>{error&&<span className="error" role="alert">{error}</span>}</>;
}

export function DeleteRouterButton({ id,name }: { id:string;name:string }){
  const router=useRouter();const [loading,setLoading]=useState(false);
  return <button className="button button-small button-danger" disabled={loading} onClick={async()=>{if(!confirm(`Delete ${name} from WireGuard Control? This removes its locally stored peers and history. It does not delete anything from the MikroTik.`))return;setLoading(true);try{await api(`/api/routers/${id}`,{method:"DELETE"});router.push("/routers");router.refresh()}catch(e){alert(e instanceof Error?e.message:"Delete failed")}finally{setLoading(false)}}}><Trash2/>{loading?"Deleting…":"Delete"}</button>;
}
