import "server-only";
/**
 * Boards API service (PIN-65, docs/11 sections 5.3-5.5 + A6a).
 * Route handlers under src/app/api/boards stay thin: slug
 * validation first (404), session/rate-limit plumbing, then these
 * functions. Everything user-visible that could leak board or
 * element existence collapses to one 404 (resolveElementImage and
 * the job lookups return null for every kind of miss).
 *
 * A6a working-copy lifecycle: the stripped `tmp/` derivative is
 * deleted when the uploader confirms pins ("Pin selected"), and
 * an opportunistic per-board sweep deletes anything past
 * Policy.workingCopyTtlHours. Originals are never persisted
 * (photo-intake, PIN-64). The bucket 1-day lifecycle backstop is
 * an operator step; until it lands no copy may claim 24h deletion.
 */
import { emptyBoardCounters, type Board, type DecomposeJob, type Element, type Participant, type Pin, type Scene, type SceneJob } from "../domain/board";
import { activityLines } from "../domain/board-activity";
import type { BoardRepository } from "../domain/board-repository";
import { getBoardTheme, isBoardThemeId } from "../domain/board-themes";
import { isPlusSkin, plusView, type PlusMode } from "../domain/plus";
import { validSceneSize } from "../domain/scene-ratio";
import { generateSlug } from "../domain/tokens";
import type { ChipSuggester, ElementNamer, SceneComposer, Segmenter, TapNamer } from "../gateway/ports";
import type { Policy } from "../policy/policy";
import { BoardApiError, publicParticipant } from "./board-session";
import { plusRequiredError } from "./board-plus";
import { issueHostCredential, verifyHostToken } from "./host-session";
import { t } from "../i18n";
import {
  addTapElement,
  startDecomposeJob,
  type DecomposeJobStore,
  type TapPoint,
} from "./decompose-job";
import type { DerivativeStore } from "./derivative-store";
import {
  SceneJobRequestError,
  startSceneJob,
  type SceneJobStore,
} from "./scene-job";
import { InMemoryChipsCacheStore, type ChipsCacheStore } from "./chips-cache";
import { resolveSceneChips, type SceneChipsResult } from "./scene-chips";

export interface BoardApiDeps {
  boards: BoardRepository;
  jobs: DecomposeJobStore;
  store: DerivativeStore;
  namer: ElementNamer;
  segmenter: Segmenter;
  /** Scene slice (PIN-69); scene functions 503 cleanly without them. */
  sceneJobs?: SceneJobStore;
  composer?: SceneComposer;
  /** Generated chips (PIN-75); absent port/cache = fixed-list fallback. */
  chipSuggester?: ChipSuggester;
  /** Tap naming (PIN-117); absent port = generic-label fallback. */
  tapNamer?: TapNamer;
  chipsCache?: ChipsCacheStore;
  /** AI_MOCK=1 (PIN-71): scenes are sharp collages, kind "collage". */
  collageMode?: boolean;
  policy: Policy;
  /** PLUS_MODE (PIN-103): Plus offer in the view + which grants count. Default "off". */
  plusMode?: PlusMode;
  now?: () => number;
  createSlug?: () => string;
  newId?: () => string;
  /** Host token source (PIN-103); default generateAdminToken. */
  newHostToken?: () => string;
}

/** Element image route URL (board-link-checked; never a raw ref). */
export function elementImageUrl(slug: string, elementId: string, kind: string): string {
  return `/api/boards/${encodeURIComponent(slug)}/elements/${encodeURIComponent(elementId)}/image?kind=${kind}`;
}

/** Scene image route URL (board-link-checked; never a raw ref). */
export function sceneImageUrl(slug: string, sceneId: string): string {
  return `/api/boards/${encodeURIComponent(slug)}/scenes/${encodeURIComponent(sceneId)}/image`;
}

export function publicScene(slug: string, scene: Scene) {
  return {
    id: scene.id,
    boardId: scene.boardId,
    createdBy: scene.createdBy,
    elementIds: scene.elementIds,
    prompt: scene.prompt,
    status: scene.status,
    // Pre-PIN-71 scenes are all AI composes; collages say so.
    kind: scene.kind ?? "ai",
    promptVersion: scene.promptVersion,
    ...(scene.parentSceneId ? { parentSceneId: scene.parentSceneId } : {}),
    ...(scene.refusalReason ? { refusalReason: scene.refusalReason } : {}),
    // Stored pixel size (PIN-129): the print frame takes this shape.
    ...(validSceneSize(scene) ?? {}),
    imageUrl:
      scene.status === "ready" && scene.imageRef
        ? sceneImageUrl(slug, scene.id)
        : null,
    createdAt: scene.createdAt,
  };
}

