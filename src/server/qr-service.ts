import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { query } from "@/lib/db";

export function qrConfigHash(config:string){return createHash("sha256").update(config).digest("hex")}

export async function generateQrAssets(config:string){
  return{hash:qrConfigHash(config),pngEncrypted:null,svgEncrypted:null};
}

export async function refreshPeerQr(peerId:string,config?:string){
  const value=config??(await (await import("./peer-service")).getPeerConfig(peerId)).config;
  const assets=await generateQrAssets(value);
  await query(`UPDATE peers SET qr_config_hash=$2,qr_png_encrypted=NULL,qr_svg_encrypted=NULL,qr_generated_at=now(),updated_at=now() WHERE id=$1`,
    [peerId,assets.hash]);
  return assets;
}

export async function getPeerQr(peerId:string,format:"png"|"svg"){
  const configResult=await (await import("./peer-service")).getPeerConfig(peerId);
  const stored=(await query<{name:string;qr_config_hash:string|null}>("SELECT name,qr_config_hash FROM peers WHERE id=$1",[peerId])).rows[0];
  if(!stored)throw new Error("Peer not found.");
  const hash=qrConfigHash(configResult.config);
  if(stored.qr_config_hash!==hash)await refreshPeerQr(peerId,configResult.config);
  if(format==="svg")return{name:stored.name,body:await QRCode.toString(configResult.config,{type:"svg",width:768,margin:3,errorCorrectionLevel:"M",color:{dark:"#07111f",light:"#ffffff"}}),contentType:"image/svg+xml; charset=utf-8"};
  return{name:stored.name,body:await QRCode.toBuffer(configResult.config,{type:"png",width:768,margin:3,errorCorrectionLevel:"M",color:{dark:"#07111f",light:"#ffffff"}}),contentType:"image/png"};
}

export async function backfillPeerQrs(limit=20){const peers=await query<{id:string}>("SELECT id FROM peers WHERE private_key_encrypted IS NOT NULL AND qr_config_hash IS NULL ORDER BY created_at LIMIT $1",[limit]);let generated=0;for(const peer of peers.rows){try{await refreshPeerQr(peer.id);generated+=1}catch{}}return generated}
