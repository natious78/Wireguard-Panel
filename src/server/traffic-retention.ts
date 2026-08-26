import { query, withTransaction } from "@/lib/db";

type RetentionPolicy={rawTrafficHours:number;hourlyDays:number;dailyMonths:number;archiveDeletedPeers:boolean};
const fallback:RetentionPolicy={rawTrafficHours:24,hourlyDays:90,dailyMonths:24,archiveDeletedPeers:true};

export async function aggregateAndRetainTraffic() {
  const policy=(await query<{value:RetentionPolicy}>("SELECT value FROM settings WHERE key='retention_policy'")).rows[0]?.value??fallback;
  validatePolicy(policy);
  return withTransaction(async(db)=>{
    const hourly=await db.query(`INSERT INTO traffic_usage_aggregates(peer_id,bucket_type,bucket_start,rx_bytes,tx_bytes,sample_count,updated_at)
      SELECT peer_id,'hour',date_trunc('hour',captured_at),sum(delta_rx_bytes),sum(delta_tx_bytes),count(*),now()
      FROM traffic_snapshots GROUP BY peer_id,date_trunc('hour',captured_at)
      ON CONFLICT(peer_id,bucket_type,bucket_start) DO UPDATE SET rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes,sample_count=excluded.sample_count,updated_at=now()`);
    await db.query(`INSERT INTO traffic_usage_aggregates(peer_id,bucket_type,bucket_start,rx_bytes,tx_bytes,sample_count,updated_at)
      SELECT peer_id,'day',date_trunc('day',bucket_start),sum(rx_bytes),sum(tx_bytes),sum(sample_count),now()
      FROM traffic_usage_aggregates WHERE bucket_type='hour' GROUP BY peer_id,date_trunc('day',bucket_start)
      ON CONFLICT(peer_id,bucket_type,bucket_start) DO UPDATE SET rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes,sample_count=excluded.sample_count,updated_at=now()`);
    await db.query(`INSERT INTO traffic_usage_aggregates(peer_id,bucket_type,bucket_start,rx_bytes,tx_bytes,sample_count,updated_at)
      SELECT peer_id,'month',date_trunc('month',bucket_start),sum(rx_bytes),sum(tx_bytes),sum(sample_count),now()
      FROM traffic_usage_aggregates WHERE bucket_type='day' GROUP BY peer_id,date_trunc('month',bucket_start)
      ON CONFLICT(peer_id,bucket_type,bucket_start) DO UPDATE SET rx_bytes=excluded.rx_bytes,tx_bytes=excluded.tx_bytes,sample_count=excluded.sample_count,updated_at=now()`);
    const raw=await db.query("DELETE FROM traffic_snapshots WHERE captured_at<now()-($1::text||' hours')::interval",[policy.rawTrafficHours]);
    const hours=await db.query("DELETE FROM traffic_usage_aggregates WHERE bucket_type='hour' AND bucket_start<now()-($1::text||' days')::interval",[policy.hourlyDays]);
    const days=await db.query("DELETE FROM traffic_usage_aggregates WHERE bucket_type='day' AND bucket_start<now()-($1::text||' months')::interval",[policy.dailyMonths]);
    return{hourlyBucketsUpdated:hourly.rowCount??0,rawDeleted:raw.rowCount??0,hourlyDeleted:hours.rowCount??0,dailyDeleted:days.rowCount??0};
  });
}

function validatePolicy(value:RetentionPolicy){
  if(!Number.isInteger(value.rawTrafficHours)||value.rawTrafficHours<1||value.rawTrafficHours>24*31)throw new Error("Raw traffic retention must be between 1 hour and 31 days.");
  if(!Number.isInteger(value.hourlyDays)||value.hourlyDays<1||value.hourlyDays>3660)throw new Error("Hourly retention must be between 1 and 3660 days.");
  if(!Number.isInteger(value.dailyMonths)||value.dailyMonths<1||value.dailyMonths>120)throw new Error("Daily retention must be between 1 and 120 months.");
}
