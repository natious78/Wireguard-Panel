import { createHash } from "node:crypto";
import QRCode from "qrcode";
import { query } from "@/lib/db";
import { decryptSecret,encryptSecret } from "@/lib/security";

export function qrConfigHash(config:string){return createHash("sha256").update(config).digest("hex")}

export async function generateQrAssets(config:string){
  const [png,svg]=await Promise.all([
    QRCode.toBuffer(config,{type:"png",width:768,margin:3,errorCorrectionLevel:"M",color:{dark:"#07111f",light:"#ffffff"}}),
    QRCode.toString(config,{type:"svg",width:768,margin:3,errorCorrectionLevel:"M",color:{dark:"#07111f",light:"#ffffff"}}),
  ]);
  return{hash:qrConfigHash(config),pngEncrypted:encryptSecret(png.toString("base64")),svgEncrypted:encryptSecret(svg)};
}

export async function refreshPeerQr(peerId:string,config?:string){
  const value=config??(await (await import("./peer-service")).getPeerConfig(peerId)).config;
  const assets=await generateQrAssets(value);
  await query(`UPDATE peers SET qr_config_hash=$2,qr_png_encrypted=$3,qr_svg_encrypted=$4,qr_generated_at=now(),updated_at=now() WHERE id=$1`,
    [peerId,assets.hash,assets.pngEncrypted,assets.svgEncrypted]);
  return assets;
}

export async function getPeerQr(peerId:string,format:"png"|"svg"){
  const configResult=await (await import("./peer-service")).getPeerConfig(peerId);
  let stored=(await query<{name:string;qr_config_hash:string|null;qr_png_encrypted:string|null;qr_svg_encrypted:string|null}>(
    "SELECT name,qr_config_hash,qr_png_encrypted,qr_svg_encrypted FROM peers WHERE id=$1",[peerId])).rows[0];
  if(!stored)throw new Error("Peer not found.");
  const hash=qrConfigHash(configResult.config);
  if(stored.qr_config_hash!==hash||!stored.qr_png_encrypted||!stored.qr_svg_encrypted){await refreshPeerQr(peerId,configResult.config);stored=(await query("SELECT name,qr_config_hash,qr_png_encrypted,qr_svg_encrypted FROM peers WHERE id=$1",[peerId])).rows[0] as typeof stored;}
  if(format==="svg")return{name:stored.name,body:decryptSecret(stored.qr_svg_encrypted!),contentType:"image/svg+xml; charset=utf-8"};
  return{name:stored.name,body:Buffer.from(decryptSecret(stored.qr_png_encrypted!),"base64"),contentType:"image/png"};
}

export async function backfillPeerQrs(limit=20){const peers=await query<{id:string}>("SELECT id FROM peers WHERE private_key_encrypted IS NOT NULL AND (qr_config_hash IS NULL OR qr_png_encrypted IS NULL OR qr_svg_encrypted IS NULL) ORDER BY created_at LIMIT $1",[limit]);let generated=0;for(const peer of peers.rows){try{await refreshPeerQr(peer.id);generated+=1}catch{}}return generated}
