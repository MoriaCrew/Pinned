import { describe, expect, it } from "vitest";
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
