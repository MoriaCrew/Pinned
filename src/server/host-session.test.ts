import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateSlug, signPlayerCookie, signUserCookie } from "../domain/tokens";
import { resolvePolicy } from "../policy/policy";
import {
  buildHostCookieHeader,
  hostCookieMaxAgeSeconds,
  hostCookieName,
  isHostRequest,
  issueHostCookie,
  signHostToken,
  verifyHostToken,
} from "./host-session";

const SECRET = "test-secret-test-secret-test-secret-32";
const OTHER_SECRET = "another-secret-another-secret-another-32";

describe("host token (PIN-103)", () => {
  const slug = generateSlug();

  it("is HMAC-SHA256 over host:<slug> and verifies for that slug", () => {
    const token = signHostToken(slug, SECRET);
    expect(token).toBe(
      createHmac("sha256", SECRET).update(`host:${slug}`).digest("base64url"),
    );
    expect(verifyHostToken(slug, token, SECRET)).toBe(true);
  });

  it("fails for another slug, a tampered token, the wrong secret, or nothing", () => {
    const token = signHostToken(slug, SECRET) as string;
    expect(verifyHostToken(generateSlug(), token, SECRET)).toBe(false);
    const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(verifyHostToken(slug, flipped, SECRET)).toBe(false);
    expect(verifyHostToken(slug, token.slice(1), SECRET)).toBe(false);
    expect(verifyHostToken(slug, `${token}x`, SECRET)).toBe(false);
    expect(verifyHostToken(slug, token, OTHER_SECRET)).toBe(false);
    expect(verifyHostToken(slug, null, SECRET)).toBe(false);
    expect(verifyHostToken(slug, "", SECRET)).toBe(false);
  });

  it("fails closed without a usable secret", () => {
    expect(signHostToken(slug, null)).toBeNull();
    expect(signHostToken(slug, "too-short")).toBeNull();
    const token = signHostToken(slug, SECRET);
    expect(verifyHostToken(slug, token, null)).toBe(false);
    expect(verifyHostToken(slug, token, "too-short")).toBe(false);
  });

  it("no participant or user cookie signature verifies as a host token", () => {
    const player = signPlayerCookie({ gameId: slug, playerId: "p1", issuedAt: 1 }, SECRET);
    const user = signUserCookie({ v: 1, uid: "u1", issuedAt: 1 }, SECRET);
    for (const value of [player, user, player.split(".")[1], user.split(".")[1]]) {
      expect(verifyHostToken(slug, value, SECRET)).toBe(false);
    }
  });
});

describe("host cookie (PIN-103)", () => {
  const slug = generateSlug();
  const policy = resolvePolicy({ plus: { hostCookieDays: 2 } });

  it("follows the participant cookie attributes, max age from Policy", () => {
    expect(hostCookieName(slug)).toBe(`pinned_host_${slug}`);
    expect(hostCookieMaxAgeSeconds(policy)).toBe(2 * 24 * 60 * 60);
    const header = buildHostCookieHeader(slug, "tok", 60, true);
    expect(header).toBe(`pinned_host_${slug}=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure`);
    expect(buildHostCookieHeader(slug, "tok", 60, false)).not.toContain("Secure");
  });

  it("issues a verifiable cookie, or nothing without a secret", () => {
    const header = issueHostCookie(slug, false, { sessionSecret: SECRET, policy });
    expect(header).toContain(`Max-Age=${2 * 24 * 60 * 60}`);
    const pair = (header as string).split(";")[0];
    const request = new Request("http://t/x", { headers: { cookie: `other=1; ${pair}` } });
    expect(isHostRequest(request, slug, SECRET)).toBe(true);
    expect(isHostRequest(request, generateSlug(), SECRET)).toBe(false);
    expect(isHostRequest(new Request("http://t/x"), slug, SECRET)).toBe(false);
    expect(issueHostCookie(slug, false, { sessionSecret: null, policy })).toBeNull();
  });
});
