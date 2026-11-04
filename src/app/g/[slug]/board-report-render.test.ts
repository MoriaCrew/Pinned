import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { boardReportRef } from "../../../domain/tokens";
import { ReportBoard, ReportForm, ReportReceipt, canSendReport, scopeFields, type ReportTargets } from "./ReportBoard";

// The components read the language with a hook; mock it like add-pick.test.ts.
vi.mock("../../../i18n/client", () => ({ useLocale: () => "en" }));

const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const targets: ReportTargets = {
  pins: [{ id: "el-1", label: "teal mug" }, { id: "el-2", label: "a friend" }],
  scenes: [{ id: "sc-9", index: 1 }],
};
const noop = () => {};
const formProps = {
  targets,
  scopeKey: "board" as const,
  reason: null,
  message: "",
  email: "",
  messageMaxChars: 1000,
  sending: false,
  error: null,
  onScope: noop,
  onReason: noop,
  onMessage: noop,
  onEmail: noop,
  messageId: "m",
};

describe("report foot (PIN-271)", () => {
  it("opens a sheet instead of a mail: a button, the address and the reference as text, never the slug", () => {
    const ref = boardReportRef(SLUG);
    const out = renderToStaticMarkup(
      h(ReportBoard, { slug: SLUG, email: "contact@example.com", reportRef: ref, targets, messageMaxChars: 1000, takedownHours: 24 }),
    );
    expect(out).toContain("Report this board");
    expect(out).toContain('aria-haspopup="dialog"');
    expect(out).not.toContain("mailto:");
    expect(out).toContain("<dt>Email</dt><dd>contact@example.com</dd>");
    expect(out).toContain(`<dt>Board reference</dt><dd>${ref}</dd>`);
    expect(out).not.toContain(SLUG);
    // Closed: no sheet in the markup.
    expect(out).not.toContain("pn-report-sheet");
  });

  it("renders nothing without a reference, and no address line without an address", () => {
    expect(renderToStaticMarkup(h(ReportBoard, { slug: SLUG, email: "c@e.co", reportRef: null, targets, messageMaxChars: 1000, takedownHours: 24 }))).toBe("");
    const out = renderToStaticMarkup(h(ReportBoard, { slug: SLUG, email: null, reportRef: boardReportRef(SLUG), targets, messageMaxChars: 1000, takedownHours: 24 }));
    expect(out).not.toContain("<dt>Email</dt>");
    expect(out).toContain("<dt>Board reference</dt>");
  });
});

describe("report form (PIN-271)", () => {
  it("offers the board, every pin by label and every scene by number, and the five reasons", () => {
    const out = renderToStaticMarkup(h(ReportForm, formProps));
    for (const label of ["This board", "teal mug", "a friend", "Scene 1"]) expect(out).toContain(label);
    for (const reason of [
      "That&#x27;s me, or someone who didn&#x27;t agree",
      "Inappropriate",
      "Illegal, or involves a minor",
      "Not theirs to share",
      "Something else",
    ]) {
      expect(out).toContain(reason);
    }
    expect(out).toContain("What should we look at?");
    expect(out).toContain("Your email (optional)");
    expect(out).toContain('aria-pressed="true"'); // "This board" starts selected
    expect(out).not.toContain(SLUG);
  });

  it("marks the chosen scope and reason, shows a server line, and caps the message from Policy", () => {
    const out = renderToStaticMarkup(
      h(ReportForm, { ...formProps, scopeKey: "element:el-2", reason: "likeness", error: "Keep your message under 40 characters.", messageMaxChars: 40 }),
    );
    expect((out.match(/aria-pressed="true"/g) ?? []).length).toBe(2);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Keep your message under 40 characters.");
    // The count follows Policy (code points); the server enforces the cap.
    expect(out).toContain("0/40");
  });

  it("canSendReport needs a reason, and a message for 'other'", () => {
    expect(canSendReport(null, "x")).toBe(false);
    expect(canSendReport("likeness", "")).toBe(true);
    expect(canSendReport("other", "   ")).toBe(false);
    expect(canSendReport("other", "the host is a bot")).toBe(true);
  });

  it("scopeFields maps a chip to the request body", () => {
    expect(scopeFields("board")).toEqual({ scope: "board" });
    expect(scopeFields("element:el-1")).toEqual({ scope: "element", targetId: "el-1" });
    expect(scopeFields("scene:sc-9")).toEqual({ scope: "scene", targetId: "sc-9" });
  });
});

describe("report receipt (PIN-271)", () => {
  it("says what happened and shows the reference and the follow-up address", () => {
    const ref = boardReportRef(SLUG);
    const held = renderToStaticMarkup(h(ReportReceipt, { result: { reference: ref, held: true }, email: "contact@example.com", takedownHours: 24 }));
    expect(held).toContain(`Hidden now and removed in 24 hours unless we clear it. Your reference: ${ref}`);
    expect(held).toContain("contact@example.com");
    expect(held).not.toContain(SLUG);
    const received = renderToStaticMarkup(h(ReportReceipt, { result: { reference: ref, held: false }, email: null, takedownHours: 24 }));
    expect(received).toContain(`Received. We&#x27;ll take a look. Your reference: ${ref}`);
    expect(received).not.toContain("Questions about a report?");
  });
});
