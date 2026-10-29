import "server-only";
/**
 * SceneJob service (PIN-69, docs/11 sections 5.3-5.6).
 *
 * Mirrors the DecomposeJob service: pending -> running -> ready /
 * failed / refused, idempotent by job id with claim-before-call —
 * only the caller that flips pending -> running may call the
 * SceneComposer port, so a re-run (double submit, client retry,
 * second poll-trigger) never double-bills. The job id IS the
 * Scene id: the Scene record (BoardRepository) is the gallery's
 * poll surface and is kept in step on every transition, so the
 * delete cascade can hide it when a used element is deleted.
 *
 * Caps are Policy-owned and enforced twice, exactly like photos:
 * pinsPerScene + scenes/participant/day + scenes/board/day here
 * at request time (counted over today's jobs, UTC day), and the
 * PIN-61 budget decorator re-enforces the scene caps at the port.
 * Refusals/failures become the job's typed terminal state with a
 * friendly line — never a throw, never a 500, never silent mock.
 *
 * Ports arrive already decorated (timeout/retry/budget/cost log,
 * PIN-61) from the composition root; this module never touches a
 * provider. HTTP routes live in board-api.ts / the scenes routes.
 */
import { randomUUID } from "node:crypto";
import type {
  BoardEvent,
  BoardEventType,
  Element,
  Scene,
  SceneJob,
} from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { estimateReserveUsd } from "../gateway/costs";
import type { ComposeSceneElement, SceneComposer } from "../gateway/ports";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import {
  assertDerivativeRef,
  type DerivativeStore,
} from "./derivative-store";
import { composeCollage, parseSceneSize } from "./scene-collage";

/** Request-time denial, mapped to an HTTP status by board-api. */
export class SceneJobRequestError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "bad_prompt"
      | "pins_per_scene"
      | "element_not_found"
      | "scenes_per_participant_day"
      | "scenes_per_board_day"
      | "scene_id_conflict"
      | "parent_not_found",
  ) {
    super(message);
    this.name = "SceneJobRequestError";
  }
}

/**
 * Job persistence port. Board-scoped on purpose: every caller has
 * the slug in hand, so the Firestore home boards/{slug}/sceneJobs
 * needs only direct doc refs and a subcollection read — no
 * collection-group query, no new Firestore index (PIN-69).
 */
export interface SceneJobStore {
  /** Stores a new pending job; duplicate id throws RangeError. */
  create(job: SceneJob): Promise<void>;
  get(boardId: string, jobId: string): Promise<SceneJob | null>;
  /**
   * Atomically flip pending -> running. Returns the claimed job,
   * or null when missing or not pending — the claim gate.
   */
  claim(boardId: string, jobId: string, now: number): Promise<SceneJob | null>;
  /** Replace the stored job (progress + terminal states). */
  update(job: SceneJob): Promise<void>;
  /** All jobs on one board, createdAt-ascending (daily caps). */
  listForBoard(boardId: string): Promise<SceneJob[]>;
}

function cloneJob(job: SceneJob): SceneJob {
  return structuredClone(job);
}

export class InMemorySceneJobStore implements SceneJobStore {
  private jobs = new Map<string, SceneJob>();

  private key(boardId: string, jobId: string): string {
    return `${boardId}/${jobId}`;
  }

  async create(job: SceneJob): Promise<void> {
    const key = this.key(job.boardId, job.id);
    if (this.jobs.has(key)) {
      throw new RangeError(`SceneJob ${job.id} already exists`);
    }
    this.jobs.set(key, cloneJob(job));
  }

  async get(boardId: string, jobId: string): Promise<SceneJob | null> {
    const job = this.jobs.get(this.key(boardId, jobId));
    return job ? cloneJob(job) : null;
  }

