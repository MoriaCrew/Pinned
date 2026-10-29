import "server-only";
/**
 * DecomposeJob service (PIN-64, docs/11 section 5.3).
 *
 * One photo in, candidate pins out: photo-intake (PIN-34, original
 * bytes are never stored — only the stripped derivative under
 * `tmp/`) -> ElementNamer port (elements.v1, Policy counts) ->
 * Segmenter port per concept at Policy concurrency -> cut-out PNG
 * + flattened copy under `elements/` (persistent) -> Element +
 * candidate Pin via BoardRepository (which emits `element_added`;
 * candidate pins emit nothing until they become pinned).
 *
 * Jobs move pending -> running -> ready / failed / refused and are
 * idempotent by job id with claim-before-call: only the caller
 * that flips pending -> running may call the ports, so a re-run
 * (double submit, client retry, second poll) never double-bills
 * and never duplicates elements — element/pin ids are also derived
 * deterministically from the job id as a second line of defence.
 * Candidate pins are persisted as each SAM call lands, not at the
 * end, so a polling client sees them pop in, and one concept
 * failing never discards the pins that already landed.
 *
 * Ports arrive already decorated (timeout/retry/budget/cost log,
 * PIN-61) from the composition root; this module never touches a
 * provider. HTTP routes are PIN-65 (53b2); this is the service.
 */
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import type { DecomposeJob, Element, MaskBox, Pin } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import {
  normalizeElements,
  type ElementNamer,
  type NamedElement,
  type Segmenter,
} from "../gateway/ports";
import type { Policy } from "../policy/policy";
import {
  assertDerivativeRef,
  type DerivativeStore,
} from "./derivative-store";
import { processPhoto } from "./photo-intake";
import {
  decodeSegment,
  renderCutout,
  renderFlattened,
  type DecodedSegment,
} from "./sam-mask";

/** Job persistence port. Firestore home boards/{slug}/jobs/{id}. */
export interface DecomposeJobStore {
  /** Stores a new pending job; duplicate id throws RangeError. */
  create(job: DecomposeJob): Promise<void>;
  get(jobId: string): Promise<DecomposeJob | null>;
  /**
   * Atomically flip pending -> running. Returns the claimed job,
   * or null when the job is missing or not pending (already
   * claimed/finished) — the claim-before-call gate.
   */
  claim(jobId: string, now: number): Promise<DecomposeJob | null>;
  /** Replace the stored job (progress + terminal states). */
  update(job: DecomposeJob): Promise<void>;
  /** All jobs on one board, createdAt-ascending (caps + TTL sweep). */
  listForBoard(boardId: string): Promise<DecomposeJob[]>;
}

function cloneJob(job: DecomposeJob): DecomposeJob {
  return structuredClone(job);
}

export class InMemoryDecomposeJobStore implements DecomposeJobStore {
  private jobs = new Map<string, DecomposeJob>();

  async create(job: DecomposeJob): Promise<void> {
    if (this.jobs.has(job.id)) {
      throw new RangeError(`DecomposeJob ${job.id} already exists`);
    }
    this.jobs.set(job.id, cloneJob(job));
  }

  async get(jobId: string): Promise<DecomposeJob | null> {
    const job = this.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  }

  async listForBoard(boardId: string): Promise<DecomposeJob[]> {
    return [...this.jobs.values()]
      .filter((job) => job.boardId === boardId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map(cloneJob);
  }

  async claim(jobId: string, now: number): Promise<DecomposeJob | null> {
    // No awaits between check and write: atomic in-process, the
    // same discipline a Firestore transaction keeps in PIN-65.
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "pending") return null;
    const claimed: DecomposeJob = { ...cloneJob(job), status: "running", updatedAt: now };
    this.jobs.set(jobId, claimed);
    return cloneJob(claimed);
  }

  async update(job: DecomposeJob): Promise<void> {
    if (!this.jobs.has(job.id)) {
      throw new RangeError(`DecomposeJob ${job.id} not found`);
    }
    this.jobs.set(job.id, cloneJob(job));
  }
}

export function buildBoardWorkingRef(boardId: string, jobId: string): string {
  return assertDerivativeRef(`tmp/boards/${boardId}/jobs/${jobId}/working.webp`);
}

export function buildElementCutoutRef(boardId: string, elementId: string): string {
  return assertDerivativeRef(`elements/boards/${boardId}/${elementId}/cutout.png`);
}

export function buildElementFlattenedRef(boardId: string, elementId: string): string {
  return assertDerivativeRef(`elements/boards/${boardId}/${elementId}/flattened.jpg`);
}

/**
 * Re-validate namer output against Policy (ports already normalize;
 * the service never trusts a port blindly): cap at
 * elementsPerPhoto.max, truncate concepts to conceptMaxWords,
 * dedupe by concept, drop concept-less rows.
 */
