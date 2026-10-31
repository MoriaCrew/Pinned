import { afterEach, describe, expect, it, vi } from "vitest";
import nextConfig from "../../next.config";

/**
 * PIN-116 guard: tracing a file from ./public pre-creates
 * .next/standalone/public with only that file, and App Hosting's
 * adapter (<= 14.0.21) then skips copying public/ — every font and
 * image 404s in the hosted app. Server-read assets live under src/.
 */
describe("next.config tracing (PIN-116)", () => {
  it("never traces files from public/ into the server bundle", () => {
    const includes = Object.values(nextConfig.outputFileTracingIncludes ?? {}).flat();
    expect(includes.length).toBeGreaterThan(0);
    for (const glob of includes) {
      expect(glob, glob).not.toMatch(/^(\.\/)?public\//);
    }
  });
});

/** PIN-163: the /__/auth proxy follows config; off by default. */
describe("next.config rewrites (PIN-163)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function rewritesWith(env: Record<string, string>) {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { default: fresh } = await import("../../next.config");
    return fresh.rewrites?.();
  }

  it("flag off or link-only: no rewrites", async () => {
    const base = { AUTH_MODE: "optional", FIREBASE_PROJECT_ID: "demo-proj" };
    expect(await rewritesWith({ ...base, AUTH_SAME_ORIGIN: "" })).toEqual([]);
    expect(
      await rewritesWith({ ...base, AUTH_SAME_ORIGIN: "1", AUTH_MODE: "link-only" }),
    ).toEqual([]);
  });

  it("flag on + optional: only /__/auth to the project's firebaseapp host", async () => {
    expect(
      await rewritesWith({
        AUTH_SAME_ORIGIN: "1",
        AUTH_MODE: "optional",
        FIREBASE_PROJECT_ID: "demo-proj",
      }),
    ).toEqual([
      {
        source: "/__/auth/:path*",
        destination: "https://demo-proj.firebaseapp.com/__/auth/:path*",
      },
    ]);
  });
});

/**
 * PIN-212: baseline security headers on every route. Each value is
 * pinned because a loosened one (SAMEORIGIN → DENY breaks the same-
 * origin sign-in iframe; a Referer leak exposes board links) is a
 * product bug, not a style choice.
 */
describe("next.config headers (PIN-212)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function configWith(env: Record<string, string> = {}) {
    vi.resetModules();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const { default: fresh } = await import("../../next.config");
    return fresh;
  }

  const byKey = (list: { key: string; value: string }[]) =>
    Object.fromEntries(list.map((header) => [header.key, header.value]));

  it("applies one rule to every path", async () => {
    const rules = (await (await configWith()).headers?.()) ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0]?.source).toBe("/:path*");
  });

  it("sends the five baseline headers", async () => {
    const [rule] = (await (await configWith()).headers?.()) ?? [];
    expect(byKey(rule?.headers ?? [])).toEqual({
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
      // SAMEORIGIN, not DENY: AUTH_SAME_ORIGIN=1 loads /__/auth/iframe in our own frame.
      "X-Frame-Options": "SAMEORIGIN",
      // Board links are capability URLs: never in a Referer.
      "Referrer-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
      // Dictation needs the mic; Stripe Checkout is a redirect, not Payment Request.
      "Permissions-Policy": "camera=(), microphone=(self), geolocation=(), payment=()",
    });
  });

  it("does not ask browsers to preload HSTS and sets no CSP yet", async () => {
    const [rule] = (await (await configWith()).headers?.()) ?? [];
    const all = JSON.stringify(rule?.headers);
    expect(all).not.toMatch(/preload/i);
    expect(all).not.toMatch(/content-security-policy/i);
  });

  it("takes the HSTS life from Policy (POLICY_OVERRIDES_JSON), in seconds", async () => {
    const config = await configWith({ POLICY_OVERRIDES_JSON: '{"hstsMaxAgeDays":30}' });
    const [rule] = (await config.headers?.()) ?? [];
    expect(byKey(rule?.headers ?? [])["Strict-Transport-Security"]).toBe(
      "max-age=2592000; includeSubDomains",
    );
  });

  it("sits beside the sign-in proxy rewrites without disturbing them", async () => {
    const config = await configWith({
      AUTH_SAME_ORIGIN: "1",
      AUTH_MODE: "optional",
      FIREBASE_PROJECT_ID: "demo-proj",
    });
    expect(await config.rewrites?.()).toEqual([
      {
        source: "/__/auth/:path*",
        destination: "https://demo-proj.firebaseapp.com/__/auth/:path*",
      },
    ]);
    expect(await config.headers?.()).toHaveLength(1);
  });
});