export function publicSceneJob(job: SceneJob) {
  return {
    id: job.id,
    sceneId: job.id,
    boardId: job.boardId,
    status: job.status,
    elementIds: job.elementIds,
    prompt: job.prompt,
    kind: job.kind ?? "ai",
    ...(job.parentSceneId ? { parentSceneId: job.parentSceneId } : {}),
    promptVersion: job.promptVersion,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    ...(job.refusalReason ? { refusalReason: job.refusalReason } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function publicBoard(board: Board) {
  const theme = getBoardTheme(board.themeId);
  return {
    slug: board.slug,
    title: board.title,
    themeId: board.themeId ?? null,
    theme: theme
      ? { id: theme.id, label: theme.label, motif: theme.motif, image: theme.image, tokens: theme.tokens }
      : board.theme ?? null,
    counters: board.counters,
    createdAt: board.createdAt,
  };
}

export function publicElement(slug: string, element: Element) {
  return {
    id: element.id,
    boardId: element.boardId,
    ownerId: element.ownerId,
    label: element.label,
    description: element.description,
    maskBox: element.maskBox,
    faceFlag: element.faceFlag,
    createdAt: element.createdAt,
    imageUrl: elementImageUrl(slug, element.id, "cutout"),
    flattenedUrl: elementImageUrl(slug, element.id, "flattened"),
  };
}

export function publicPin(pin: Pin) {
  return {
    id: pin.id,
    boardId: pin.boardId,
    elementId: pin.elementId,
    pinnedBy: pin.pinnedBy,
    status: pin.status,
    createdAt: pin.createdAt,
  };
}

/**
 * The photo job a viewer's own candidate pin came from (PIN-122),
 * so the board can offer "Pin them" / "Clear" for leftovers. The
 * DecomposeJob stores its id on every element it cuts
 * (Element.sourcePhotoId, concept and tap-add alike), so no extra
 * read and no new stored field. Undefined for pinned pins and for
 * anyone else's pin: only the uploader ever sees a candidate, and
 * nobody needs the job of a pinned thing.
 */
export function ownCandidateJobId(
  pin: Pin,
  viewer: Participant | null,
  elementsById: ReadonlyMap<string, Element>,
): string | undefined {
  if (pin.status !== "candidate" || viewer === null || pin.pinnedBy !== viewer.id) return undefined;
  const element = elementsById.get(pin.elementId);
  if (!element || element.boardId !== pin.boardId) return undefined;
  return element.sourcePhotoId || undefined;
}

export function publicJob(job: DecomposeJob) {
  return {
    id: job.id,
    boardId: job.boardId,
    status: job.status,
    faceNote: job.faceNote,
    failedConceptCount: job.failedConceptCount,
    // Tap-to-add window (PIN-78): the Add sheet hides the tap
    // surface once the A6a working copy is deleted (confirm/TTL).
    workingCopyGone: job.workingDeletedAt !== undefined,
    elementIds: job.elementIds,
    pinIds: job.pinIds,
    ...(job.errorCode ? { errorCode: job.errorCode } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export interface CreateBoardInput {
  title: string;
  themeId?: string;
}

export function parseCreateBoardInput(value: unknown, policy: Policy): CreateBoardInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Give your board a title.");
  }
  const body = value as Record<string, unknown>;
  const rawTitle = typeof body.title === "string" ? body.title : "";
  const title = rawTitle.trim().replace(/\s+/g, " ");
  if (!title || [...title].length > policy.boardTitleMaxChars || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new BoardApiError(`Give your board a title up to ${policy.boardTitleMaxChars} characters.`);
  }
  let themeId: string | undefined;
  if (body.themeId !== undefined && body.themeId !== null && body.themeId !== "") {
    if (!isBoardThemeId(body.themeId)) {
      throw new BoardApiError("That theme is not available.");
    }
    // PIN-103: a new board holds no entitlement, so a Plus skin
    // here would bypass the skin gate; the host buys Plus first.
    if (isPlusSkin(body.themeId)) throw plusRequiredError();
    themeId = body.themeId;
  }
  return { title, ...(themeId ? { themeId } : {}) };
}

const MAX_SLUG_ATTEMPTS = 5;

export interface CreatedBoard {
  board: Board;
  /** Raw host token for the creator's cookie; only its hash is stored. */
  hostToken: string;
}

/**
 * Create a board with its host credential (PIN-103) in the same
 * initial write: the Board stores the token hash + issue time,
 * the caller gets the raw token once, for the creator's cookie.
 */
export async function createBoardWithHost(
  rawInput: unknown,
  deps: BoardApiDeps,
): Promise<CreatedBoard> {
  const input = parseCreateBoardInput(rawInput, deps.policy);
  const now = deps.now?.() ?? Date.now();
  const theme = getBoardTheme(input.themeId);
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const credential = issueHostCredential(now, deps.newHostToken);
    const board: Board = {
      slug: deps.createSlug?.() ?? generateSlug(),
      title: input.title,
      ...(input.themeId ? { themeId: input.themeId } : {}),
      ...(theme ? { theme: theme.tokens } : {}),
      host: credential.record,
      counters: emptyBoardCounters(),
      createdAt: now,
      version: 1,
    };
    try {
      await deps.boards.createBoard(board);
      return { board, hostToken: credential.token };
    } catch (error) {
      if (error instanceof RangeError && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new BoardApiError("Could not create a board. Please try again.", 503);
}

/** createBoardWithHost for callers that do not hand out the host cookie. */
export async function createBoard(rawInput: unknown, deps: BoardApiDeps): Promise<Board> {
  return (await createBoardWithHost(rawInput, deps)).board;
}

/** Per-request facts the board view needs beyond the participant (PIN-103). */
export interface BoardViewAccess {
  /**
   * The request's host token (shape-checked, from the Path-scoped
   * host cookie). Absent = not host: the server-rendered board
   * page never sees that cookie, so its first view says
   * isHost:false and the client's first poll of the board view
   * API (under the cookie path) corrects it.
   */
  hostToken?: string | null;
}

/**
 * Board view for the polling board page: pinned pins are public to
 * anyone holding the link; candidate pins only to their uploader.
 * Returns null when the board does not exist. PIN-103 adds, purely
 * additively, `viewer.isHost` (host token verified against the
 * stored hash + age) and `plus` (entitlement state under
 * deps.plusMode, mode, Policy price labels — no billing source,
 * time or secret; the host hash never leaves the server). PIN-122:
 * the viewer's own candidate pins carry `jobId` (ownCandidateJobId).
 */
export async function getBoardView(
  slug: string,
  viewer: Participant | null,
  deps: BoardApiDeps,
  access: BoardViewAccess = {},
) {
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const [participants, allPins, elements, scenes, events] = await Promise.all([
    deps.boards.listParticipants(slug),
    deps.boards.listPins(slug),
    deps.boards.listElements(slug),
    deps.boards.listScenes(slug),
    deps.boards.listEvents(slug),
  ]);
  const pins = allPins.filter(
    (pin) => pin.status === "pinned" || (viewer !== null && pin.pinnedBy === viewer.id),
  );
  const visibleElementIds = new Set(pins.map((pin) => pin.elementId));
  const elementsById = new Map(elements.map((element) => [element.id, element]));
  return {
    board: publicBoard(board),
    me: viewer ? publicParticipant(viewer) : null,
    participants: participants.map(publicParticipant),
    pins: pins.map((pin) => {
      const jobId = ownCandidateJobId(pin, viewer, elementsById);
      return jobId ? { ...publicPin(pin), jobId } : publicPin(pin);
    }),
    elements: elements
      .filter((element) => visibleElementIds.has(element.id))
      .map((element) => publicElement(slug, element)),
    scenes: scenes.map((scene) => publicScene(slug, scene)),
    // Activity strip (PIN-74): board-visible BoardEvent lines,
    // latest Policy.activityStripMax, names/labels resolved here.
    activity: activityLines(events, participants, elements, deps.policy.activityStripMax),
    viewer: {
      isHost: verifyHostToken(board, access.hostToken ?? null, deps.policy, deps.now?.() ?? Date.now()),
    },
    plus: plusView(board, {
      mode: deps.plusMode ?? "off",
      priceLabels: deps.policy.plus.priceLabels,
    }),
  };
}

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * A6a TTL half: delete working copies older than
 * Policy.workingCopyTtlHours on one board. Returns deletes made.
 * Called opportunistically on upload/confirm (no cron in slices
 * 1-2); also exported for a future scheduled sweeper.
 */
export async function sweepExpiredWorkingCopies(
  boardId: string,
  deps: BoardApiDeps,
): Promise<number> {
  const now = deps.now?.() ?? Date.now();
  const ttlMs = deps.policy.workingCopyTtlHours * 60 * 60 * 1000;
  const jobs = await deps.jobs.listForBoard(boardId);
  let deleted = 0;
  for (const job of jobs) {
    if (job.workingDeletedAt !== undefined) continue;
    if (now - job.createdAt < ttlMs) continue;
    await deps.store.delete(job.workingRef);
    await deps.jobs.update({ ...job, workingDeletedAt: now, updatedAt: now });
    deleted += 1;
  }
  return deleted;
}

/**
 * Delete the A6a working copy and mark the job. The mark is
 * always written on top of the FRESHEST job read (before and
 * after the store delete), never the caller's snapshot, so a
 * tap-add (PIN-78) that appended ids meanwhile is not clobbered
 * by this whole-job replace (Bugbot PIN-78 finding).
 */
async function deleteWorkingCopy(job: DecomposeJob, deps: BoardApiDeps): Promise<DecomposeJob> {
  const fresh = (await deps.jobs.get(job.id)) ?? job;
  if (fresh.workingDeletedAt !== undefined) return fresh;
  job = fresh;
  const now = deps.now?.() ?? Date.now();
  await deps.store.delete(job.workingRef);
  const latest = (await deps.jobs.get(job.id)) ?? job;
  if (latest.workingDeletedAt !== undefined) return latest;
  const updated: DecomposeJob = { ...latest, workingDeletedAt: now, updatedAt: now };
  await deps.jobs.update(updated);
  return updated;
}

/**
 * Upload one photo and run its DecomposeJob in-request (A4: the
 * request does the work; the client also polls the job route for
 * pop-in/retry). Enforces Policy.photosPerParticipantPerDay at the
 * API edge (the PIN-61 budget decorator enforces the same cap at
 * the namer port as a second line). PhotoIntakeError propagates.
 */
export async function uploadPhoto(
  slug: string,
  participant: Participant,
  bytes: Uint8Array,
  deps: BoardApiDeps,
): Promise<DecomposeJob> {
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Board not found.", 404);

  const now = deps.now?.() ?? Date.now();
  const todaysJobs = (await deps.jobs.listForBoard(slug)).filter(
    (job) => job.participantId === participant.id && job.createdAt >= startOfUtcDay(now),
  );
  if (todaysJobs.length >= deps.policy.photosPerParticipantPerDay) {
    throw new BoardApiError("Daily photo limit reached for this board.", 429, "photos_per_day");
  }

  // Opportunistic A6a sweep; never blocks the upload itself.
  await sweepExpiredWorkingCopies(slug, deps).catch(() => undefined);

  return startDecomposeJob(
    { boardId: slug, participantId: participant.id, bytes },
    {
      boards: deps.boards,
      jobs: deps.jobs,
      store: deps.store,
      namer: deps.namer,
      segmenter: deps.segmenter,
      policy: deps.policy,
      now: deps.now,
      newId: deps.newId,
    },
  );
}

/**
 * Job poll view, uploader-only (candidate pins are private until
 * confirmed). Null for a missing job, a job on another board, or
 * any viewer who is not the uploader — one uniform 404 at the
 * route, no existence leak. Candidate pins/elements ride along
 * so the Add sheet can pop in.
 */
export async function getJobView(
  slug: string,
  jobId: string,
  viewer: Participant | null,
  deps: BoardApiDeps,
) {
  if (!viewer) return null;
  const job = await deps.jobs.get(jobId);
  if (!job || job.boardId !== slug || job.participantId !== viewer.id) return null;
  const pins: Pin[] = [];
  const elements: Element[] = [];
  for (const pinId of job.pinIds) {
    const pin = await deps.boards.getPin(pinId);
    if (pin) pins.push(pin);
  }
  for (const elementId of job.elementIds) {
    const element = await deps.boards.getElement(elementId);
    if (element) elements.push(element);
  }
  return {
    job: publicJob(job),
    pins: pins.map(publicPin),
    elements: elements.map((element) => publicElement(slug, element)),
  };
}

export function parseTapAddInput(value: unknown): TapPoint {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Tap a spot in the photo.");
  }
  const body = value as Record<string, unknown>;
  const { x, y } = body;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new BoardApiError("Tap a spot in the photo.");
  }
  return { x, y };
}

/**
 * Tap-to-add (PIN-78): uploader-only, like the job poll and
 * confirm — a missing job, another board's job, a non-uploader
 * and no participant at all are the same 404 (no existence
 * leak). PIN-117 names the crop via TapNamer; the i18n label
 * (add.tapLabel) is only the typed fallback. The service
 * enforces the working-copy lifetime, the usable-mask
 * gate and elementsPerPhoto.max. Typed service outcomes map to
 * friendly lines — an expired/deleted working copy is a 409
 * the sheet shows as "photo copy gone", never a 500.
 */
export async function tapAddPin(
  slug: string,
  participant: Participant | null,
  jobId: string,
  rawInput: unknown,
  deps: BoardApiDeps,
) {
  if (!participant) throw new BoardApiError("Job not found.", 404);
  const point = parseTapAddInput(rawInput);
  const job = await deps.jobs.get(jobId);
  if (!job || job.boardId !== slug || job.participantId !== participant.id) {
    throw new BoardApiError("Job not found.", 404);
  }
  const outcome = await addTapElement(jobId, point, t("en", "add.tapLabel"), {
    userIdAtCall: participant.userId ?? null,
    ...(deps.tapNamer ? { tapNamer: deps.tapNamer } : {}),
    boards: deps.boards,
    jobs: deps.jobs,
    store: deps.store,
    namer: deps.namer,
    segmenter: deps.segmenter,
    policy: deps.policy,
    now: deps.now,
    newId: deps.newId,
  });
  switch (outcome.status) {
    case "ready":
      return {
        job: publicJob(outcome.job),
        pin: publicPin(outcome.pin),
        element: publicElement(slug, outcome.element),
      };
    case "not_found":
      throw new BoardApiError("Job not found.", 404);
    case "working_copy_gone":
      throw new BoardApiError(t("en", "add.tapGone"), 409, "working_copy_gone");
    case "cap_reached":
      throw new BoardApiError(t("en", "add.tapCap"), 409, "elements_per_photo_max");
    case "job_not_ready":
      throw new BoardApiError(t("en", "add.finding"), 409, "job_not_ready");
    case "no_usable_mask":
      throw new BoardApiError(t("en", "add.tapNone"), 400, "no_usable_mask");
    case "refused":
      throw new BoardApiError(t("en", "add.refused"), 400, "refused");
    case "failed":
      throw new BoardApiError(t("en", "add.failed"), 503, outcome.errorCode ?? "tap_add_failed");
  }
}

export interface ConfirmPinsInput {
  jobId: string;
  pinIds: string[];
}

/**
 * An empty `pinIds` is allowed (PIN-122 "Clear"): it keeps none, so
 * every candidate of the job is dropped and the working copy is
 * deleted, exactly like dropping each one in the review.
 */
export function parseConfirmPinsInput(value: unknown, policy: Policy): ConfirmPinsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Choose which pins to keep.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.jobId !== "string" || !body.jobId) {
    throw new BoardApiError("Choose which pins to keep.");
  }
  if (!Array.isArray(body.pinIds) || body.pinIds.some((id) => typeof id !== "string" || !id)) {
    throw new BoardApiError("Choose which pins to keep.");
  }
  const pinIds = [...new Set(body.pinIds as string[])];
  if (pinIds.length > policy.elementsPerPhoto.max) {
    throw new BoardApiError("Too many pins for one photo.");
  }
  return { jobId: body.jobId, pinIds };
}

/**
 * "Pin N ->": selected candidate pins become pinned, the job's
 * other candidates are dropped, and the A6a working copy is
 * deleted. Only the uploader can confirm their own job; anyone
 * else's job id is a 404 (no existence leak). Idempotent: an
 * already-pinned selected pin stays pinned and re-confirming
 * after the working copy is gone is a no-op delete. A working
 * copy that is already gone (confirmed, TTL-swept or missing)
 * never blocks the pins: the delete is skipped or a no-op.
 * Keeping none (PIN-122 "Clear") drops every candidate.
 */
export async function confirmPins(
  slug: string,
  participant: Participant,
  rawInput: unknown,
  deps: BoardApiDeps,
): Promise<{ pinnedPinIds: string[]; droppedPinIds: string[]; workingCopyDeleted: boolean }> {
  const input = parseConfirmPinsInput(rawInput, deps.policy);
  const job = await deps.jobs.get(input.jobId);
  if (!job || job.boardId !== slug || job.participantId !== participant.id) {
    throw new BoardApiError("Job not found.", 404);
  }
  // Only a finished photo can be confirmed (PIN-122 Bugbot): a job
  // still cutting keeps adding candidates from its in-memory photo,
  // so a Clear (or pin) now would not stick. The review only offers
  // Pin once the job is ready; the leftovers line says "still
  // cutting" on this 409 and the next poll brings the rest.
  if (job.status === "pending" || job.status === "running") {
    throw new BoardApiError("Still cutting this photo. Try again in a moment.", 409);
  }
  const now = deps.now?.() ?? Date.now();
  const jobPinIds = new Set(job.pinIds);

  const pinnedPinIds: string[] = [];
  for (const pinId of input.pinIds) {
    if (!jobPinIds.has(pinId)) {
      throw new BoardApiError("That pin is not part of this photo.");
    }
    const pin = await deps.boards.getPin(pinId);
    if (!pin || pin.boardId !== slug || pin.pinnedBy !== participant.id) {
      throw new BoardApiError("That pin is not part of this photo.");
    }
    if (pin.status === "candidate") {
      await deps.boards.setPinStatus(pinId, "pinned", now);
    }
    pinnedPinIds.push(pinId);
  }

  // Delete the working copy BEFORE dropping unselected pins
  // (after validation/pinning, so a failed confirm keeps it):
  // from the delete mark on, a racing tap-add's fresh check
  // sees the copy gone and cleans itself up, and the drop loop
  // below runs over the FRESHEST pin list, so a tap appended
  // mid-confirm is dropped here instead of orphaned (Bugbot
  // PIN-78 finding; the Add sheet also disables Pin during a
  // tap + refetch, closing the UI path).
  const updated = await deleteWorkingCopy(job, deps);
  const freshJob = (await deps.jobs.get(job.id)) ?? updated;
  const droppedPinIds: string[] = [];
  for (const pinId of freshJob.pinIds) {
    if (pinnedPinIds.includes(pinId)) continue;
    const pin = await deps.boards.getPin(pinId);
    if (pin && pin.status === "candidate") {
      await deps.boards.deletePin(pinId);
      droppedPinIds.push(pinId);
    }
  }

  return {
    pinnedPinIds,
    droppedPinIds,
    workingCopyDeleted: updated.workingDeletedAt !== undefined,
  };
}

export interface DeleteMyElementResult {
  deleted: boolean;
  unpinnedOnly: boolean;
  removedPinIds: string[];
  hiddenSceneIds: string[];
  storageDeleted: boolean;
}

/**
 * Delete my element (PIN-77, docs/11 section 5.4 Deletes):
 * owner-only. Missing board/element, an element from another
 * board, a non-owner participant and no participant at all all
 * throw the same 404 BoardApiError, which the route renders as
 * the one uniform body — no existence leak (candidate elements
 * are private pre-confirm, so a non-owner must not learn one
 * exists). The repository cascade (PIN-62) removes the element
 * and its pins, hides scenes that used it and fixes counters.
 *
 * Cross-board guard (PIN-77 stop rule): createPin enforces
 * same-board pins today, but if pins on OTHER boards ever
 * reference this element the element record and its stored
 * objects must survive for them — delete only this board's
 * pins, hide only this board's scenes, leave storage alone.
 *
 * Storage cleanup is best-effort AFTER the cascade: only the
 * element's own persistent `elements/` refs (cutout/flattened)
 * are deleted, each in its own try/catch so one missing object
 * cannot block the other or fail the request (the records are
 * already gone; an orphaned object is unreachable through any
 * route). Forged refs outside `elements/` are never touched —
 * never a `tmp/` working copy, never a `scenes/` image.
 *
 * No BoardEvent is written and no activity line added (PIN-77
 * decision): docs/11 section 5.4 fixes the event vocabulary
 * (only PIN-49 edits docs/11), and activityLines resolves a
 * pin's label from live elements, so a deleted pin's
 * "pinned" line already drops out of the strip honestly
 * instead of showing a snapshotted label the owner removed.
 * Suggestion chips are cached by label SET (PIN-75), never by
 * element id, so a delete cannot poison the cache: a future
 * selection with the same labels gets still-apt chips.
 */
export async function deleteMyElement(
  slug: string,
  participant: Participant | null,
  elementId: string,
  deps: BoardApiDeps,
): Promise<DeleteMyElementResult> {
  if (!participant) throw new BoardApiError("Element not found.", 404);
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Element not found.", 404);
  const element = await deps.boards.getElement(elementId);
  if (!element || element.boardId !== slug || element.ownerId !== participant.id) {
    throw new BoardApiError("Element not found.", 404);
  }

  const pins = await deps.boards.listPinsForElement(elementId);
  const pinsElsewhere = pins.filter((pin) => pin.boardId !== slug);
  if (pinsElsewhere.length > 0) {
    const removedPinIds: string[] = [];
    for (const pin of pins.filter((p) => p.boardId === slug)) {
      if (await deps.boards.deletePin(pin.id)) removedPinIds.push(pin.id);
    }
    const hiddenSceneIds: string[] = [];
    for (const scene of await deps.boards.listScenes(slug)) {
      if (!scene.elementIds.includes(elementId)) continue;
      await deps.boards.putScene({ ...scene, hidden: true });
      hiddenSceneIds.push(scene.id);
    }
    return { deleted: false, unpinnedOnly: true, removedPinIds, hiddenSceneIds, storageDeleted: false };
  }

  const result = await deps.boards.deleteElement(elementId);
  if (!result.deleted) {
    // Deleted concurrently after the ownership check: the end
    // state is the requested one, so report a no-op success.
    return { deleted: false, unpinnedOnly: false, removedPinIds: [], hiddenSceneIds: [], storageDeleted: false };
  }

  // Shared-asset guard (PIN-85): a library copy shares its
  // source's cutout/flattened objects (sourceElementId). Deleting
  // either record must leave storage alone while a live element
  // on the other side still points at the same refs — the copy
  // (and its scenes on its board) keeps working, and the last
  // record out deletes the objects.
  const othersSharingRefs = (
    await deps.boards.listElementsByCutoutRef(element.cutoutRef)
  ).filter((other) => other.id !== elementId);
  const sharedRefs: string[] =
    othersSharingRefs.length > 0 ? [] : [element.cutoutRef, element.flattenedRef];

  let storageDeleted = false;
  for (const ref of sharedRefs) {
    if (!ref.startsWith("elements/")) continue;
    try {
      await deps.store.delete(ref);
      storageDeleted = true;
    } catch {
      // Best-effort: records are gone, object is unreachable.
    }
  }
  return {
    deleted: true,
    unpinnedOnly: false,
    removedPinIds: result.removedPinIds,
    hiddenSceneIds: result.hiddenSceneIds,
    storageDeleted,
  };
}

export type ElementImageKind = "cutout" | "flattened";

/**
 * Board-link-checked image serving with NO existence leak: bad
 * kind, missing board, missing element, an element from another
 * board, a non-elements/ ref and a missing stored object all
 * return null, which the route renders as one uniform 404. The
 * slug in the URL is the 128-bit capability link (docs/11
 * section 5.5): holding it is what authorizes the read, exactly
 * like the board page itself, so no participant cookie is needed
 * for a second phone to see pins. Only persistent derived refs
 * under elements/ are ever served — never a tmp/ working copy.
 */
export async function resolveElementImage(
  slug: string,
  elementId: string,
  kind: string | null,
  deps: BoardApiDeps,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (kind !== "cutout" && kind !== "flattened") return null;
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const element = await deps.boards.getElement(elementId);
  if (!element || element.boardId !== slug) return null;
  const ref = kind === "cutout" ? element.cutoutRef : element.flattenedRef;
  if (!ref.startsWith("elements/")) return null;
  const bytes = await deps.store.get(ref);
  if (!bytes) return null;
  return {
    bytes,
    contentType: kind === "cutout" ? "image/png" : "image/jpeg",
  };
}

export interface RequestSceneInput {
  /** Remix parent Scene id (PIN-79, §5.7); elementIds stay the NEW pins. */
  parentSceneId?: string;
  elementIds: string[];
  prompt: string;
  sceneId?: string;
}

export function parseRequestSceneInput(value: unknown): RequestSceneInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Pick some pins and describe your scene.");
  }
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.elementIds) ||
    body.elementIds.length === 0 ||
    body.elementIds.some((id) => typeof id !== "string" || !id)
  ) {
    throw new BoardApiError("Pick at least one pin for your scene.");
  }
  if (typeof body.prompt !== "string" || !body.prompt.trim()) {
    throw new BoardApiError("Describe your scene.");
  }
  let parentSceneId: string | undefined;
  if (body.parentSceneId !== undefined && body.parentSceneId !== null && body.parentSceneId !== "") {
    if (typeof body.parentSceneId !== "string") {
      throw new BoardApiError("That scene is not ready to remix.");
    }
    parentSceneId = body.parentSceneId;
  }
  let sceneId: string | undefined;
  if (body.sceneId !== undefined && body.sceneId !== null && body.sceneId !== "") {
    if (typeof body.sceneId !== "string") {
      throw new BoardApiError("That scene id is not valid.");
    }
    sceneId = body.sceneId;
  }
  return {
    elementIds: body.elementIds as string[],
    prompt: body.prompt,
    ...(parentSceneId ? { parentSceneId } : {}),
    ...(sceneId ? { sceneId } : {}),
  };
}

