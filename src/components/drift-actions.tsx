"use client";
import { useState } from "react";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/client-api";

export function DriftActions({id}:{id:string}){
  const router=useRouter();const[loading,setLoading]=useState<"keep_router"|"apply_application"|null>(null);const[error,setError]=useState("");
  const resolve=async(resolution:"keep_router"|"apply_application")=>{setLoading(resolution);setError("");try{await api(`/api/drifts/${id}/resolve`,{method:"POST",body:JSON.stringify({resolution})});router.refresh()}catch(caught){setError(caught instanceof Error?caught.message:"Resolution failed")}finally{setLoading(null)}};
  return <div><div className="button-row"><button className="button button-small" disabled={Boolean(loading)} onClick={()=>resolve("keep_router")}>{loading==="keep_router"?<LoaderCircle className="spin"/>:<Check/>}Keep RouterOS</button><button className="button button-small button-primary" disabled={Boolean(loading)} onClick={()=>resolve("apply_application")}>{loading==="apply_application"?<LoaderCircle className="spin"/>:<RotateCcw/>}Apply application</button></div>{error&&<div className="form-message form-message-error" role="alert">{error}</div>}</div>;
}
