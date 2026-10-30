import { describe, expect, it, vi } from "vitest";

// Board page metadata (PIN-102): every path carries the public origin,
// so the card URL never resolves against an internal request host.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "pinneds.test", "x-forwarded-proto": "https" }),
  cookies: async () => ({ get: () => undefined }),
}));

const { generateMetadata } = await import("./page");

describe("board page metadata (PIN-102)", () => {
  it("keeps metadataBase on the fallback for a malformed slug", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "not a slug!" }) });
    expect(meta.title).toBe("Pinneds board");
    expect(meta.metadataBase).toBeInstanceOf(URL);
    expect(meta.robots).toEqual({ index: false, follow: false });
  });

  it("keeps metadataBase on the fallback for a missing board", async () => {
    const meta = await generateMetadata({ params: Promise.resolve({ slug: "AAAAAAAAAAAAAAAAAAAAAA" }) });
    expect(meta.metadataBase).toBeInstanceOf(URL);
  });
});