function requireSceneDeps(deps: BoardApiDeps): {
  sceneJobs: SceneJobStore;
  composer: SceneComposer;
} {
  if (!deps.sceneJobs || !deps.composer) {
    throw new BoardApiError("Scenes are not available on this server.", 503);
  }
  return { sceneJobs: deps.sceneJobs, composer: deps.composer };
}

/**
 * POST a scene (PIN-69): run its SceneJob in-request, client polls
 * the scene. Friendly terminal states (ready/refused/failed) ride
 * in the returned job+scene — a refused prompt is a 201 with
 * status "refused", never a 500. Request-time cap/validation
 * denies are BoardApiErrors (429/409/400) before any spend.
 */
export async function requestScene(
  slug: string,
  participant: Participant,
  rawInput: unknown,
  deps: BoardApiDeps,
): Promise<{ job: SceneJob; scene: Scene }> {
  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Board not found.", 404);
  const input = parseRequestSceneInput(rawInput);
  const { sceneJobs, composer } = requireSceneDeps(deps);
  let job: SceneJob;
  try {
    job = await startSceneJob(
      {
        boardId: slug,
        participantId: participant.id,
        elementIds: input.elementIds,
        prompt: input.prompt,
        ...(input.sceneId ? { sceneId: input.sceneId } : {}),
        ...(input.parentSceneId ? { parentSceneId: input.parentSceneId } : {}),
      },
      {
        boards: deps.boards,
        jobs: sceneJobs,
        store: deps.store,
        composer,
        collageMode: deps.collageMode ?? false,
        policy: deps.policy,
        now: deps.now,
        newId: deps.newId,
      },
    );
  } catch (error) {
    if (error instanceof SceneJobRequestError) {
      const status =
        error.code === "scenes_per_participant_day" ||
        error.code === "scenes_per_board_day"
          ? 429
          : error.code === "scene_id_conflict"
            ? 409
            : error.code === "element_not_found" ||
                error.code === "parent_not_found"
              ? 404
              : 400;
      throw new BoardApiError(error.message, status, error.code);
    }
    if (error instanceof RangeError) {
      throw new BoardApiError("Board not found.", 404);
    }
    throw error;
  }
  const scene = await deps.boards.getScene(job.id);
  if (!scene) throw new BoardApiError("Scene not found.", 404);
  return { job, scene };
}

