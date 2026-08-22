type ParsedAddress={valid:boolean;family:4|6|0;parts:number[];prefix:number;raw:string};

function parseAddress(value:string|null|undefined):ParsedAddress{
  const raw=String(value??"").trim().split(",")[0]?.trim()??"";
  if(!raw)return{valid:false,family:0,parts:[],prefix:Number.MAX_SAFE_INTEGER,raw:""};
  const[address,prefixRaw]=raw.split("/");
  const octets=address.split(".");
  if(octets.length===4&&octets.every(part=>/^\d{1,3}$/.test(part)&&Number(part)<=255)){
    const prefix=prefixRaw===undefined?32:Number(prefixRaw);
    if(Number.isInteger(prefix)&&prefix>=0&&prefix<=32)return{valid:true,family:4,parts:octets.map(Number),prefix,raw};
  }
  // PostgreSQL/RouterOS can surface IPv6. A normalized lexical fallback is stable
  // after IPv4 and still keeps invalid/missing values from crashing a table.
  if(address.includes(":")&&/^[0-9a-f:]+$/i.test(address)){
    const prefix=prefixRaw===undefined?128:Number(prefixRaw);
    if(Number.isInteger(prefix)&&prefix>=0&&prefix<=128)return{valid:true,family:6,parts:[],prefix,raw:address.toLowerCase()};
  }
  return{valid:false,family:0,parts:[],prefix:Number.MAX_SAFE_INTEGER,raw};
}

export function compareIpAddresses(a:string|null|undefined,b:string|null|undefined){
  const left=parseAddress(a),right=parseAddress(b);
  if(left.valid!==right.valid)return left.valid?-1:1;
  if(!left.valid&&!right.valid)return left.raw.localeCompare(right.raw,undefined,{numeric:true,sensitivity:"base"});
  if(left.family!==right.family)return left.family-right.family;
  if(left.family===4){for(let index=0;index<4;index+=1){const delta=left.parts[index]-right.parts[index];if(delta)return delta}}
  else{const delta=left.raw.localeCompare(right.raw,undefined,{numeric:true,sensitivity:"base"});if(delta)return delta}
  return left.prefix-right.prefix;
}

