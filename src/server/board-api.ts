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
import type { BoardRepository } from "../domain/board-repository";
import { getBoardTheme, isBoardThemeId } from "../domain/board-themes";
import { generateSlug } from "../domain/tokens";
import type { ElementNamer, SceneComposer, Segmenter } from "../gateway/ports";
import type { Policy } from "../policy/policy";
import { BoardApiError, publicParticipant } from "./board-session";
import { startDecomposeJob, type DecomposeJobStore } from "./decompose-job";
import type { DerivativeStore } from "./derivative-store";
import {
  SceneJobRequestError,
  startSceneJob,
  type SceneJobStore,
} from "./scene-job";

export interface BoardApiDeps {
  boards: BoardRepository;
  jobs: DecomposeJobStore;
  store: DerivativeStore;
  namer: ElementNamer;
  segmenter: Segmenter;
  /** Scene slice (PIN-69); scene functions 503 cleanly without them. */
  sceneJobs?: SceneJobStore;
  composer?: SceneComposer;
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
  const [participants, allPins, elements, scenes] = await Promise.all([
    deps.boards.listParticipants(slug),
    deps.boards.listPins(slug),
    deps.boards.listElements(slug),
    deps.boards.listScenes(slug),
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
