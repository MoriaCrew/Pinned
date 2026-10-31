import { describe, expect, it } from "vitest";
import { makerKey, makerSource } from "./maker-key";

describe("makerSource (PIN-205)", () => {
  it("a signed-in user is counted by account, whatever the address", () => {
    expect(makerSource({ userId: "uid-1", clientIp: "203.0.113.7" })).toBe("uid:uid-1");
    expect(makerSource({ userId: "  ", clientIp: "203.0.113.7" })).toBe("ip4:203.0.113.7");
  });

  it("IPv4 as is, with a port or through an IPv4-mapped IPv6 address", () => {
    expect(makerSource({ clientIp: " 203.0.113.7 " })).toBe("ip4:203.0.113.7");
    expect(makerSource({ clientIp: "203.0.113.7:51234" })).toBe("ip4:203.0.113.7");
    expect(makerSource({ clientIp: "::ffff:203.0.113.7" })).toBe("ip4:203.0.113.7");
    expect(makerSource({ clientIp: "::ffff:cb00:7107" })).toBe("ip4:203.0.113.7");
  });

  it("IPv6 groups by /64 in any spelling", () => {
    const a = makerSource({ clientIp: "2001:db8:1:2::1" });
    expect(a).toBe("ip6:2001:0db8:0001:0002");
    expect(makerSource({ clientIp: "2001:DB8:1:2:ffff:ffff:ffff:ffff" })).toBe(a);
    expect(makerSource({ clientIp: "[2001:db8:1:2::abcd]:443" })).toBe(a);
    expect(makerSource({ clientIp: "2001:db8:1:2::1%eth0" })).toBe(a);
    expect(makerSource({ clientIp: "2001:db8:1:3::1" })).not.toBe(a);
    expect(makerSource({ clientIp: "::1" })).toBe("ip6:0000:0000:0000:0000");
    expect(makerSource({ clientIp: "64:ff9b::192.0.2.1" })).toBe("ip6:0064:ff9b:0000:0000");
  });

  it("no usable address shares one bucket", () => {
    for (const clientIp of ["unknown", "", null, undefined, "not-an-ip", "999.1.1.1"]) {
      expect(makerSource({ clientIp })).toBe("ip:other");
    }
  });
});

describe("makerKey (PIN-205)", () => {
  it("is an opaque sha256 hex that never carries the raw address or uid", () => {
    const key = makerKey({ clientIp: "203.0.113.7" });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("203");
    expect(makerKey({ userId: "uid-1" })).not.toContain("uid-1");
  });

  it("same maker, same key; a uid never collides with an address source", () => {
    expect(makerKey({ clientIp: "2001:db8:1:2::1" })).toBe(makerKey({ clientIp: "2001:db8:1:2::9" }));
    expect(makerKey({ userId: "ip4:203.0.113.7" })).not.toBe(makerKey({ clientIp: "203.0.113.7" }));
  });
});