export function validateNamedElements(
  raw: readonly NamedElement[],
  policy: Policy,
): NamedElement[] {
  return normalizeElements(raw, {
    maxElements: policy.elementsPerPhoto.max,
    conceptMaxWords: policy.conceptMaxWords,
  });
}

/** PIN-50 usable-mask rule, bounds from Policy (default 0.5%-60%). */
export function isUsableMask(coverageFrame: number, policy: Policy): boolean {
  return (
    coverageFrame >= policy.usableMaskFrameFraction.min &&
    coverageFrame <= policy.usableMaskFrameFraction.max
  );
}

/** SAM wire pixel box (inclusive) -> normalized 0..1 MaskBox. */
export function toMaskBox(
  box: DecodedSegment["box"],
  frame: { width: number; height: number },
): MaskBox {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x1: clamp01(box.x1 / frame.width),
    y1: clamp01(box.y1 / frame.height),
    x2: clamp01((box.x2 + 1) / frame.width),
    y2: clamp01((box.y2 + 1) / frame.height),
  };
}

export interface DecomposeDeps {
  boards: BoardRepository;
  jobs: DecomposeJobStore;
  store: DerivativeStore;
  namer: ElementNamer;
  segmenter: Segmenter;
  policy: Policy;
  now?: () => number;
  newId?: () => string;
}

export interface StartDecomposeInput {
  boardId: string;
  participantId: string;
  /** Raw upload bytes; only the stripped intake derivative is stored. */
  bytes: Uint8Array;
}

/**
 * Intake + create the pending job + run it in-request (docs/11
 * A4: request does the work, client polls). PhotoIntakeError from
 * intake propagates before any job or object exists.
 */
export async function startDecomposeJob(
  input: StartDecomposeInput,
  deps: DecomposeDeps,
): Promise<DecomposeJob> {
  const now = deps.now ?? Date.now;
  const board = await deps.boards.getBoard(input.boardId);
  if (!board) throw new RangeError(`Board ${input.boardId} not found`);
  const participant = await deps.boards.getParticipant(
    input.boardId,
    input.participantId,
  );
  if (!participant) {
    throw new RangeError(`Participant ${input.participantId} not found`);
  }

  const processed = await processPhoto(input.bytes);
  const jobId = (deps.newId ?? randomUUID)();
  const workingRef = buildBoardWorkingRef(input.boardId, jobId);
  // Only the stripped derivative is ever written; input.bytes (the
  // original upload) is not stored anywhere (privacy invariant).
  await deps.store.put(workingRef, processed.derivative, processed.contentType);

  const at = now();
  const job: DecomposeJob = {
    id: jobId,
    boardId: input.boardId,
    participantId: input.participantId,
    status: "pending",
    workingRef,
    promptVersion: deps.policy.promptVersions.elements,
    elementIds: [],
    pinIds: [],
    faceNote: false,
    failedConceptCount: 0,
    createdAt: at,
    updatedAt: at,
  };
  try {
    await deps.jobs.create(job);
  } catch (cause) {
    await deps.store.delete(workingRef).catch(() => undefined);
    throw cause;
  }
  return runDecomposeJob(jobId, deps);
}

async function finish(
  deps: DecomposeDeps,
  job: DecomposeJob,
  status: DecomposeJob["status"],
  errorCode?: string,
): Promise<DecomposeJob> {
  const done: DecomposeJob = {
    ...job,
    status,
    ...(errorCode ? { errorCode } : {}),
    updatedAt: (deps.now ?? Date.now)(),
  };
  await deps.jobs.update(done);
  return cloneJob(done);
}

/**
 * Run one pending job. Idempotent: a job that is already running
 * or in a terminal state is returned as-is without any port call.
 * Port refusals/failures become the job's typed terminal state,
 * never a throw; only a missing job throws RangeError.
 */
