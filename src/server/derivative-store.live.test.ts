import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GcsDerivativeStore } from "./derivative-store";

/**
 * Opt-in live test against a real bucket. Run with:
 *   PINNED_LIVE_STORAGE_BUCKET=<bucket> PINNED_LIVE_STORAGE_PROJECT=<project> npm test -- src/server/derivative-store.live.test.ts
 * Uses Application Default Credentials. Writes one tiny object under
 * `tmp/pinned-live-test/` and deletes it again.
 */
const bucket = process.env.PINNED_LIVE_STORAGE_BUCKET;
const project = process.env.PINNED_LIVE_STORAGE_PROJECT;

describe.skipIf(!bucket)("GcsDerivativeStore (live)", () => {
  it("puts, gets, and deletes a derivative", async () => {
    const store = new GcsDerivativeStore(bucket as string, project ?? null);
    const ref = `tmp/pinned-live-test/${randomUUID()}/working.webp`;
    const payload = Buffer.from("pinned live derivative probe");
    await store.put(ref, payload, "image/webp");
    const got = await store.get(ref);
    expect(got?.equals(payload)).toBe(true);
    await store.delete(ref);
    expect(await store.get(ref)).toBeNull();
  }, 60_000);
});
