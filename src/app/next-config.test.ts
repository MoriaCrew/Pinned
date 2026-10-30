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
