import { describe, expect, it } from "vitest";
import {
  generateAdminToken,
  generateSlug,
  hashToken,
  signPlayerCookie,
  signUserCookie,
} from "../domain/tokens";
import { resolvePolicy } from "../policy/policy";
import {
  buildHostCookieHeader,
  hostCookieMaxAgeSeconds,
  hostCookieName,
  hostCookiePath,
  hostTokenFrom,
  issueHostCredential,
  parseHostCookie,
  verifyHostToken,
} from "./host-session";

const SECRET = "test-secret-test-secret-test-secret-32";
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const policy = resolvePolicy({ plus: { hostCookieDays: 2 } });

describe("host credential (PIN-103)", () => {
  it("issues a random token and stores only its domain-separated hash + issue time", () => {
    const a = issueHostCredential(T0);
    const b = issueHostCredential(T0);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a.record).toEqual({ tokenHash: hashToken(`pinned-host-v1:${a.token}`), issuedAt: T0 });
    expect(JSON.stringify(a.record)).not.toContain(a.token);
    // Never the bare admin-token hash.
    expect(a.record.tokenHash).not.toBe(hashToken(a.token));
  });

  it("verifies the issued token within Policy age; fails for anything else", () => {
    const { token, record } = issueHostCredential(T0);
    const board = { host: record };
    expect(verifyHostToken(board, token, policy, T0)).toBe(true);
    expect(verifyHostToken(board, token, policy, T0 + 2 * DAY_MS)).toBe(true);
    // Expired server-side, whatever the browser kept.
    expect(verifyHostToken(board, token, policy, T0 + 2 * DAY_MS + 1)).toBe(false);
    // Another board's token, a tampered token, no token, no / null / revoked credential.
    expect(verifyHostToken(board, issueHostCredential(T0).token, policy, T0)).toBe(false);
    const flipped = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(verifyHostToken(board, flipped, policy, T0)).toBe(false);
    expect(verifyHostToken(board, null, policy, T0)).toBe(false);
    expect(verifyHostToken({}, token, policy, T0)).toBe(false);
    expect(verifyHostToken({ host: null }, token, policy, T0)).toBe(false);
    expect(verifyHostToken({ host: issueHostCredential(T0).record }, token, policy, T0)).toBe(false);
    // Malformed stored record never throws.
    expect(verifyHostToken({ host: { tokenHash: "zz", issuedAt: T0 } }, token, policy, T0)).toBe(false);
  });

  it("needs no session secret: issue and verify use the stored hash only", () => {
    const { token, record } = issueHostCredential(T0, () => generateAdminToken());
    expect(verifyHostToken({ host: record }, token, resolvePolicy(), T0)).toBe(true);
  });
});

describe("host cookie (PIN-103)", () => {
  const slug = generateSlug();

  it("parses only the versioned token shape (no I/O)", () => {
    const token = generateAdminToken();
    expect(parseHostCookie(`h1.${token}`)).toBe(token);
    for (const value of [token, `h2.${token}`, `h1.${token}x`, `h1.${token.slice(1)}`, "h1.", "", null]) {
      expect(parseHostCookie(value)).toBeNull();
    }
    // Participant / user cookies never parse as host cookies.
    const player = signPlayerCookie({ gameId: slug, playerId: "p1", issuedAt: 1 }, SECRET);
    const user = signUserCookie({ v: 1, uid: "u1", issuedAt: 1 }, SECRET);
    expect(parseHostCookie(player)).toBeNull();
    expect(parseHostCookie(user)).toBeNull();
  });

  it("is scoped to this board's API path with participant-cookie attributes", () => {
    expect(hostCookieName(slug)).toBe(`pinned_host_${slug}`);
    expect(hostCookiePath(slug)).toBe(`/api/boards/${slug}`);
    expect(hostCookieMaxAgeSeconds(policy)).toBe(2 * 24 * 60 * 60);
    expect(buildHostCookieHeader(slug, "tok", 60, true)).toBe(
      `pinned_host_${slug}=h1.tok; Path=/api/boards/${slug}; HttpOnly; SameSite=Lax; Max-Age=60; Secure`,
    );
    expect(buildHostCookieHeader(slug, "tok", 60, false)).not.toContain("Secure");
  });

  it("reads the token back from a request cookie for this board only", () => {
    const { token } = issueHostCredential(T0);
    const pair = buildHostCookieHeader(slug, token, 60, false).split(";")[0];
    const request = new Request("http://t/x", { headers: { cookie: `other=1; ${pair}` } });
    expect(hostTokenFrom(request, slug)).toBe(token);
    expect(hostTokenFrom(request, generateSlug())).toBeNull();
    expect(hostTokenFrom(new Request("http://t/x"), slug)).toBeNull();
  });
});