export async function runDecomposeJob(
  jobId: string,
  deps: DecomposeDeps,
): Promise<DecomposeJob> {
  const now = deps.now ?? Date.now;
  const job = await deps.jobs.claim(jobId, now());
  if (!job) {
    const existing = await deps.jobs.get(jobId);
    if (!existing) throw new RangeError(`DecomposeJob ${jobId} not found`);
    return existing; // already claimed or finished: no duplicate work
  }
  const { policy } = deps;

  try {
    const working = await deps.store.get(job.workingRef);
    if (!working) return finish(deps, job, "failed", "working_copy_missing");
    const meta = await sharp(Buffer.from(working)).metadata();
    const frame = { width: meta.width ?? 0, height: meta.height ?? 0 };
    if (!(frame.width > 0 && frame.height > 0)) {
      return finish(deps, job, "failed", "working_copy_unreadable");
    }
    const imageRef = `data:image/webp;base64,${Buffer.from(working).toString("base64")}`;

    const named = await deps.namer.nameElements({
      imageRef,
      minElements: policy.elementsPerPhoto.min,
      maxElements: policy.elementsPerPhoto.max,
      conceptMaxWords: policy.conceptMaxWords,
      maxTokens: policy.maxTokens.sparkElements,
      timeoutMs: policy.timeoutsMs.spark,
      promptVersion: policy.promptVersions.elements,
      boardId: job.boardId,
      participantId: job.participantId,
    });
    if (named.status !== "ready") {
      return finish(
        deps,
        job,
        named.status,
        named.errorCode ?? (named.status === "refused" ? "refused" : "namer_failed"),
      );
    }
    job.promptVersion = named.value.promptVersion;

    const validated = validateNamedElements(named.value.elements, policy);
    job.faceNote =
      policy.faces === "note" && validated.some((e) => e.faceFlag);
    // faces=block drops face elements before any SAM spend; the
    // default faces=note keeps them and only raises the note flag.
    const kept =
      policy.faces === "block"
        ? validated.filter((e) => !e.faceFlag)
        : validated;
    if (kept.length === 0) {
      return finish(deps, job, "failed", "no_elements");
    }
    await deps.jobs.update({ ...job, updatedAt: now() });

    let refusedCount = 0;
    // Serialize progress writes so parallel landings cannot
    // overwrite each other's elementIds/pinIds snapshots.
    let persistChain: Promise<void> = Promise.resolve();
    const persistProgress = (): Promise<void> => {
      persistChain = persistChain.then(() =>
        deps.jobs.update({ ...cloneJob(job), updatedAt: now() }),
      );
      return persistChain;
    };

    const runConcept = async (element: NamedElement, index: number) => {
      const outcome = await deps.segmenter.segment({
        imageRef,
        prompt: { kind: "concept", concept: element.concept },
        timeoutMs: policy.timeoutsMs.sam,
        boardId: job.boardId,
        participantId: job.participantId,
      });
      if (outcome.status !== "ready") {
        if (outcome.status === "refused") refusedCount += 1;
        job.failedConceptCount += 1;
        return;
      }
      const usable = outcome.value.segments
        .map((segment) => {
          try {
            return decodeSegment(segment, frame);
          } catch {
            return null;
          }
        })
        .filter((d): d is DecodedSegment => d !== null)
        .filter((d) => d.maskPixels > 0 && isUsableMask(d.coverageFrame, policy))
        .sort((a, b) => b.maskPixels - a.maskPixels)[0];
      if (!usable) {
        job.failedConceptCount += 1;
        return;
      }

      const elementId = `${job.id}-el${index}`;
      const cutoutRef = buildElementCutoutRef(job.boardId, elementId);
      const flattenedRef = buildElementFlattenedRef(job.boardId, elementId);
      const cutout = await renderCutout(working, usable);
      const flattened = await renderFlattened(cutout, {
        maxPx: policy.flattenedMaxPx,
        paddingFraction: policy.flattenedPaddingFraction,
      });
      await deps.store.put(cutoutRef, cutout, "image/png");
      await deps.store.put(flattenedRef, flattened, "image/jpeg");

      // Deterministic ids + existence checks: even if this concept
      // somehow runs twice, no duplicate element/pin is created.
      const at = now();
      const elementRecord: Element = {
        id: elementId,
        boardId: job.boardId,
        ownerId: job.participantId,
        label: element.label,
        description: element.description,
        maskBox: toMaskBox(usable.box, frame),
        cutoutRef,
        flattenedRef,
        sourcePhotoId: job.id,
        faceFlag: element.faceFlag,
        createdAt: at,
      };
      if (!(await deps.boards.getElement(elementId))) {
        await deps.boards.createElement(elementRecord);
      }
      const existingPins = await deps.boards.listPinsForElement(elementId);
      const existingPin = existingPins.find((p) => p.boardId === job.boardId);
      let pinId = existingPin?.id;
      if (!pinId) {
        pinId = `${job.id}-pin${index}`;
        const pin: Pin = {
          id: pinId,
          boardId: job.boardId,
          elementId,
          pinnedBy: job.participantId,
          status: "candidate",
          createdAt: at,
        };
        await deps.boards.createPin(pin);
      }
      if (!job.elementIds.includes(elementId)) job.elementIds.push(elementId);
      if (!job.pinIds.includes(pinId)) job.pinIds.push(pinId);
      await persistProgress(); // pop-in: visible to pollers now
    };

    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(policy.samConcurrency, kept.length) },
      async () => {
        while (nextIndex < kept.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            await runConcept(kept[index], index);
          } catch {
            // One concept's render/store failure keeps the others.
            job.failedConceptCount += 1;
          }
        }
      },
    );
    await Promise.all(workers);
    await persistChain.catch(() => undefined);

    if (job.pinIds.length > 0) return finish(deps, job, "ready");
    if (refusedCount > 0 && refusedCount === kept.length) {
      return finish(deps, job, "refused", "segment_refused");
    }
    return finish(deps, job, "failed", "no_usable_pins");
  } catch {
    // Unexpected service failure: typed terminal state, and any
    // candidate pins already persisted above stay persisted.
    return finish(deps, job, "failed", "decompose_failed");
  }
}
