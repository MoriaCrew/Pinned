import { describe, expect, it } from "vitest";
import { checkRateLimit, clientKey } from "./rate-limit";

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
});
