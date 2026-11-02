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

  it("shows the address and the reference as plain text for browsers without a mail app", () => {
    const ref = boardReportRef(SLUG);
    const out = renderToStaticMarkup(h(ReportBoardLink, { email: "contact@example.com", reportRef: ref }));
    const text = out.replace(/<a [^>]*>/g, "<a>"); // drop the mailto href: what is left is visible text
    expect(text).toContain("No mail app? Write to this address and include the board reference.");
    expect(text).toContain("<dt>Email</dt><dd>contact@example.com</dd>");
    expect(text).toContain(`<dt>Board reference</dt><dd>${ref}</dd>`);
    expect(out).not.toContain(SLUG);
  });

  it("falls back to the Terms contact section when no address is configured", () => {
    const ref = boardReportRef(SLUG);
    const out = renderToStaticMarkup(h(ReportBoardLink, { email: null, reportRef: ref }));
    expect(out).toContain('href="/terms#contact"');
    expect(out).toContain("Report this board");
    // The reference still shows, to quote in whatever contact the Terms give; no address line.
    expect(out).toContain(`<dt>Board reference</dt><dd>${ref}</dd>`);
    expect(out).not.toContain("<dt>Email</dt>");
    expect(out).not.toContain("No mail app?");
    expect(out).not.toContain(SLUG);
  });

  it("renders nothing without a reference", () => {
    expect(renderToStaticMarkup(h(ReportBoardLink, { email: "contact@example.com", reportRef: null }))).toBe("");
    expect(renderToStaticMarkup(h(ReportBoardLink, {}))).toBe("");
  });
});
