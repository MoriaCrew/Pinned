import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  boardReportRef as scriptBoardReportRef,
  matchReportRef,
  parseFindArgs,
} from "../../scripts/find-report-ref.mjs";
import {
  NOTHING_HELD,
  parseReportInput,
  planHoldsSomething,
  planReportHold,
  reportBoardHref,
  type ReportPlanInput,
} from "./board-report";
import { boardReportRef, generateSlug } from "./tokens";

const SLUG = "AbCdEfGhIjKlMnOpQrStUv";
const LIMITS = { messageMaxChars: 20 };
const HOUR = 3_600_000;

describe("parseReportInput (PIN-268)", () => {
  it("accepts a narrow scope with a target and a board scope without one", () => {
    expect(parseReportInput({ scope: "element", targetId: "el-1", reason: "likeness" }, LIMITS)).toEqual({
      ok: true,
      input: { scope: "element", targetId: "el-1", reason: "likeness" },
    });
    expect(parseReportInput({ scope: "board", reason: "inappropriate", message: "  ", reporterEmail: "" }, LIMITS)).toEqual({
      ok: true,
      input: { scope: "board", reason: "inappropriate" },
    });
  });

  it("keeps a trimmed message and a valid email", () => {
    expect(
      parseReportInput(
        { scope: "scene", targetId: "sc-1", reason: "other", message: "  not ours  ", reporterEmail: " a@b.co " },
        LIMITS,
      ),
    ).toEqual({
      ok: true,
      input: { scope: "scene", targetId: "sc-1", reason: "other", message: "not ours", reporterEmail: "a@b.co" },
    });
  });

  it("rejects bad shapes, unknown values and a target on a board scope", () => {
    for (const bad of [
      null,
      "x",
      [],
      { scope: "board" },
      { reason: "likeness" },
      { scope: "pin", reason: "likeness" },
      { scope: "board", reason: "mistake" },
      { scope: "element", reason: "likeness" },
      { scope: "element", targetId: "../x", reason: "likeness" },
      { scope: "element", targetId: 7, reason: "likeness" },
      { scope: "board", targetId: "el-1", reason: "likeness" },
      { scope: "board", reason: "likeness", message: 3 },
      { scope: "board", reason: "likeness", reporterEmail: ["a@b.co"] },
    ]) {
      expect(parseReportInput(bad, LIMITS)).toEqual({ ok: false, error: "invalid" });
    }
  });

  it("requires a message for 'other', caps it in code points, and checks the email", () => {
    expect(parseReportInput({ scope: "board", reason: "other" }, LIMITS)).toEqual({ ok: false, error: "message_required" });
    expect(parseReportInput({ scope: "board", reason: "other", message: "   " }, LIMITS)).toEqual({ ok: false, error: "message_required" });
    const twentyOne = "é".repeat(21);
    expect(parseReportInput({ scope: "board", reason: "likeness", message: twentyOne }, LIMITS)).toEqual({ ok: false, error: "message_too_long" });
    expect(parseReportInput({ scope: "board", reason: "likeness", message: "é".repeat(20) }, LIMITS).ok).toBe(true);
    expect(parseReportInput({ scope: "board", reason: "likeness", reporterEmail: "nope" }, LIMITS)).toEqual({ ok: false, error: "email_invalid" });
    expect(parseReportInput({ scope: "board", reason: "likeness", reporterEmail: `${"a".repeat(250)}@b.co` }, LIMITS)).toEqual({ ok: false, error: "email_invalid" });
  });
});

