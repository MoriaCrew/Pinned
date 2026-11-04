/**
 * Report & hold, the pure part (PIN-239 link, PIN-266 / PIN-268
 * automation; `docs/adr/004-report-and-hold.md`, docs/20).
 *
 * A report names a scope (one element, one scene or the whole
 * board), one reason and an optional message. `planReportHold`
 * turns it into a HoldPlan, the decision table of ADR-004: what to
 * hide right away (reversibly, never a delete), whether the board
 * goes under review, whether Storage gets a temporary hold, and
 * the one case that gets a deletion deadline (a face-flagged pin
 * reported as someone's likeness). The server applies the plan and
 * records what it actually held, so a dismiss can put it back.
 *
 * Client-safe: no I/O, no Policy import (the caller passes the two
 * numbers it needs). The report reference (`boardReportRef` in
 * tokens.ts) is the only board identifier that ever leaves the
 * server: alerts, receipts and operator tooling use it, never the
 * capability slug.
 */
import type { Element, Scene } from "./board";

export const REPORT_REASONS = ["likeness", "inappropriate", "illegal", "ownership", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export const REPORT_SCOPES = ["element", "scene", "board"] as const;
export type ReportScope = (typeof REPORT_SCOPES)[number];

export type ReporterKind = "participant" | "visitor";
export type ReportStatus = "open" | "dismissed" | "takedown";
export type ReportSeverity = "normal" | "high";

/** What a report hid or locked; exactly what `dismiss` restores. */
export interface ReportHeld {
  elementIds: string[];
  sceneIds: string[];
  boardReview: boolean;
  storageHold: boolean;
}

export const NOTHING_HELD: Readonly<ReportHeld> = Object.freeze({
  elementIds: [],
  sceneIds: [],
  boardReview: false,
  storageHold: false,
});

/** One stored report (`reports/{id}`; the slug lives only here, server-side). */
export interface ReportRecord {
  id: string;
  boardId: string;
  /** `boardReportRef(boardId)`: the opaque id shown to people and in alerts. */
  reference: string;
  scope: ReportScope;
  /** Element or scene id for a narrow scope; absent for the board. */
  targetId?: string;
  reason: ReportReason;
  /** The reporter's free text (Policy `report.messageMaxChars`); stored, never logged. */
  message?: string;
  reporterEmail?: string;
  reporterKind: ReporterKind;
  severity: ReportSeverity;
  createdAt: number;
  status: ReportStatus;
  /** Timed takedown deadline (face-flagged likeness only); absent otherwise. */
  deleteAt?: number;
  held: ReportHeld;
  decidedAt?: number;
  /** Operator note on the decision; never a slug. */
  note?: string;
}

export type ReportInputError = "invalid" | "message_required" | "message_too_long" | "email_invalid";

/** The validated body of `POST /api/boards/<slug>/report`. */
export interface ReportInput {
  scope: ReportScope;
  targetId?: string;
  reason: ReportReason;
  message?: string;
  reporterEmail?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_CHARS = 254;
const TARGET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Shape and size checks for the report body. A narrow scope needs a
 * target id; `other` needs a message; the message is capped in code
 * points by `messageMaxChars` (Policy); the email, when given, must
 * look like one. Blank strings count as absent.
 */
export function parseReportInput(
  value: unknown,
  limits: { messageMaxChars: number },
): { ok: true; input: ReportInput } | { ok: false; error: ReportInputError } {
  if (!isRecord(value)) return { ok: false, error: "invalid" };
  const scope = value.scope;
  const reason = value.reason;
  if (!REPORT_SCOPES.includes(scope as ReportScope)) return { ok: false, error: "invalid" };
  if (!REPORT_REASONS.includes(reason as ReportReason)) return { ok: false, error: "invalid" };
  const targetRaw = value.targetId;
  let targetId: string | undefined;
  if (scope !== "board") {
    if (typeof targetRaw !== "string" || !TARGET_ID_PATTERN.test(targetRaw)) {
      return { ok: false, error: "invalid" };
    }
    targetId = targetRaw;
  } else if (targetRaw !== undefined && targetRaw !== null) {
    return { ok: false, error: "invalid" };
  }
  const messageRaw = value.message;
  if (messageRaw !== undefined && messageRaw !== null && typeof messageRaw !== "string") {
    return { ok: false, error: "invalid" };
  }
  const message = typeof messageRaw === "string" ? messageRaw.trim() : "";
  if (reason === "other" && message.length === 0) return { ok: false, error: "message_required" };
  if ([...message].length > limits.messageMaxChars) return { ok: false, error: "message_too_long" };
  const emailRaw = value.reporterEmail;
  if (emailRaw !== undefined && emailRaw !== null && typeof emailRaw !== "string") {
    return { ok: false, error: "invalid" };
  }
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";
  if (email.length > 0 && (email.length > EMAIL_MAX_CHARS || !EMAIL_PATTERN.test(email))) {
    return { ok: false, error: "email_invalid" };
  }
  return {
    ok: true,
    input: {
      scope: scope as ReportScope,
      ...(targetId ? { targetId } : {}),
      reason: reason as ReportReason,
      ...(message ? { message } : {}),
      ...(email ? { reporterEmail: email } : {}),
    },
  };
}

export interface ReportPlanInput {
  scope: ReportScope;
  reason: ReportReason;
  reporterKind: ReporterKind;
  now: number;
  /** Policy `takedownHours`: the deadline of the one timed takedown. */
  takedownHours: number;
  /** The element an element-scope report names; null when the id matched nothing. */
  element?: Pick<Element, "id" | "faceFlag"> | null;
  /** The scene a scene-scope report names; null when the id matched nothing. */
  scene?: Pick<Scene, "id" | "hidden"> | null;
  /** The board's elements and scenes (hidden ones included), for a board-scope hold and for the scenes an element hold will hide. */
  boardElements?: Pick<Element, "id">[];
  boardScenes?: Pick<Scene, "id" | "hidden" | "elementIds">[];
}

export interface HoldPlan {
  held: ReportHeld;
  severity: ReportSeverity;
  /** Set only for a face-flagged pin reported as a likeness. */
  deleteAt?: number;
  /** True when nothing is hidden: the report is queued and alerted only. */
  queuedOnly: boolean;
}

export type PlanResult = { ok: true; plan: HoldPlan } | { ok: false; error: "target_missing" };

const HOUR_MS = 3_600_000;

/**
 * The ADR-004 decision table. Pure: hides and locks only, never
 * deletes; the one deadline it sets is acted on later by the
 * backstop, and never for `illegal`.
 */
export function planReportHold(input: ReportPlanInput): PlanResult {
  const severity: ReportSeverity = input.reason === "illegal" ? "high" : "normal";
  const scenes = input.boardScenes ?? [];
  const visibleScenes = scenes.filter((scene) => !scene.hidden);

  if (input.scope === "element") {
    const element = input.element;
    if (!element) return { ok: false, error: "target_missing" };
    const sceneIds = visibleScenes
      .filter((scene) => scene.elementIds.includes(element.id))
      .map((scene) => scene.id);
    const timed = input.reason === "likeness" && element.faceFlag === true;
    return {
      ok: true,
      plan: {
        held: { elementIds: [element.id], sceneIds, boardReview: false, storageHold: false },
        severity,
        ...(timed ? { deleteAt: input.now + input.takedownHours * HOUR_MS } : {}),
        queuedOnly: false,
      },
    };
  }

  if (input.scope === "scene") {
    const scene = input.scene;
    if (!scene) return { ok: false, error: "target_missing" };
    const sceneIds = scene.hidden ? [] : [scene.id];
    return {
      ok: true,
      plan: {
        held: { elementIds: [], sceneIds, boardReview: false, storageHold: false },
        severity,
        queuedOnly: sceneIds.length === 0,
      },
    };
  }

  // Whole board: a participant's word, or an illegal-content report
  // from anyone, holds the board. An anonymous visitor's other
  // reports are queued: anyone with the link can join and report,
  // so one click must not blank a friend group's board.
  const holds = input.reporterKind === "participant" || input.reason === "illegal";
  if (!holds) {
    return { ok: true, plan: { held: { ...NOTHING_HELD }, severity, queuedOnly: true } };
  }
  return {
    ok: true,
    plan: {
      held: {
        elementIds: (input.boardElements ?? []).map((element) => element.id),
        sceneIds: visibleScenes.map((scene) => scene.id),
        boardReview: true,
        storageHold: input.reason === "illegal",
      },
      severity,
      queuedOnly: false,
    },
  };
}

/** True when a plan hid or locked anything. */
export function planHoldsSomething(held: ReportHeld): boolean {
  return held.elementIds.length > 0 || held.sceneIds.length > 0 || held.boardReview || held.storageHold;
}

/**
 * Report-this-board link (PIN-239), kept until the sheet of PIN-271
 * replaces it: a `mailto:` to the legal contact whose subject/body
 * carry only the opaque report reference, never the slug.
 */
export function reportBoardHref(
  email: string | null | undefined,
  reportRef: string | null | undefined,
  subject: string,
  body: string,
): string | null {
  if (!email || !reportRef) return null;
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${email}?${query}`;
}
