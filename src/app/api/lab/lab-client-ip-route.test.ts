import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * GET /api/lab/client-ip (PIN-112): lab-gated like the SAM lab and
 * answers header shape only. Config is cached per module graph, so
 * each case sets env and re-imports the route. Documentation
 * addresses only (RFC 5737 / RFC 3849).
 */
const KEYS = ["PINNED_LAB", "DATA_BACKEND", "CLIENT_IP_TRUSTED_HOPS"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

async function loadRoute(env: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  vi.resetModules();
  return (await import("./client-ip/route")).GET;
}

const probe = (headers: Record<string, string>) =>
  new Request("http://t/api/lab/client-ip", { headers });

afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("GET /api/lab/client-ip (PIN-112)", () => {
  it("404s when the lab is off (hosted, no PINNED_LAB)", async () => {
    const GET = await loadRoute({ DATA_BACKEND: "firestore" });
    const res = await GET(probe({ "x-forwarded-for": "203.0.113.7" }));
    expect(res.status).toBe(404);
  });

  it("answers shape only, never an address, uncached", async () => {
    const GET = await loadRoute({ PINNED_LAB: "1", DATA_BACKEND: "firestore", CLIENT_IP_TRUSTED_HOPS: "2" });
    const headers = {
      "x-forwarded-for": "198.51.100.1, 198.51.100.2, 203.0.113.7, 192.0.2.250, 192.0.2.251",
      "x-fah-client-ip": "203.0.113.7",
      "x-real-ip": "2001:db8::1",
    };
    const res = await GET(probe(headers));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      xffEntries: 5,
      hasFahClientIp: true,
      fahIndexFromRight: 2,
      hasXRealIp: true,
      configuredHops: 2,
    });
    for (const address of ["198.51.100", "203.0.113", "192.0.2", "2001:db8"]) {
      expect(text).not.toContain(address);
    }
  });

  it("reports absent headers and an unmatched platform header as null (memory mode)", async () => {
    const GET = await loadRoute({});
    const bare = await GET(probe({}));
    expect(await bare.json()).toEqual({
      xffEntries: 0,
      hasFahClientIp: false,
      fahIndexFromRight: null,
      hasXRealIp: false,
      configuredHops: null,
    });
    const unmatched = await GET(probe({ "x-forwarded-for": "192.0.2.9", "x-fah-client-ip": "203.0.113.3" }));
    expect(await unmatched.json()).toMatchObject({ xffEntries: 1, hasFahClientIp: true, fahIndexFromRight: null });
  });
});
