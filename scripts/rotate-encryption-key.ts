import type { PoolClient } from "pg";
import { pool, withTransaction } from "../src/lib/db";
import { decryptSecretWithKey, encryptSecretWithKey } from "../src/lib/security";

type RouterSecrets={id:string;username_encrypted:string;password_encrypted:string};
type PeerSecrets={id:string;private_key_encrypted:string|null;preshared_key_encrypted:string|null;qr_png_encrypted:string|null;qr_svg_encrypted:string|null};

const oldKey=process.env.OLD_APP_ENCRYPTION_KEY;
const newKey=process.env.APP_ENCRYPTION_KEY;
if(!oldKey)throw new Error("OLD_APP_ENCRYPTION_KEY is required.");
if(!newKey)throw new Error("APP_ENCRYPTION_KEY is required.");

function rotateValue(value:string,label:string){
  try{
    const plaintext=decryptSecretWithKey(value,oldKey!);
    const rotated=encryptSecretWithKey(plaintext,newKey!);
    if(decryptSecretWithKey(rotated,newKey!)!==plaintext)throw new Error("verification failed");
    return{value:rotated,rotated:true};
  }catch(oldError){
    try{decryptSecretWithKey(value,newKey!);return{value,rotated:false}}
    catch{throw new Error(`${label} cannot be decrypted with either the old or new key. Rotation was rolled back.`,{cause:oldError})}
  }
}

async function rotateRouter(db:PoolClient,router:RouterSecrets){
  const username=rotateValue(router.username_encrypted,`Router ${router.id} username`);
  const password=rotateValue(router.password_encrypted,`Router ${router.id} password`);
  await db.query("UPDATE routers SET username_encrypted=$2,password_encrypted=$3,updated_at=now() WHERE id=$1",[router.id,username.value,password.value]);
  return Number(username.rotated)+Number(password.rotated);
}

async function rotatePeer(db:PoolClient,peer:PeerSecrets){
  const fields=(['private_key_encrypted','preshared_key_encrypted','qr_png_encrypted','qr_svg_encrypted'] as const).map(field=>{
    const value=peer[field];return value?rotateValue(value,`Peer ${peer.id} ${field}`):{value:null,rotated:false};
  });
  await db.query(`UPDATE peers SET private_key_encrypted=$2,preshared_key_encrypted=$3,qr_png_encrypted=$4,qr_svg_encrypted=$5,updated_at=now() WHERE id=$1`,[peer.id,...fields.map(field=>field.value)]);
  return fields.reduce((total,field)=>total+Number(field.rotated),0);
}

async function main(){
  const result=await withTransaction(async db=>{
    await db.query("SELECT pg_advisory_xact_lock(hashtext('wireguard-control-encryption-key-rotation'))");
    const routers=await db.query<RouterSecrets>("SELECT id,username_encrypted,password_encrypted FROM routers ORDER BY id FOR UPDATE");
    const peers=await db.query<PeerSecrets>("SELECT id,private_key_encrypted,preshared_key_encrypted,qr_png_encrypted,qr_svg_encrypted FROM peers ORDER BY id FOR UPDATE");
    let valuesRotated=0;
    for(const router of routers.rows)valuesRotated+=await rotateRouter(db,router);
    for(const peer of peers.rows)valuesRotated+=await rotatePeer(db,peer);
    await db.query(`INSERT INTO audit_logs(username,action,result,details) VALUES('system','application_encryption_key_rotated','success',$1)`,[JSON.stringify({routers:routers.rowCount??0,peers:peers.rowCount??0,valuesRotated})]);
    return{routers:routers.rowCount??0,peers:peers.rowCount??0,valuesRotated};
  });
  process.stdout.write(`Encryption-key rotation completed: ${result.routers} routers, ${result.peers} peers, ${result.valuesRotated} encrypted values rotated.\n`);
}

main().then(()=>pool.end()).catch(async error=>{process.stderr.write(`Encryption-key rotation failed: ${error instanceof Error?error.message:"Unknown error"}\n`);await pool.end();process.exit(1)});
