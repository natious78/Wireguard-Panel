import {describe,expect,it} from "vitest";
import {compareIpAddresses} from "@/lib/ip-sort";

describe("IP-aware sorting",()=>{
  it("sorts IPv4 numerically across hosts and subnets",()=>{
    const values=["192.168.10.1","192.168.1.100","192.168.1.10","192.168.2.1","192.168.1.2","192.168.1.11","192.168.1.1","192.168.1.9"];
    expect(values.sort(compareIpAddresses)).toEqual(["192.168.1.1","192.168.1.2","192.168.1.9","192.168.1.10","192.168.1.11","192.168.1.100","192.168.2.1","192.168.10.1"]);
  });
  it("sorts CIDR by numeric address and then prefix",()=>{
    const values=["10.0.0.100/32","10.0.0.2/32","10.0.0.10/32","10.0.0.2/24"];
    expect(values.sort(compareIpAddresses)).toEqual(["10.0.0.2/24","10.0.0.2/32","10.0.0.10/32","10.0.0.100/32"]);
  });
  it("sorts numerically across unrelated IPv4 subnets",()=>{
    const values=["192.168.10.1","10.20.1.1","10.10.1.1","10.2.1.1","10.1.2.1","192.168.1.1","10.1.1.2"];
    expect(values.sort(compareIpAddresses)).toEqual(["10.1.1.2","10.1.2.1","10.2.1.1","10.10.1.1","10.20.1.1","192.168.1.1","192.168.10.1"]);
  });
  it("does not crash on invalid or missing values",()=>{
    const values:(string|null|undefined)[]=[null,"bad-value","10.0.0.2",undefined,"10.0.0.1"];
    expect(values.sort(compareIpAddresses).slice(0,2)).toEqual(["10.0.0.1","10.0.0.2"]);
  });
});
