import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import { RATE_LIMITS, checkRateLimit, clientKey } from "./rate-limit";

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

  it("board-create and global upload per-IP limits exist (PIN-61; board-create in Policy since PIN-205)", () => {
    expect(DEFAULT_POLICY.boardCreatePerIp.limit).toBeGreaterThan(0);
    expect(RATE_LIMITS.uploadsPerIp.limit).toBeGreaterThan(
      RATE_LIMITS.submissionsPerIpGame.limit,
    );
    const key = `create-${Math.random()}`;
    const gate = DEFAULT_POLICY.boardCreatePerIp;
    for (let i = 0; i < gate.limit; i += 1) {
      expect(checkRateLimit(key, gate.limit, gate.windowMs, 1_000 + i)).toBe(true);
    }
    expect(checkRateLimit(key, gate.limit, gate.windowMs, 2_000)).toBe(false);
  });
});
