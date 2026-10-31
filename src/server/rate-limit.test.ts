import { describe, expect, it } from "vitest";
import { RATE_LIMITS, checkRateLimit, clientKey, pickClientIp } from "./rate-limit";

describe("checkRateLimit", () => {
  it("allows up to the limit inside a window, then blocks until reset", () => {
    const key = `t-${Math.random()}`;
    expect(checkRateLimit(key, 2, 1000, 100)).toBe(true);
    expect(checkRateLimit(key, 2, 1000, 200)).toBe(true);
    expect(checkRateLimit(key, 2, 1000, 300)).toBe(false);
    expect(checkRateLimit(key, 2, 1000, 1200)).toBe(true);
  });

  it("keys are independent and clientKey prefers the first forwarded IP", () => {
    const req = new Request("https://x.example/api", {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
    });
    expect(clientKey(req, "create")).toBe("create:203.0.113.7");
    const bare = new Request("https://x.example/api");
    expect(clientKey(bare, "create")).toBe("create:unknown");
  });

  it("board-create and global upload per-IP limits exist (PIN-61)", () => {
    expect(RATE_LIMITS.boardCreatePerIp.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.uploadsPerIp.limit).toBeGreaterThan(
      RATE_LIMITS.submissionsPerIpGame.limit,
    );
    const key = `create-${Math.random()}`;
    const gate = RATE_LIMITS.boardCreatePerIp;
    for (let i = 0; i < gate.limit; i += 1) {
      expect(checkRateLimit(key, gate.limit, gate.windowMs, 1_000 + i)).toBe(true);
    }
    expect(checkRateLimit(key, gate.limit, gate.windowMs, 2_000)).toBe(false);
  });
});

describe("pickClientIp (PIN-112, documentation addresses only)", () => {
  const xff = (value: string, extra: Record<string, string> = {}) =>
    new Headers({ "x-forwarded-for": value, ...extra });
  const legacy = { trustedHops: null, header: null };
  const twoHops = { trustedHops: 2, header: null };
  const real = "203.0.113.7, 192.0.2.250, 192.0.2.251";

  it("without a hop count keeps today's behaviour exactly", () => {
    expect(pickClientIp(xff("203.0.113.7, 10.0.0.1"), legacy)).toBe("203.0.113.7");
    expect(pickClientIp(xff(" , 198.51.100.1"), legacy)).toBe("unknown");
    expect(pickClientIp(new Headers({ "x-real-ip": "192.0.2.5" }), legacy)).toBe("192.0.2.5");
    expect(pickClientIp(new Headers(), legacy)).toBe("unknown");
  });

  it("n hops picks the entry n from the right; supplied leading entries never move it", () => {
    expect(pickClientIp(xff(real), twoHops)).toBe("203.0.113.7");
    for (const supplied of ["198.51.100.1", "198.51.100.1, 198.51.100.2", "a, b, c, d"]) {
      expect(pickClientIp(xff(`${supplied}, ${real}`), twoHops)).toBe("203.0.113.7");
    }
    const zero = { trustedHops: 0, header: null };
    expect(pickClientIp(xff("198.51.100.9, 203.0.113.7"), zero)).toBe("203.0.113.7");
  });

  it("too few entries fall back to the first entry, never a shared constant", () => {
    expect(pickClientIp(xff("203.0.113.7, 192.0.2.250"), twoHops)).toBe("203.0.113.7");
    expect(pickClientIp(new Headers({ "x-real-ip": "192.0.2.5" }), twoHops)).toBe("192.0.2.5");
    expect(pickClientIp(new Headers(), twoHops)).toBe("unknown");
  });

  it("trims entries, drops empty ones, passes IPv6 through", () => {
    const messy = " ,198.51.100.1,, 203.0.113.7 ,192.0.2.250,  192.0.2.251 ,";
    expect(pickClientIp(xff(messy), twoHops)).toBe("203.0.113.7");
    const v6 = "2001:db8::1, 2001:db8::fe, 2001:db8::ff";
    expect(pickClientIp(xff(v6), twoHops)).toBe("2001:db8::1");
  });

  it("a configured header wins only with a single value; unconfigured it is ignored", () => {
    const fah = { trustedHops: 2, header: "x-fah-client-ip" };
    const headers = xff(`198.51.100.1, ${real}`, { "x-fah-client-ip": "203.0.113.8" });
    expect(pickClientIp(headers, twoHops)).toBe("203.0.113.7");
    expect(pickClientIp(headers, fah)).toBe("203.0.113.8");
    const merged = xff(real, { "x-fah-client-ip": "198.51.100.1, 203.0.113.8" });
    expect(pickClientIp(merged, fah)).toBe("203.0.113.7");
  });
});