describe("planReportHold (PIN-268, ADR-004 decision table)", () => {
  const scenes = [
    { id: "sc-a", hidden: false, elementIds: ["el-1", "el-2"] },
    { id: "sc-b", hidden: false, elementIds: ["el-2"] },
    { id: "sc-hidden", hidden: true, elementIds: ["el-1"] },
  ];
  const elements = [{ id: "el-1" }, { id: "el-2" }];
  const base: ReportPlanInput = {
    scope: "board",
    reason: "inappropriate",
    reporterKind: "visitor",
    now: 1_000,
    takedownHours: 24,
    boardElements: elements,
    boardScenes: scenes,
  };

  it("element: holds the element and the visible scenes using it, for anyone", () => {
    const result = planReportHold({ ...base, scope: "element", element: { id: "el-1", faceFlag: false } });
    expect(result).toEqual({
      ok: true,
      plan: {
        held: { elementIds: ["el-1"], sceneIds: ["sc-a"], boardReview: false, storageHold: false },
        severity: "normal",
        queuedOnly: false,
      },
    });
  });

  it("element + likeness + faceFlag: the one timed takedown, takedownHours from now", () => {
    const result = planReportHold({
      ...base,
      scope: "element",
      reason: "likeness",
      element: { id: "el-2", faceFlag: true },
    });
    expect(result.ok && result.plan.deleteAt).toBe(1_000 + 24 * HOUR);
    expect(result.ok && result.plan.held.sceneIds).toEqual(["sc-a", "sc-b"]);
  });

  it("no deadline without a face flag, with another reason, or ever for illegal", () => {
    for (const input of [
      { ...base, scope: "element" as const, reason: "likeness" as const, element: { id: "el-2", faceFlag: false } },
      { ...base, scope: "element" as const, reason: "inappropriate" as const, element: { id: "el-2", faceFlag: true } },
      { ...base, scope: "element" as const, reason: "illegal" as const, element: { id: "el-2", faceFlag: true } },
      { ...base, scope: "board" as const, reason: "illegal" as const },
    ]) {
      const result = planReportHold(input);
      expect(result.ok && "deleteAt" in result.plan).toBe(false);
    }
  });

  it("scene: hides that scene; an already hidden scene is queued only", () => {
    expect(planReportHold({ ...base, scope: "scene", scene: { id: "sc-b", hidden: false } })).toEqual({
      ok: true,
      plan: { held: { elementIds: [], sceneIds: ["sc-b"], boardReview: false, storageHold: false }, severity: "normal", queuedOnly: false },
    });
    const hidden = planReportHold({ ...base, scope: "scene", scene: { id: "sc-hidden", hidden: true } });
    expect(hidden.ok && hidden.plan.queuedOnly).toBe(true);
    expect(hidden.ok && planHoldsSomething(hidden.plan.held)).toBe(false);
  });

  it("a missing target is an error, never a board-wide hold", () => {
    expect(planReportHold({ ...base, scope: "element", element: null })).toEqual({ ok: false, error: "target_missing" });
    expect(planReportHold({ ...base, scope: "element" })).toEqual({ ok: false, error: "target_missing" });
    expect(planReportHold({ ...base, scope: "scene", scene: null })).toEqual({ ok: false, error: "target_missing" });
  });

  it("board + participant: every element and visible scene, board under review, no storage hold", () => {
    const result = planReportHold({ ...base, reporterKind: "participant" });
    expect(result).toEqual({
      ok: true,
      plan: {
        held: { elementIds: ["el-1", "el-2"], sceneIds: ["sc-a", "sc-b"], boardReview: true, storageHold: false },
        severity: "normal",
        queuedOnly: false,
      },
    });
  });

  it("board + illegal from anyone: the same plus a storage hold, severity high", () => {
    const result = planReportHold({ ...base, reason: "illegal" });
    expect(result.ok && result.plan).toEqual({
      held: { elementIds: ["el-1", "el-2"], sceneIds: ["sc-a", "sc-b"], boardReview: true, storageHold: true },
      severity: "high",
      queuedOnly: false,
    });
  });

  it("board + visitor + another reason: nothing hidden, queued only", () => {
    const result = planReportHold(base);
    expect(result).toEqual({ ok: true, plan: { held: { ...NOTHING_HELD }, severity: "normal", queuedOnly: true } });
    expect(result.ok && planHoldsSomething(result.plan.held)).toBe(false);
  });

  it("severity follows the reason alone, and illegal on a pin or a scene adds the Storage hold", () => {
    const high = planReportHold({ ...base, scope: "element", reason: "illegal", element: { id: "el-1", faceFlag: false } });
    expect(high.ok && high.plan.severity).toBe("high");
    expect(high.ok && high.plan.held).toEqual({ elementIds: ["el-1"], sceneIds: ["sc-a"], boardReview: false, storageHold: true });
    const normal = planReportHold({ ...base, scope: "element", reason: "ownership", element: { id: "el-1", faceFlag: false } });
    expect(normal.ok && normal.plan.severity).toBe("normal");
    expect(normal.ok && normal.plan.held.storageHold).toBe(false);
    const scene = planReportHold({ ...base, scope: "scene", reason: "illegal", scene: { id: "sc-b", hidden: false } });
    expect(scene.ok && scene.plan.held).toEqual({ elementIds: [], sceneIds: ["sc-b"], boardReview: false, storageHold: true });
    // An already hidden scene reported as illegal is still listed, so its folder gets the hold (never queued only).
    const hiddenIllegal = planReportHold({ ...base, scope: "scene", reason: "illegal", scene: { id: "sc-hidden", hidden: true } });
    expect(hiddenIllegal.ok && hiddenIllegal.plan).toEqual({ held: { elementIds: [], sceneIds: ["sc-hidden"], boardReview: false, storageHold: true }, severity: "high", queuedOnly: false });
  });
});

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
