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
import { generateSlug } from "../domain/tokens";
import type { ChipSuggester, ElementNamer, SceneComposer, Segmenter } from "../gateway/ports";
import type { Policy } from "../policy/policy";
import { BoardApiError, publicParticipant } from "./board-session";
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
  chipsCache?: ChipsCacheStore;
  /** AI_MOCK=1 (PIN-71): scenes are sharp collages, kind "collage". */
  collageMode?: boolean;
  policy: Policy;
  now?: () => number;
  createSlug?: () => string;
  newId?: () => string;
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
    themeId = body.themeId;
  }
  return { title, ...(themeId ? { themeId } : {}) };
}

const MAX_SLUG_ATTEMPTS = 5;

export async function createBoard(
  rawInput: unknown,
  deps: BoardApiDeps,
): Promise<Board> {
  const input = parseCreateBoardInput(rawInput, deps.policy);
  const now = deps.now?.() ?? Date.now();
  const theme = getBoardTheme(input.themeId);
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const board: Board = {
      slug: deps.createSlug?.() ?? generateSlug(),
      title: input.title,
      ...(input.themeId ? { themeId: input.themeId } : {}),
      ...(theme ? { theme: theme.tokens } : {}),
      counters: emptyBoardCounters(),
      createdAt: now,
      version: 1,
    };
    try {
      await deps.boards.createBoard(board);
      return board;
    } catch (error) {
      if (error instanceof RangeError && attempt < MAX_SLUG_ATTEMPTS - 1) continue;
      throw error;
    }
  }
  throw new BoardApiError("Could not create a board. Please try again.", 503);
}

/**
 * Board view for the polling board page: pinned pins are public to
 * anyone holding the link; candidate pins only to their uploader.
 * Returns null when the board does not exist.
 */
export async function getBoardView(
  slug: string,
  viewer: Participant | null,
  deps: BoardApiDeps,
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
  return {
    board: publicBoard(board),
    me: viewer ? publicParticipant(viewer) : null,
    participants: participants.map(publicParticipant),
    pins: pins.map(publicPin),
    elements: elements
      .filter((element) => visibleElementIds.has(element.id))
      .map((element) => publicElement(slug, element)),
    scenes: scenes.map((scene) => publicScene(slug, scene)),
    // Activity strip (PIN-74): board-visible BoardEvent lines,
    // latest Policy.activityStripMax, names/labels resolved here.
    activity: activityLines(events, participants, elements, deps.policy.activityStripMax),
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

async function deleteWorkingCopy(job: DecomposeJob, deps: BoardApiDeps): Promise<DecomposeJob> {
  if (job.workingDeletedAt !== undefined) return job;
  const now = deps.now?.() ?? Date.now();
  await deps.store.delete(job.workingRef);
  const updated: DecomposeJob = { ...job, workingDeletedAt: now, updatedAt: now };
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
 * leak). The generic label comes from i18n (add.tapLabel); the
 * service enforces the working-copy lifetime, the usable-mask
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

export function parseConfirmPinsInput(value: unknown, policy: Policy): ConfirmPinsInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Choose which pins to keep.");
  }
  const body = value as Record<string, unknown>;
  if (typeof body.jobId !== "string" || !body.jobId) {
    throw new BoardApiError("Choose which pins to keep.");
  }
  if (
    !Array.isArray(body.pinIds) ||
    body.pinIds.length === 0 ||
    body.pinIds.some((id) => typeof id !== "string" || !id)
  ) {
    throw new BoardApiError("Choose at least one pin.");
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
 * after the working copy is gone is a no-op delete.
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

  const droppedPinIds: string[] = [];
  for (const pinId of job.pinIds) {
    if (pinnedPinIds.includes(pinId)) continue;
    const pin = await deps.boards.getPin(pinId);
    if (pin && pin.status === "candidate") {
      await deps.boards.deletePin(pinId);
      droppedPinIds.push(pinId);
    }
  }

  const updated = await deleteWorkingCopy(job, deps);
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

  let storageDeleted = false;
  for (const ref of [element.cutoutRef, element.flattenedRef]) {
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
            : error.code === "element_not_found"
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
