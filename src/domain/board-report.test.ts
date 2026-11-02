import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { reportBoardHref } from "./board-report";
import { boardReportRef } from "./tokens";

const SLUG = "AbCdEfGhIjKlMnOpQrStUv";

describe("boardReportRef (PIN-239)", () => {
  it("is the first 16 hex of the domain-separated sha256, so standard tools recompute it", () => {
    const expected = createHash("sha256").update(`pinned-report-v1:${SLUG}`, "utf8").digest("hex").slice(0, 16);
    expect(boardReportRef(SLUG)).toBe(expected);
    expect(boardReportRef(SLUG)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic, differs per board, and never carries the slug", () => {
    expect(boardReportRef(SLUG)).toBe(boardReportRef(SLUG));
    expect(boardReportRef(SLUG)).not.toBe(boardReportRef("ZyXwVuTsRqPoNmLkJiHgFe"));
    expect(boardReportRef(SLUG)).not.toContain(SLUG);
  });
});

describe("reportBoardHref (PIN-239)", () => {
  it("builds a mailto with the encoded subject and body", () => {
    const href = reportBoardHref("contact@example.com", "0123abcd", "Report a board (0123abcd)", "Board reference: 0123abcd\n\nWhat is wrong?");
    expect(href).toBe(
      "mailto:contact@example.com?subject=Report%20a%20board%20(0123abcd)&body=Board%20reference%3A%200123abcd%0A%0AWhat%20is%20wrong%3F",
    );
  });

  it("never puts the slug in the href, and is null without an address or a reference", () => {
    const ref = boardReportRef(SLUG);
    const href = reportBoardHref("contact@example.com", ref, `Report (${ref})`, `Ref: ${ref}`);
    expect(href).not.toContain(SLUG);
    expect(reportBoardHref(null, ref, "s", "b")).toBeNull();
    expect(reportBoardHref(undefined, ref, "s", "b")).toBeNull();
    expect(reportBoardHref("contact@example.com", null, "s", "b")).toBeNull();
    expect(reportBoardHref("contact@example.com", "", "s", "b")).toBeNull();
  });
});
