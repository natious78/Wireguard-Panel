import { query } from "@/lib/db";
import { redactError } from "@/lib/security";
import { setPeerEnabled } from "./peer-service";

export async function enforceExpirations() {
  const result = await query<{ id: string; name: string }>(
    `SELECT id,name FROM peers WHERE expires_at IS NOT NULL AND expires_at <= now() AND expired=false`,
  );
  let disabled = 0;
  let failed = 0;
  for (const peer of result.rows) {
    try {
      await query("UPDATE peers SET expired=true,updated_at=now() WHERE id=$1", [peer.id]);
      await setPeerEnabled(peer.id, false);
      await query(
        `INSERT INTO audit_logs(username,action,peer_id,result,details) VALUES('system','peer_expired',$1,'success',$2)`,
        [peer.id, JSON.stringify({ name: peer.name })],
      );
      disabled += 1;
    } catch (error) {
      await query(
        `INSERT INTO audit_logs(username,action,peer_id,result,details) VALUES('system','peer_expiration_failed',$1,'failure',$2)`,
        [peer.id, JSON.stringify({ error: redactError(error) })],
      );
      failed += 1;
    }
  }
  return { checked: result.rowCount ?? 0, disabled, failed };
}
