export type ZipEntry={name:string;data:string|Buffer};

// Dependency-free ZIP writer. Entries are stored without compression so
// generated configurations never need temporary plaintext files on disk.
export function createZip(entries:ZipEntry[],now=new Date()){
  const local:Buffer[]=[];const central:Buffer[]=[];let offset=0;const {time,date}=dosDateTime(now);
  for(const entry of entries){
    const name=Buffer.from(safeZipPath(entry.name),"utf8");const data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data,"utf8");const crc=crc32(data);
    const header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);header.writeUInt16LE(0x0800,6);header.writeUInt16LE(time,10);header.writeUInt16LE(date,12);header.writeUInt32LE(crc,14);header.writeUInt32LE(data.length,18);header.writeUInt32LE(data.length,22);header.writeUInt16LE(name.length,26);local.push(header,name,data);
    const record=Buffer.alloc(46);record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(20,4);record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);record.writeUInt16LE(time,12);record.writeUInt16LE(date,14);record.writeUInt32LE(crc,16);record.writeUInt32LE(data.length,20);record.writeUInt32LE(data.length,24);record.writeUInt16LE(name.length,28);record.writeUInt32LE(offset,42);central.push(record,name);
    offset+=header.length+name.length+data.length;
  }
  const centralSize=central.reduce((sum,item)=>sum+item.length,0);const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(centralSize,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,...central,end]);
}
function safeZipPath(value:string){return value.replaceAll("\\","/").split("/").filter(part=>part&&part!=="."&&part!=="..").join("/")||"file"}
function dosDateTime(value:Date){const year=Math.max(1980,value.getFullYear());return{time:(value.getHours()<<11)|(value.getMinutes()<<5)|Math.floor(value.getSeconds()/2),date:((year-1980)<<9)|((value.getMonth()+1)<<5)|value.getDate()}}
const crcTable=Array.from({length:256},(_,index)=>{let value=index;for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;return value>>>0});
function crc32(data:Buffer){let value=0xffffffff;for(const byte of data)value=crcTable[(value^byte)&0xff]^(value>>>8);return(value^0xffffffff)>>>0}
