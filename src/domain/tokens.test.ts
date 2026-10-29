import { describe, expect, it } from "vitest";
import {
  generateAdminToken,
  generateSlug,
  hashToken,
  signPlayerCookie,
  signUserCookie,
  verifyUserCookie,
  verifyPlayerCookie,
  isValidSlug,
  verifyToken,
} from "./tokens";

describe("tokens", () => {
  it("generates URL-safe slugs and tokens of distinct values", () => {
    const slug = generateSlug();
    expect(slug).toMatch(/^[A-Za-z0-9_-]{22}$/); // 128-bit base64url
    expect(generateSlug()).not.toBe(slug);
    expect(generateAdminToken()).not.toBe(generateAdminToken());
  });

  it("hashes and verifies admin tokens (hash never equals token)", () => {
    const token = generateAdminToken();
    const hash = hashToken(token);
    expect(hash).not.toContain(token);
    expect(verifyToken(token, hash)).toBe(true);
    expect(verifyToken("wrong", hash)).toBe(false);
    expect(verifyToken(token, "not-hex")).toBe(false);
  });

  it("round-trips a signed player cookie", () => {
    const payload = { gameId: "g1", playerId: "p1", issuedAt: 100 };
    const cookie = signPlayerCookie(payload, "secret");
    expect(verifyPlayerCookie(cookie, "secret")).toEqual(payload);
  });

  it("rejects tampered, wrong-secret and garbage cookies without throwing", () => {
    const cookie = signPlayerCookie({ gameId: "g1", playerId: "p1", issuedAt: 100 }, "secret");
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect(verifyPlayerCookie(tampered, "secret")).toBeNull();
    expect(verifyPlayerCookie(cookie, "other")).toBeNull();
    expect(verifyPlayerCookie("garbage", "secret")).toBeNull();
    expect(verifyPlayerCookie("", "secret")).toBeNull();
  });

  it("enforces max age when asked", () => {
    const cookie = signPlayerCookie({ gameId: "g1", playerId: "p1", issuedAt: 0 }, "secret");
    expect(verifyPlayerCookie(cookie, "secret", { now: 50, maxAgeMs: 100 })).not.toBeNull();
    expect(verifyPlayerCookie(cookie, "secret", { now: 200, maxAgeMs: 100 })).toBeNull();
  });

  it("validates canonical slugs and rejects paths (PIN-59)", () => {
    expect(isValidSlug(generateSlug())).toBe(true);
    expect(isValidSlug("a".repeat(22))).toBe(true);
    expect(isValidSlug("a".repeat(21))).toBe(false);
    expect(isValidSlug("a".repeat(23))).toBe(false);
    expect(isValidSlug("abc/def" + "x".repeat(15))).toBe(false);
    expect(isValidSlug("..%2F..%2Fetcxxxxxxxxx")).toBe(false);
    expect(isValidSlug("")).toBe(false);
  });

  it("round-trips a signed user cookie (PIN-83)", () => {
    const payload = { v: 1 as const, uid: "synthetic-user-1", issuedAt: 100 };
    const cookie = signUserCookie(payload, "secret");
    expect(verifyUserCookie(cookie, "secret")).toEqual(payload);
  });

  it("user and player cookies never cross-verify (domain separation, PIN-83)", () => {
    const userCookie = signUserCookie({ v: 1, uid: "u1", issuedAt: 100 }, "secret");
    const playerCookie = signPlayerCookie(
      { gameId: "g1", playerId: "p1", issuedAt: 100 },
      "secret",
    );
    expect(verifyPlayerCookie(userCookie, "secret")).toBeNull();
    expect(verifyUserCookie(playerCookie, "secret")).toBeNull();
  });

  it("rejects tampered, wrong-secret, garbage and expired user cookies (PIN-83)", () => {
    const cookie = signUserCookie({ v: 1, uid: "u1", issuedAt: 0 }, "secret");
    const tampered = cookie.slice(0, -1) + (cookie.endsWith("A") ? "B" : "A");
    expect(verifyUserCookie(tampered, "secret")).toBeNull();
    expect(verifyUserCookie(cookie, "other")).toBeNull();
    expect(verifyUserCookie("garbage", "secret")).toBeNull();
    expect(verifyUserCookie("", "secret")).toBeNull();
    expect(verifyUserCookie(cookie, "secret", { now: 50, maxAgeMs: 100 })).not.toBeNull();
    expect(verifyUserCookie(cookie, "secret", { now: 200, maxAgeMs: 100 })).toBeNull();
    expect(() => signUserCookie({ v: 1, uid: "u1", issuedAt: 0 }, "")).toThrow(RangeError);
  });

  it("refuses to sign with an empty secret", () => {
    expect(() => signPlayerCookie({ gameId: "g", playerId: "p", issuedAt: 0 }, "")).toThrow(
      RangeError,
    );
  });
});