  async listForBoard(boardId: string): Promise<SceneJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.boardId === boardId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneJob);
  }

  async claim(
    boardId: string,
    jobId: string,
    now: number,
  ): Promise<SceneJob | null> {
    // No awaits between check and write: atomic in-process, the
    // same discipline the Firestore transaction keeps.
    const job = this.jobs.get(this.key(boardId, jobId));
    if (!job || job.status !== "pending") return null;
    const claimed: SceneJob = {
      ...cloneJob(job),
      status: "running",
      updatedAt: now,
    };
    this.jobs.set(this.key(boardId, jobId), claimed);
    return cloneJob(claimed);
  }

  async update(job: SceneJob): Promise<void> {
    const key = this.key(job.boardId, job.id);
    if (!this.jobs.has(key)) {
      throw new RangeError(`SceneJob ${job.id} not found`);
    }
    this.jobs.set(key, cloneJob(job));
  }
}

const SCENE_ID = /^[A-Za-z0-9_-]+$/;

/** Persistent scene image under `scenes/` (docs/11 section 5.5). */
export function buildSceneImageRef(
  boardId: string,
  sceneId: string,
  ext: string,
): string {
  return assertDerivativeRef(`scenes/boards/${boardId}/${sceneId}/scene.${ext}`);
}

/** Magic-byte sniff for the composed image (Meta/mock are PNG). */
export function sniffSceneImage(bytes: Buffer): {
  ext: string;
  contentType: string;
} {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return { ext: "png", contentType: "image/png" };
}

export interface SceneJobDeps {
  boards: BoardRepository;
  jobs: SceneJobStore;
  store: DerivativeStore;
  composer: SceneComposer;
  /**
   * Offline/demo mode (AI_MOCK=1 at the composition root, PIN-71):
   * the sharp mock collage IS the scene composer — no port call,
   * and the Scene is recorded kind "collage", never as AI output.
   */
  collageMode?: boolean;
  policy: Policy;
  now?: () => number;
  newId?: () => string;
}

export interface StartSceneInput {
  /**
   * Remix parent Scene id (PIN-79, §5.7). The parent must be a
   * ready, non-hidden scene on the same board. `elementIds` are
   * the NEW pins only: the pinsPerScene cap below counts them and
   * excludes the parent (the parent is a scene, not a pin).
   */
  parentSceneId?: string;
  boardId: string;
  participantId: string;
  elementIds: string[];
  prompt: string;
  /**
   * Optional client-generated id (= Scene id). Re-POSTing the same
   * id with the same elements+prompt returns the existing job and
   * never calls the composer twice (idempotent double submit).
   */
  sceneId?: string;
}

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * Remix credit/cascade set (PIN-79): the new pins plus every
 * ancestor scene's elementIds, walking parentSceneId on the same
 * board (cycle-safe). Snapshotted onto the job so the Scene can
 * carry it for credits and the delete cascade.
 */
async function remixCreditElementIds(
  deps: SceneJobDeps,
  boardId: string,
  parentSceneId: string,
  newElementIds: string[],
): Promise<string[]> {
  const seen = new Set<string>();
  const ids: string[] = [];
  const push = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  newElementIds.forEach(push);
  const visited = new Set<string>();
  let cursor: string | undefined = parentSceneId;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const ancestor = await deps.boards.getScene(cursor);
    if (!ancestor || ancestor.boardId !== boardId) break;
    ancestor.elementIds.forEach(push);
    cursor = ancestor.parentSceneId;
  }
  return ids;
}

function sceneFromJob(job: SceneJob, hidden?: boolean): Scene {
  return {
    id: job.id,
    boardId: job.boardId,
    createdBy: job.participantId,
    // Remix children carry the full credit union here so the
    // delete cascade (keyed on Scene.elementIds) hides them when
    // ANY contributing element — parent's included — is deleted.
    elementIds: [...(job.creditElementIds ?? job.elementIds)],
    prompt: job.prompt,
    status: job.status,
    ...(job.imageRef ? { imageRef: job.imageRef } : {}),
    ...(job.kind ? { kind: job.kind } : {}),
    ...(job.parentSceneId ? { parentSceneId: job.parentSceneId } : {}),
    promptVersion: job.promptVersion,
    ...(job.costUsd !== undefined ? { costUsd: job.costUsd } : {}),
    ...(job.refusalReason ? { refusalReason: job.refusalReason } : {}),
    ...(hidden ? { hidden: true } : {}),
    createdAt: job.createdAt,
  };
}

