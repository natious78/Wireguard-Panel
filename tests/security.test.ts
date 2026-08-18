import { describe,expect,it } from "vitest";
import { decryptSecret,encryptSecret,hashPassword,redactError,verifyPassword } from "@/lib/security";

describe("authentication and encryption",()=>{
 it("hashes passwords with a unique scrypt salt",async()=>{const a=await hashPassword("correct horse battery staple");const b=await hashPassword("correct horse battery staple");expect(a).not.toBe(b);expect(a.startsWith("scrypt$")).toBe(true);expect(await verifyPassword("correct horse battery staple",a)).toBe(true);expect(await verifyPassword("wrong password here",a)).toBe(false)});
 it("encrypts sensitive values with authenticated random nonces",()=>{const a=encryptSecret("router-secret");const b=encryptSecret("router-secret");expect(a).not.toBe(b);expect(decryptSecret(a)).toBe("router-secret");expect(()=>decryptSecret(a.slice(0,-2)+"aa")).toThrow()});
 it("redacts secret-like material from errors",()=>{expect(redactError(new Error("password=letmein private_key=abc123"))).not.toContain("letmein");expect(redactError(new Error("password=letmein private_key=abc123"))).not.toContain("abc123")});
});
