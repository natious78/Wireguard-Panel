import { describe,expect,it } from "vitest";
import { allocateClientIp,IpAllocationError,poolStats } from "@/server/ip-allocation";
describe("client IP allocation",()=>{
 it("returns the first address unused by RouterOS and the database",()=>{expect(allocateClientIp("10.20.30.2","10.20.30.6",["10.20.30.2/32","10.20.30.3"])).toBe("10.20.30.4")});
 it("blocks explicit duplicate and out-of-pool addresses",()=>{expect(()=>allocateClientIp("10.0.0.2","10.0.0.5",["10.0.0.3"],"10.0.0.3")).toThrow(IpAllocationError);expect(()=>allocateClientIp("10.0.0.2","10.0.0.5",[],"10.0.0.8")).toThrow(/outside/)});
 it("reports pool capacity",()=>{expect(poolStats("10.0.0.2","10.0.0.5",["10.0.0.2","10.0.0.3"])).toEqual({total:4,used:2,available:2})});
});
