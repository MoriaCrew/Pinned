import { afterEach, describe, expect, it, vi } from "vitest";
import { logServerError, redactSlugs } from "./safe-log";

const SLUG = "AbCdEfGhIjKlMnOpQrSt_-";

describe("safe-log (PIN-167 review)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("blanks a standalone 22-char slug and leaves other tokens alone", () => {
    expect(redactSlugs(`Board ${SLUG} not found`)).toBe("Board <slug> not found");
    expect(redactSlugs(`boards/${SLUG}/elements`)).toBe("boards/<slug>/elements");
    // 21 and 23 characters are not slugs; ids and file names survive.
    expect(redactSlugs("Element abcdefghijklmnopqrstu-el0 missing")).toBe(
      "Element abcdefghijklmnopqrstu-el0 missing",
    );
    expect(redactSlugs("firestore-board-repository.ts:184")).toBe("firestore-board-repository.ts:184");
  });

  it("logs the error name and a redacted message and stack, never the slug", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("join failed", new RangeError(`Board ${SLUG} not found`));
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain(SLUG);
    expect(logged).toContain("RangeError");
    expect(logged).toContain("Board <slug> not found");
  });

  it("logs only the type for a non-Error throw", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logServerError("odd", `raw ${SLUG}`);
    expect(JSON.stringify(spy.mock.calls)).not.toContain(SLUG);
  });
});
