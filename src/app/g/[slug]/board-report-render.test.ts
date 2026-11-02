import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { boardReportRef } from "../../../domain/tokens";
import { ReportBoardLink } from "./ReportBoard";

// ReportBoardLink reads the language with a hook; mock it like add-pick.test.ts.
vi.mock("../../../i18n/client", () => ({ useLocale: () => "en" }));

const SLUG = "AbCdEfGhIjKlMnOpQrStUv";

describe("report this board (PIN-239)", () => {
  it("mails the legal contact with the reference, never the slug", () => {
    const ref = boardReportRef(SLUG);
    const out = renderToStaticMarkup(h(ReportBoardLink, { email: "contact@example.com", reportRef: ref }));
    expect(out).toContain("Report this board");
    expect(out).toContain("mailto:contact@example.com");
    expect(out).toContain(ref);
    expect(out).not.toContain(SLUG);
    expect(decodeURIComponent(out)).toContain("do not attach or send illegal images");
  });

  it("falls back to the Terms contact section when no address is configured", () => {
    const out = renderToStaticMarkup(h(ReportBoardLink, { email: null, reportRef: boardReportRef(SLUG) }));
    expect(out).toContain('href="/terms#contact"');
    expect(out).toContain("Report this board");
    expect(out).not.toContain(SLUG);
  });

  it("renders nothing without a reference", () => {
    expect(renderToStaticMarkup(h(ReportBoardLink, { email: "contact@example.com", reportRef: null }))).toBe("");
    expect(renderToStaticMarkup(h(ReportBoardLink, {}))).toBe("");
  });
});
