import {describe,expect,it} from "vitest";
import {csvLine,parseCsv} from "@/lib/csv";
import {createZip} from "@/lib/zip";

describe("bulk provisioning artifacts",()=>{
  it("parses quoted fields and emits safe report lines",()=>{const rows=parseCsv('name,comment,quota\n"User A","Laptop, primary",100GB\n');expect(rows[0]).toEqual({name:"User A",comment:"Laptop, primary",quota:"100GB"});expect(csvLine(["User A","failed, retry"])).toBe('User A,"failed, retry"')});
  it("creates a ZIP with local and central directory records",()=>{const zip=createZip([{name:"configs/user-a.conf",data:"[Interface]\n"}],new Date("2026-01-01T00:00:00Z"));expect(zip.readUInt32LE(0)).toBe(0x04034b50);expect(zip.includes(Buffer.from("configs/user-a.conf"))).toBe(true);expect(zip.readUInt32LE(zip.length-22)).toBe(0x06054b50)});
});
