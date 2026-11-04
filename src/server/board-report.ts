import "server-only";
/**
 * Report & hold service (PIN-270, ADR-004, docs/20): the request does
 * the work, like the demo sweep. A report body is validated, planned
 * by the pure decision table (`planReportHold`), applied to the
 * repository (reversible holds, never a delete) and to Storage
 * (temporary holds for `illegal`), recorded as a `reports/{id}` doc
 * with exactly what was held, and announced with one structured log
 * line carrying the opaque reference, never the slug or the message.
 */
import { randomUUID } from "node:crypto";
import { releaseRef, type Element, type Participant, type Scene } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import {
  parseReportInput,
  planHoldsSomething,
  planReportHold,
  type ReportHeld,
  type ReportInputError,
  type ReportRecord,
  type ReporterKind,
} from "../domain/board-report";
import type { ReportStore } from "../domain/report-store";
import { boardReportRef } from "../domain/tokens";
import { userMessage } from "../i18n/user-message";
import type { MessageKey } from "../i18n";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import type { DerivativeStore } from "./derivative-store";
import { logEvent, logServerError } from "./safe-log";

export interface ReportDeps {
  boards: BoardRepository;
  store: DerivativeStore;
  reports: ReportStore;
  policy: Policy;
  now?: () => number;
  newId?: () => string;
}

/** The 400 codes of `POST /api/boards/<slug>/report`. */
export const REPORT_CODES: Readonly<Record<ReportInputError, string>> = {
  invalid: "report_invalid",
  message_required: "report_message_required",
  message_too_long: "report_message_too_long",
  email_invalid: "report_email_invalid",
};

const REPORT_MESSAGE_KEYS: Readonly<Record<ReportInputError, MessageKey>> = {
  invalid: "request.reportInvalid",
  message_required: "request.reportMessageRequired",
  message_too_long: "request.reportMessageTooLong",
  email_invalid: "request.reportEmailInvalid",
};

export const REPORT_RECEIVED_EVENT = "report.received";

export interface CreateReportResult {
  record: ReportRecord;
  /** True when the report hid or locked anything (the receipt's wording). */
  held: boolean;
}

/**
 * Validate, plan, hold, record, announce. Throws BoardApiError 400
 * (typed code) on a bad body and the uniform 404 for an unknown board
 * or target (no existence leak for either).
 */
export async function createReport(
  slug: string,
  body: unknown,
  viewer: Participant | null,
  deps: ReportDeps,
): Promise<CreateReportResult> {
  const parsed = parseReportInput(body, { messageMaxChars: deps.policy.report.messageMaxChars });
  if (!parsed.ok) {
    const values = parsed.error === "message_too_long" ? { max: deps.policy.report.messageMaxChars } : undefined;
    throw new BoardApiError(userMessage(REPORT_MESSAGE_KEYS[parsed.error], values), 400, REPORT_CODES[parsed.error]);
  }
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Board not found.", 404);
  const input = parsed.input;
  const [elements, scenes] = await Promise.all([
    deps.boards.listElements(slug),
    deps.boards.listScenes(slug, { includeHidden: true }),
  ]);
  const now = deps.now?.() ?? Date.now();
  const reporterKind: ReporterKind = viewer && viewer.boardId === slug ? "participant" : "visitor";
  const planned = planReportHold({
    scope: input.scope,
    reason: input.reason,
    reporterKind,
    now,
    takedownHours: deps.policy.takedownHours,
    element: input.scope === "element" ? (elements.find((e) => e.id === input.targetId) ?? null) : undefined,
    scene: input.scope === "scene" ? (scenes.find((s) => s.id === input.targetId) ?? null) : undefined,
    boardElements: elements,
    boardScenes: scenes,
  });
  if (!planned.ok) throw new BoardApiError("Board not found.", 404);
  const plan = planned.plan;
  const held = await applyHold(slug, plan.held, elements, scenes, now, deps);
  const record: ReportRecord = {
    id: deps.newId?.() ?? randomUUID(),
    boardId: slug,
    reference: boardReportRef(slug),
    scope: input.scope,
    ...(input.targetId ? { targetId: input.targetId } : {}),
    reason: input.reason,
    ...(input.message ? { message: input.message } : {}),
    ...(input.reporterEmail ? { reporterEmail: input.reporterEmail } : {}),
    reporterKind,
    severity: plan.severity,
    createdAt: now,
    status: "open",
    ...(plan.deleteAt !== undefined ? { deleteAt: plan.deleteAt } : {}),
    held,
  };
  await deps.reports.create(record);
  logEvent(
    REPORT_RECEIVED_EVENT,
    {
      reference: record.reference,
      reason: record.reason,
      scope: record.scope,
      reportSeverity: record.severity,
      reporterKind,
      held: {
        elements: held.elementIds.length,
        scenes: held.sceneIds.length,
        board: held.boardReview,
        storage: held.storageHold,
      },
      ...(record.deleteAt !== undefined ? { deleteAt: record.deleteAt } : {}),
    },
    plan.severity === "high" ? "CRITICAL" : "WARNING",
  );
  return { record, held: planHoldsSomething(held) };
}

/**
 * Apply a plan and return what actually happened, so `dismiss` can
 * restore exactly that. Repository holds are atomic each; a Storage
 * hold that fails is logged by error name and recorded as not held
 * (the report still lands, the operator sees `storage: false`).
 */
async function applyHold(
  slug: string,
  planned: ReportHeld,
  elements: readonly Element[],
  scenes: readonly Scene[],
  now: number,
  deps: ReportDeps,
): Promise<ReportHeld> {
  const elementIds: string[] = [];
  const sceneIds = new Set<string>();
  for (const id of planned.elementIds) {
    const result = await deps.boards.holdElement(id);
    if (!result.held) continue;
    elementIds.push(id);
    for (const sceneId of result.hiddenSceneIds) sceneIds.add(sceneId);
  }
  for (const id of planned.sceneIds) {
    if (sceneIds.has(id)) continue;
    if (await deps.boards.hideScene(id)) sceneIds.add(id);
  }
  const boardReview = planned.boardReview ? await deps.boards.setBoardReview(slug, now) : false;
  let storageHold = false;
  if (planned.storageHold) {
    storageHold = true;
    const refs = new Set<string>();
    for (const element of elements) {
      refs.add(releaseRef(element.cutoutRef));
      refs.add(releaseRef(element.flattenedRef));
    }
    for (const scene of scenes) if (scene.imageRef) refs.add(scene.imageRef);
    for (const ref of refs) {
      try {
        await deps.store.setHold(ref, true);
      } catch (error) {
        storageHold = false;
        logServerError("report storage hold failed", error);
      }
    }
  }
  return { elementIds, sceneIds: [...sceneIds], boardReview, storageHold };
}
