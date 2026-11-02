import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  boardReportRef as scriptBoardReportRef,
  matchReportRef,
  parseFindArgs,
} from "../../scripts/find-report-ref.mjs";
import { reportBoardHref } from "./board-report";
import { boardReportRef, generateSlug } from "./tokens";

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

describe("scripts/find-report-ref.mjs (PIN-239 runbook lookup)", () => {
  const SCRIPT = path.resolve(__dirname, "../../scripts/find-report-ref.mjs");

  it("mirrors boardReportRef exactly", () => {
    const slugs = [SLUG, "ZyXwVuTsRqPoNmLkJiHgFe", "-_-_-_-_-_-_-_-_-_-_-_", ...Array.from({ length: 20 }, generateSlug)];
    for (const slug of slugs) expect(scriptBoardReportRef(slug)).toBe(boardReportRef(slug));
  });

  it("matches only the reported board", () => {
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    expect(matchReportRef([other, SLUG], boardReportRef(SLUG))).toEqual([SLUG]);
    expect(matchReportRef([other], boardReportRef(SLUG))).toEqual([]);
  });

  it("requires --project and a well-formed --ref", () => {
    const ref = boardReportRef(SLUG);
    expect(parseFindArgs(["--project", "p", "--ref", ref])).toEqual({ ok: true, project: "p", ref });
    expect(parseFindArgs(["--project", "p", "--ref", ref.toUpperCase()])).toEqual({ ok: true, project: "p", ref });
    expect(parseFindArgs(["--ref", ref]).ok).toBe(false);
    expect(parseFindArgs(["--project", "--ref", ref]).ok).toBe(false);
    expect(parseFindArgs(["--project", "p"]).ok).toBe(false);
    expect(parseFindArgs(["--project", "p", "--ref", ref.slice(1)]).ok).toBe(false);
    expect(parseFindArgs(["--project", "p", "--ref", SLUG]).ok).toBe(false);
  });

  it("exits 2 on usage errors before touching Firestore", () => {
    for (const args of [[], ["--ref", boardReportRef(SLUG)], ["--project", "p", "--ref", "not-a-ref"]]) {
      const run = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
      expect(run.status).toBe(2);
      expect(run.stderr).toContain("usage: node scripts/find-report-ref.mjs");
      expect(run.stdout).toBe("");
    }
  });
});
