import { describe,expect,it } from "vitest";
import QRCode from "qrcode";
import { generateClientConfig,generateWireGuardKeys } from "@/server/wireguard";
import { routerEndpoint } from "@/server/router-repository";
describe("WireGuard configuration",()=>{
 it("generates valid-length Curve25519 and optional preshared keys",()=>{const keys=generateWireGuardKeys(true);expect(Buffer.from(keys.privateKey,"base64")).toHaveLength(32);expect(Buffer.from(keys.publicKey,"base64")).toHaveLength(32);expect(Buffer.from(keys.presharedKey!,"base64")).toHaveLength(32)});
 it("selects domain before public and management IP",()=>{expect(routerEndpoint({endpoint_hostname:"vpn.example.com",endpoint_ip:"203.0.113.2",management_ip:"192.168.1.1"})).toBe("vpn.example.com");expect(routerEndpoint({endpoint_hostname:null,endpoint_ip:"203.0.113.2",management_ip:"192.168.1.1"})).toBe("203.0.113.2")});
 it("renders a complete client configuration and QR payload",async()=>{const config=generateClientConfig({privateKey:"A".repeat(44),clientIp:"10.20.30.4",dns:"1.1.1.1",serverPublicKey:"B".repeat(44),allowedIps:"0.0.0.0/0",endpointHost:"vpn.example.com",endpointPort:51820,persistentKeepalive:25,mtu:1420});expect(config).toContain("Address = 10.20.30.4/32");expect(config).toContain("Endpoint = vpn.example.com:51820");expect(config).toContain("AllowedIPs = 0.0.0.0/0");const png=await QRCode.toBuffer(config);expect(png.subarray(1,4).toString()).toBe("PNG")});
});
