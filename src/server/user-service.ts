import {query,withTransaction} from "@/lib/db";
import {hashPassword} from "@/lib/security";

export type ManagedRole="super_admin"|"administrator"|"read_only";

export async function createManagedUser(input:{username:string;password:string;role:ManagedRole}){
  const username=normalizeUsername(input.username);const passwordHash=await hashPassword(input.password);const result=await query<{id:string}>("INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id",[username,passwordHash,input.role]);return result.rows[0].id;
}

export async function updateManagedUser(id:string,input:{role:ManagedRole;enabled:boolean;password?:string|null},actorId:string){
  if(id===actorId&&!input.enabled)throw new Error("You cannot disable your own account.");
  const passwordHash=input.password?.trim()?await hashPassword(input.password):null;
  return withTransaction(async db=>{
    const target=(await db.query<{id:string;username:string;role:ManagedRole;enabled:boolean}>("SELECT id,username,role,enabled FROM users WHERE id=$1 FOR UPDATE",[id])).rows[0];if(!target)throw new Error("User not found.");
    if(id===actorId&&input.role!==target.role)throw new Error("You cannot change your own role.");
    if(target.role==="super_admin"&&target.enabled&&(!input.enabled||input.role!=="super_admin")){
      const others=await db.query("SELECT id FROM users WHERE id<>$1 AND enabled=true AND role='super_admin' LIMIT 1",[id]);if(!others.rowCount)throw new Error("At least one enabled Super Admin account must remain.");
    }
    await db.query("UPDATE users SET role=$2,enabled=$3,password_hash=COALESCE($4,password_hash),updated_at=now() WHERE id=$1",[id,input.role,input.enabled,passwordHash]);
    if(passwordHash||target.role!==input.role||target.enabled!==input.enabled)await db.query("DELETE FROM sessions WHERE user_id=$1",[id]);
    return{username:target.username,role:input.role,enabled:input.enabled,passwordChanged:Boolean(passwordHash)};
  });
}

function normalizeUsername(value:string){const username=value.trim();if(!/^[a-zA-Z0-9._-]{3,64}$/.test(username))throw new Error("Username must be 3–64 characters using letters, numbers, dots, underscores, or hyphens.");return username}
