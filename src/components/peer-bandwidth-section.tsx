import { query } from "@/lib/db";
import { getEffectivePeerBandwidth } from "@/server/bandwidth-service";
import { PeerBandwidthCard } from "./peer-bandwidth-card";

export async function PeerBandwidthSection({peerId,syncState,canManage=true}:{peerId:string;syncState:string;canManage?:boolean}){
  const[policy,profiles]=await Promise.all([getEffectivePeerBandwidth(peerId),query<{id:string;name:string;download_bps:string|null;upload_bps:string|null}>("SELECT id,name,download_bps,upload_bps FROM bandwidth_profiles WHERE enabled ORDER BY system DESC,name")]);
  return <PeerBandwidthCard peerId={peerId} downloadBps={policy.downloadBps?.toString()??null} uploadBps={policy.uploadBps?.toString()??null} source={policy.source} sourceName={policy.sourceName} syncState={syncState} canManage={canManage} profiles={profiles.rows.map(profile=>({id:profile.id,name:profile.name,downloadBps:profile.download_bps,uploadBps:profile.upload_bps}))}/>;
}