/**
 * Keep the gallery Scene in step, preserving a delete-cascade
 * hide. The pre-write `hidden` read alone races a concurrent
 * delete (its cascade could land between our read and our write,
 * and the full-scene write would unhide it), so after writing we
 * re-check that every used element still exists and re-hide if
 * one is gone. The delete cascade is atomic with the element
 * removal in both repositories, so a delete either committed
 * before the re-check (element gone -> re-hide here) or its
 * cascade runs after our write and hides the scene itself.
 */
async function syncScene(deps: SceneJobDeps, job: SceneJob): Promise<Scene> {
  const existing = await deps.boards.getScene(job.id);
  const scene = sceneFromJob(job, existing?.boardId === job.boardId ? existing.hidden : undefined);
  await deps.boards.putScene(scene);
  if (!scene.hidden) {
    for (const elementId of scene.elementIds) {
      const element = await deps.boards.getElement(elementId);
      if (!element || element.boardId !== job.boardId) {
        const hiddenScene: Scene = { ...scene, hidden: true };
        await deps.boards.putScene(hiddenScene);
        return hiddenScene;
      }
    }
  }
  return scene;
}

async function appendSceneEvent(
  deps: SceneJobDeps,
  job: SceneJob,
  type: BoardEventType,
  suffix: string,
): Promise<void> {
  const event: BoardEvent = {
    id: `scene-${job.id}-${suffix}`,
    boardId: job.boardId,
    type,
    actorId: job.participantId,
    sceneId: job.id,
    createdAt: (deps.now ?? Date.now)(),
  };
  try {
    await deps.boards.appendEvent(event);
  } catch (error) {
    // Deterministic id: a RangeError here means this transition
    // was already recorded (idempotent re-run) — not a failure.
    if (!(error instanceof RangeError)) throw error;
  }
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Validate + create the pending job (+ its Scene) + run it
 * in-request (docs/11 A4: request does the work, client polls).
 * Validation/cap failures throw SceneJobRequestError before any
 * job, Scene or composer call exists.
 */
export async function startSceneJob(
  input: StartSceneInput,
  deps: SceneJobDeps,
): Promise<SceneJob> {
  const now = deps.now ?? Date.now;
  const { policy } = deps;

  const prompt = input.prompt.trim().replace(/\s+/g, " ");
  if (!prompt || [...prompt].length > policy.scenePromptMaxChars) {
    throw new SceneJobRequestError(
      `Describe your scene in up to ${policy.scenePromptMaxChars} characters.`,
      "bad_prompt",
    );
  }
  const elementIds = [...new Set(input.elementIds.filter(Boolean))];
  if (
    elementIds.length < policy.pinsPerScene.min ||
    elementIds.length > policy.pinsPerScene.max
  ) {
    throw new SceneJobRequestError(
      `Pick between ${policy.pinsPerScene.min} and ${policy.pinsPerScene.max} pins for a scene.`,
      "pins_per_scene",
    );
  }

  const board = await deps.boards.getBoard(input.boardId);
  if (!board) throw new RangeError(`Board ${input.boardId} not found`);
  const participant = await deps.boards.getParticipant(
    input.boardId,
    input.participantId,
  );
  if (!participant) {
    throw new RangeError(`Participant ${input.participantId} not found`);
  }

  // Remix (PIN-79, §5.7): the parent must be a ready, visible
  // scene on THIS board with a stored image — checked before any
  // job or spend exists. Missing/other-board/hidden/not-ready
  // all land as parent_not_found (one uniform 404 at the route).
  const parentSceneId = input.parentSceneId?.trim() || undefined;
  if (parentSceneId) {
    const parent = await deps.boards.getScene(parentSceneId);
    if (
      !parent ||
      parent.boardId !== input.boardId ||
      parent.hidden ||
      parent.status !== "ready" ||
      !parent.imageRef
    ) {
      throw new SceneJobRequestError(
        "That scene is not ready to remix.",
        "parent_not_found",
      );
    }
  }

  const creditElementIds = parentSceneId
    ? await remixCreditElementIds(deps, input.boardId, parentSceneId, elementIds)
    : undefined;

  const sceneId = input.sceneId?.trim();
  if (sceneId) {
    if (!SCENE_ID.test(sceneId)) {
      throw new SceneJobRequestError("That scene id is not valid.", "bad_prompt");
    }
    const existing = await deps.jobs.get(input.boardId, sceneId);
    if (existing) {
      if (
        existing.participantId !== input.participantId ||
        (existing.parentSceneId ?? undefined) !== parentSceneId ||
        existing.prompt !== prompt ||
        !sameStringList(existing.elementIds, elementIds)
      ) {
        throw new SceneJobRequestError(
          "That scene id was already used for a different scene.",
          "scene_id_conflict",
        );
      }
      return runSceneJob(input.boardId, sceneId, deps);
    }
    // Scene ids are global in BoardRepository: an id already used
    // by a Scene on any board (with no matching job here) conflicts.
    if (await deps.boards.getScene(sceneId)) {
      throw new SceneJobRequestError(
        "That scene id was already used for a different scene.",
        "scene_id_conflict",
      );
    }
  }

  // Every chosen pin must exist on this board and be pinned. A
  // deleted element is gone from the repository, so it can never
  // enter a scene (deleted-element exclusion).
  const pinnedElementIds = new Set(
    (await deps.boards.listPins(input.boardId, "pinned")).map((p) => p.elementId),
  );
  for (const elementId of elementIds) {
    const element = await deps.boards.getElement(elementId);
    if (
      !element ||
      element.boardId !== input.boardId ||
      !pinnedElementIds.has(elementId)
    ) {
      throw new SceneJobRequestError(
        "One of those pins is not on this board anymore.",
        "element_not_found",
      );
    }
  }

  // Policy daily caps at request time (UTC day, like uploadPhoto);
  // the PIN-61 decorator re-checks both at the port via its
  // reserve counters as a second line.
  const at = now();
  const todays = (await deps.jobs.listForBoard(input.boardId)).filter(
    (job) => job.createdAt >= startOfUtcDay(at),
  );
  if (todays.length >= policy.scenesPerBoardPerDay) {
    throw new SceneJobRequestError(
      t("en", "ai.boardCap"),
      "scenes_per_board_day",
    );
  }
  if (
    todays.filter((job) => job.participantId === input.participantId).length >=
    policy.scenesPerParticipantPerDay
  ) {
    throw new SceneJobRequestError(
      t("en", "ai.participantCap"),
      "scenes_per_participant_day",
    );
  }

  const jobId = sceneId || (deps.newId ?? randomUUID)();
  const job: SceneJob = {
    id: jobId,
    boardId: input.boardId,
    participantId: input.participantId,
    elementIds,
    prompt,
    status: "pending",
    ...(parentSceneId ? { parentSceneId } : {}),
    ...(creditElementIds ? { creditElementIds } : {}),
    promptVersion: policy.promptVersions.scene,
    createdAt: at,
    updatedAt: at,
  };
  try {
    await deps.jobs.create(job);
  } catch (error) {
    // Lost a same-id create race (concurrent double submit): the
    // winner's job is the idempotent result when it matches.
    if (error instanceof RangeError) {
      const raced = await deps.jobs.get(input.boardId, jobId);
      if (
        raced &&
        raced.participantId === input.participantId &&
        (raced.parentSceneId ?? undefined) === parentSceneId &&
        raced.prompt === prompt &&
        sameStringList(raced.elementIds, elementIds)
      ) {
        return runSceneJob(input.boardId, jobId, deps);
      }
      if (raced) {
        throw new SceneJobRequestError(
          "That scene id was already used for a different scene.",
          "scene_id_conflict",
        );
      }
    }
    throw error;
  }
  await syncScene(deps, job);
  await appendSceneEvent(deps, job, "scene_requested", "requested");
  return runSceneJob(input.boardId, jobId, deps);
}

async function finish(
  deps: SceneJobDeps,
  job: SceneJob,
): Promise<SceneJob> {
  const done: SceneJob = {
    ...job,
    updatedAt: (deps.now ?? Date.now)(),
  };
  await deps.jobs.update(done);
  await syncScene(deps, done);
  if (done.status === "ready") {
    await appendSceneEvent(deps, done, "scene_ready", "ready");
  } else if (done.status === "refused") {
    await appendSceneEvent(deps, done, "scene_refused", "refused");
  } else if (done.status === "failed") {
    await appendSceneEvent(deps, done, "scene_failed", "failed");
  }
  return cloneJob(done);
}

async function composeElement(
  deps: SceneJobDeps,
  element: Element,
): Promise<ComposeSceneElement | null> {
  // sceneInputMode decides which persistent derivative is sent
  // (PIN-50 lock: flattened). `whole` has no persistent whole-photo
  // ref by privacy design, so it degrades to the flattened copy.
  const transparent = deps.policy.sceneInputMode === "transparent";
  const ref = transparent ? element.cutoutRef : element.flattenedRef;
  const bytes = await deps.store.get(ref);
  if (!bytes) return null;
  const mime = transparent ? "image/png" : "image/jpeg";
  const owner = await deps.boards.getParticipant(
    element.boardId,
    element.ownerId,
  );
  return {
    label: element.label,
    description: element.description,
    imageRef: `data:${mime};base64,${bytes.toString("base64")}`,
    ...(owner ? { from: owner.displayName } : {}),
  };
}

/**
 * Decorator budget denies (PIN-61 ReserveDenyReason -> errorCode)
 * that the sharp mock collage covers instead of a dead-end failed
 * card (PIN-71, PIN-54 outcome: "with AI_MOCK=1 or over budget, a
 * collage of the cut-outs appears instead"). Participant/board
 * daily caps are NOT budget fallback: they stay friendly failed.
 */
const BUDGET_FALLBACK_CODES = new Set(["budget", "call_limit", "budget_off"]);

function isBudgetFallback(errorCode: string | undefined): boolean {
  return errorCode !== undefined && BUDGET_FALLBACK_CODES.has(errorCode);
}

/**
 * Finish a job with the mock collage (PIN-71): cut-outs on a
 * gradient at Policy.sceneSize, stored under scenes/, recorded
 * kind "collage" at $0 — honestly labelled, never an AI scene.
 * Failures land as typed failed states like every other path.
 */
async function finishCollage(
  deps: SceneJobDeps,
  job: SceneJob,
  records: Element[],
): Promise<SceneJob> {
  const size = parseSceneSize(deps.policy.sceneSize);
  if (!size) {
    job.status = "failed";
    job.errorCode = "collage_failed";
    return finish(deps, job);
  }
  const cutouts: Buffer[] = [];
  for (const element of records) {
    const bytes = await deps.store.get(element.cutoutRef);
    if (!bytes) {
      job.status = "failed";
      job.errorCode = "element_image_missing";
      return finish(deps, job);
    }
    cutouts.push(bytes);
  }
  let png: Buffer;
  try {
    // Remix fallback (PIN-79): cut-outs go OVER the parent image.
    let parentBytes: Buffer | undefined;
    if (job.parentSceneId) {
      const parent = await deps.boards.getScene(job.parentSceneId);
      const bytes =
        parent?.boardId === job.boardId && parent.imageRef
          ? await deps.store.get(parent.imageRef)
          : null;
      if (!bytes) {
        job.status = "failed";
        job.errorCode = "parent_missing";
        return finish(deps, job);
      }
      parentBytes = bytes;
    }
    png = await composeCollage(cutouts, size, parentBytes);
  } catch {
    job.status = "failed";
    job.errorCode = "collage_failed";
    return finish(deps, job);
  }
  const imageRef = buildSceneImageRef(job.boardId, job.id, "png");
  await deps.store.put(imageRef, png, "image/png");
  job.status = "ready";
  job.kind = "collage";
  job.imageRef = imageRef;
  job.costUsd = 0;
  return finish(deps, job);
}

/**
 * Run one pending job. Idempotent: a job already running or in a
 * terminal state is returned as-is without any port call. Port
 * refusals/failures become typed terminal states, never a throw;
 * only a missing job throws RangeError.
 */
export async function runSceneJob(
  boardId: string,
  jobId: string,
  deps: SceneJobDeps,
): Promise<SceneJob> {
  const now = deps.now ?? Date.now;
  const job = await deps.jobs.claim(boardId, jobId, now());
  if (!job) {
    const existing = await deps.jobs.get(boardId, jobId);
    if (!existing) throw new RangeError(`SceneJob ${jobId} not found`);
    return existing; // already claimed or finished: no duplicate work
  }
  const { policy } = deps;

  try {
    await syncScene(deps, job); // status running, for the gallery poll

    const records: Element[] = [];
    for (const elementId of job.elementIds) {
      const element = await deps.boards.getElement(elementId);
      if (!element || element.boardId !== boardId) {
        // Deleted between request and run: never spend on it.
        job.status = "failed";
        job.errorCode = "element_missing";
        return finish(deps, job);
      }
      records.push(element);
    }
    // Offline/demo mode (PIN-71): the collage is the composer; the
    // SceneComposer port (and its budget reserve) is never called.
    if (deps.collageMode) return finishCollage(deps, job, records);

    const elements: ComposeSceneElement[] = [];
    for (const element of records) {
      const composed = await composeElement(deps, element);
      if (!composed) {
        job.status = "failed";
        job.errorCode = "element_image_missing";
        return finish(deps, job);
      }
      elements.push(composed);
    }

    // Remix (PIN-79, §5.7): resolve the parent scene image to a
    // data: URL for the builder's first slot. A parent that
    // vanished (or lost its image) between request and run fails
    // typed BEFORE any composer spend. The parent record itself
    // is never written here — remixes leave it unchanged.
    let parentSceneImageRef: string | undefined;
    if (job.parentSceneId) {
      const parent = await deps.boards.getScene(job.parentSceneId);
      const bytes =
        parent?.boardId === boardId && parent.imageRef
          ? await deps.store.get(parent.imageRef)
          : null;
      if (!bytes) {
        job.status = "failed";
        job.errorCode = "parent_missing";
        return finish(deps, job);
      }
      parentSceneImageRef = `data:${sniffSceneImage(bytes).contentType};base64,${bytes.toString("base64")}`;
    }

    const outcome = await deps.composer.composeScene({
      elements,
      ...(parentSceneImageRef ? { parentSceneImageRef } : {}),
      prompt: job.prompt,
      size: policy.sceneSize,
      // Remix is stateless (PIN-79, §5.7): store=false, always.
      store: parentSceneImageRef ? false : policy.sceneStore,
      timeoutMs: policy.timeoutsMs.scene,
      promptVersion: policy.promptVersions.scene,
      sceneInputMode: policy.sceneInputMode,
      boardId,
      participantId: job.participantId,
    });

    if (outcome.status === "refused") {
      job.status = "refused";
      job.errorCode = outcome.errorCode ?? "refused";
      job.refusalReason = t("en", "ai.refused");
      return finish(deps, job);
    }
    if (outcome.status !== "ready") {
      // Over budget (PIN-71): the collage appears instead, clearly
      // labelled kind "collage" — never a silent mock swap.
      if (isBudgetFallback(outcome.errorCode)) {
        return finishCollage(deps, job, records);
      }
      job.status = "failed";
      job.errorCode = outcome.errorCode ?? "scene_failed";
      return finish(deps, job);
    }
    job.promptVersion = outcome.value.promptVersion;
    if (!outcome.value.imageBase64) {
      // A ready outcome with no bytes (e.g. a fixture imageRef) is
      // not storable product output: fail typed, never store a ref.
      job.status = "failed";
      job.errorCode = "scene_no_image";
      return finish(deps, job);
    }
    const bytes = Buffer.from(outcome.value.imageBase64, "base64");
    if (bytes.length === 0) {
      job.status = "failed";
      job.errorCode = "scene_no_image";
      return finish(deps, job);
    }
    const kind = sniffSceneImage(bytes);
    const imageRef = buildSceneImageRef(boardId, job.id, kind.ext);
    await deps.store.put(imageRef, bytes, kind.contentType);
    job.status = "ready";
    job.kind = "ai";
    job.imageRef = imageRef;
    // Gateway reserve proxy (Spark-token estimate until /responses
    // prices publish); the provider dashboard is authoritative.
    job.costUsd = estimateReserveUsd("composeScene", {
      sparkElementsMaxTokens: policy.maxTokens.sparkElements,
    });
    return finish(deps, job);
  } catch {
    job.status = "failed";
    job.errorCode = "scene_failed";
    return finish(deps, job);
  }
}
