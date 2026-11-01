import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers";

describe("securityHeaders (PIN-212)", () => {
  const find = (key: string, days = 365) =>
    securityHeaders({ hstsMaxAgeDays: days }).find((header) => header.key === key)?.value;

  it("turns the Policy days into HSTS seconds, subdomains included, never preload", () => {
    expect(find("Strict-Transport-Security", 1)).toBe("max-age=86400; includeSubDomains");
    expect(find("Strict-Transport-Security", 365)).toBe("max-age=31536000; includeSubDomains");
  });

  it("keeps the sign-in iframe, the mic and board links working", () => {
    expect(find("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(find("Referrer-Policy")).toBe("same-origin");
    expect(find("Permissions-Policy")).toContain("microphone=(self)");
  });

  it("has each header once", () => {
    const keys = securityHeaders({ hstsMaxAgeDays: 365 }).map((header) => header.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