/**
 * Gallery poll: every non-hidden scene on the board (hidden =
 * a used element was deleted, section 5.4), link-public like the
 * board view. Null when the board does not exist.
 */
export async function getScenesView(slug: string, deps: BoardApiDeps) {
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const scenes = await deps.boards.listScenes(slug);
  return { scenes: scenes.map((scene) => publicScene(slug, scene)) };
}

/**
 * One scene's status card. Missing board, missing scene, a scene
 * from another board and a hidden scene all return null — one
 * uniform 404 at the route.
 */
export async function getSceneView(
  slug: string,
  sceneId: string,
  deps: BoardApiDeps,
) {
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const scene = await deps.boards.getScene(sceneId);
  if (!scene || scene.boardId !== slug || scene.hidden) return null;
  const job = deps.sceneJobs
    ? await deps.sceneJobs.get(slug, sceneId)
    : null;
  return {
    scene: publicScene(slug, scene),
    job: job ? publicSceneJob(job) : null,
  };
}

/**
 * Suggestion chips for the picked pins (PIN-75): generated via the
 * decorated ChipSuggester, cached per label set, fixed Policy list
 * on any non-ready outcome. Validation errors (missing board/pin)
 * keep the API's uniform 404 discipline.
 */
export async function getSceneChips(
  slug: string,
  participant: Participant,
  rawInput: unknown,
  deps: BoardApiDeps,
): Promise<SceneChipsResult> {
  return resolveSceneChips(slug, participant, rawInput, {
    boards: deps.boards,
    ...(deps.chipSuggester ? { suggester: deps.chipSuggester } : {}),
    cache: deps.chipsCache ?? new InMemoryChipsCacheStore(),
    policy: deps.policy,
    now: deps.now,
  });
}

const SCENE_IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Board-link-checked scene image, same uniform-miss discipline as
 * resolveElementImage: missing board/scene, another board's
 * scene, a hidden (element-deleted) scene, a not-ready scene, a
 * non-scenes/ ref and a missing object all return null -> 404.
 */
export async function resolveSceneImage(
  slug: string,
  sceneId: string,
  deps: BoardApiDeps,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const board = await deps.boards.getBoard(slug);
  if (!board) return null;
  const scene = await deps.boards.getScene(sceneId);
  if (
    !scene ||
    scene.boardId !== slug ||
    scene.hidden ||
    scene.status !== "ready" ||
    !scene.imageRef
  ) {
    return null;
  }
  if (!scene.imageRef.startsWith("scenes/")) return null;
  const ext = scene.imageRef.split(".").at(-1) ?? "";
  const contentType = SCENE_IMAGE_TYPES[ext.toLowerCase()];
  if (!contentType) return null;
  const bytes = await deps.store.get(scene.imageRef);
  if (!bytes) return null;
  return { bytes, contentType };
}
