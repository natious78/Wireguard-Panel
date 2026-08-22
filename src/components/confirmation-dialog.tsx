"use client";

import {useEffect,useRef} from "react";
import {AlertTriangle,LoaderCircle,X} from "lucide-react";

export function ConfirmationDialog({title,description,details,error,confirmLabel="Confirm",tone="danger",loading=false,onConfirm,onCancel}:{
  title:string;description:string;details?:React.ReactNode;error?:string;confirmLabel?:string;tone?:"danger"|"warning";loading?:boolean;onConfirm:()=>void|Promise<void>;onCancel:()=>void;
}){
  const cancelRef=useRef<HTMLButtonElement>(null);
  useEffect(()=>{cancelRef.current?.focus();const handler=(event:KeyboardEvent)=>{if(event.key==="Escape"&&!loading)onCancel()};document.addEventListener("keydown",handler);return()=>document.removeEventListener("keydown",handler)},[loading,onCancel]);
  return <div className="dialog-backdrop" role="presentation"><section className="dialog confirmation-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirmation-title" aria-describedby="confirmation-description">
    <header className="dialog-header"><div className={`confirmation-icon confirmation-icon-${tone}`}><AlertTriangle aria-hidden="true"/></div><div><h2 id="confirmation-title">{title}</h2><p id="confirmation-description">{description}</p></div><button className="button button-ghost icon-button" type="button" aria-label="Close confirmation" onClick={onCancel} disabled={loading}><X/></button></header>
    {(details||error)&&<div className="dialog-body confirmation-details">{details}{error&&<div className="form-message form-message-error" role="alert">{error}</div>}</div>}
    <footer className="dialog-footer"><button ref={cancelRef} className="button" type="button" onClick={onCancel} disabled={loading}>Cancel</button><button className={tone==="danger"?"button button-danger":"button button-primary"} type="button" onClick={onConfirm} disabled={loading}>{loading&&<LoaderCircle className="spin"/>}{loading?`${confirmLabel}…`:confirmLabel}</button></footer>
  </section></div>;
}
