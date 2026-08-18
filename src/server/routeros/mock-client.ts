import { randomUUID } from "node:crypto";
import { generateWireGuardKeys } from "../wireguard";
import type { CreateRemoteInterface,CreateRemotePeer,RemoteAddress,RemoteNatRule,RemoteRoute,RemoteWireGuardInterface,RemoteWireGuardPeer,RouterFacts,RouterOsClient,UpdateRemoteInterface,UpdateRemotePeer } from "./types";

const serverKeys=generateWireGuardKeys();
const interfaces:RemoteWireGuardInterface[]=[{id:"*1",name:"wg-demo",listenPort:51820,mtu:1420,publicKey:serverKeys.publicKey,running:true,disabled:false}];
const peers:RemoteWireGuardPeer[]=[];
export function setMockPeerTraffic(id:string,rxBytes:bigint,txBytes:bigint,lastHandshakeAt:Date|null=new Date()){const peer=peers.find(item=>item.id===id);if(!peer)throw new Error("no such item");peer.rxBytes=rxBytes;peer.txBytes=txBytes;peer.lastHandshakeAt=lastHandshakeAt;peer.lastHandshakeRaw=lastHandshakeAt?"1s":null;peer.lastHandshakeParseValid=true}
export class MockRouterOsClient implements RouterOsClient{
 async testConnection():Promise<RouterFacts>{return{identity:"Demo MikroTik",version:"7.21.1 (stable)",architecture:"arm64",boardName:"RB5009UG+S+",uptime:"2d4h12m",wireguardSupported:true}}
 async getInterfaces(){return structuredClone(interfaces)}async getPeers(){return peers.map(p=>({...p}))}async getAddresses():Promise<RemoteAddress[]>{return[{id:"*A",interfaceName:"wg-demo",address:"10.44.0.1/24",disabled:false}]}async getRoutes():Promise<RemoteRoute[]>{return[]}async getNatRules():Promise<RemoteNatRule[]>{return[]}
 async createPeer(input:CreateRemotePeer){const id=`*${randomUUID().slice(0,6)}`;peers.push({id,interfaceName:input.interfaceName,name:input.comment,comment:input.comment,publicKey:input.publicKey,allowedAddress:input.allowedAddress,endpointAddress:null,endpointPort:null,persistentKeepalive:input.persistentKeepalive,disabled:Boolean(input.disabled),lastHandshakeAt:null,lastHandshakeRaw:null,lastHandshakeParseValid:true,rxBytes:0n,txBytes:0n});return id}
 async updatePeer(id:string,input:UpdateRemotePeer){const peer=peers.find(p=>p.id===id);if(!peer)throw new Error("no such item");if(input.interfaceName!==undefined)peer.interfaceName=input.interfaceName;if(input.publicKey!==undefined)peer.publicKey=input.publicKey;if(input.allowedAddress!==undefined)peer.allowedAddress=input.allowedAddress;if(input.comment!==undefined){peer.comment=input.comment;peer.name=input.comment}if(input.persistentKeepalive!==undefined)peer.persistentKeepalive=input.persistentKeepalive;if(input.disabled!==undefined)peer.disabled=input.disabled;if(input.endpointAddress!==undefined)peer.endpointAddress=input.endpointAddress;if(input.endpointPort!==undefined)peer.endpointPort=input.endpointPort}
 async deletePeer(id:string){const index=peers.findIndex(p=>p.id===id);if(index<0)throw new Error("no such item");peers.splice(index,1)}
 async createInterface(input:CreateRemoteInterface){const id=`*${randomUUID().slice(0,6)}`;interfaces.push({id,name:input.name,listenPort:input.listenPort,mtu:input.mtu,publicKey:generateWireGuardKeys().publicKey,running:!input.disabled,disabled:Boolean(input.disabled)});return id}
 async updateInterface(id:string,input:UpdateRemoteInterface){const item=interfaces.find(i=>i.id===id);if(!item)throw new Error("no such item");Object.assign(item,{name:input.name??item.name,listenPort:input.listenPort??item.listenPort,mtu:input.mtu??item.mtu,disabled:input.disabled??item.disabled,running:input.disabled===undefined?item.running:!input.disabled})}
 async close(){}
}
