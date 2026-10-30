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
  type TapNamer,
} from "../gateway/ports";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import type { CreditLedgerStore } from "../domain/credit-ledger";
import {
  CREDIT_DEBIT_FAILED,
  CREDITS_POOL_EMPTY,
  creditsEnabled,
  photoDebitEventId,
  tryDebitMake,
} from "./credit-pool";
import {
  assertDerivativeRef,
  type DerivativeStore,
} from "./derivative-store";
import { ELEMENT_CUTOUT_FILE, sweepDeletedBoardStorage } from "./board-storage";
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
  return assertDerivativeRef(`elements/boards/${boardId}/${elementId}/${ELEMENT_CUTOUT_FILE}`);
}

export function buildElementFlattenedRef(boardId: string, elementId: string): string {
  return assertDerivativeRef(`elements/boards/${boardId}/${elementId}/flattened.jpg`);
}

/**
 * Re-validate namer output against Policy (ports already normalize;
 * the service never trusts a port blindly): cap at
 * elementsPerPhoto.max, truncate concepts to conceptMaxWords and
 * labels to elementLabelMaxChars, dedupe by concept, drop
 * concept-less rows.
 */
export function validateNamedElements(
  raw: readonly NamedElement[],
  policy: Policy,
): NamedElement[] {
  return normalizeElements(raw, {
    maxElements: policy.elementsPerPhoto.max,
    conceptMaxWords: policy.conceptMaxWords,
    labelMaxChars: policy.elementLabelMaxChars,
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
  /** PIN-117 tap naming; absent port = generic-label fallback. */
  tapNamer?: TapNamer;
  policy: Policy;
  now?: () => number;
  newId?: () => string;
  /** Makes ledger (PIN-151); only touched while Policy.credits.enabled. */
  credits?: CreditLedgerStore;
  /** PIN-137: signed-in user snapshot resolved at request time (null = link-only). */
  userIdAtCall?: string | null;
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
  return runDecomposeJob(jobId, { ...deps, userIdAtCall: participant.userId ?? null });
}

/**
 * Remove this job's candidate pins + elements before a failed
 * terminal write (PIN-151): a photo whose make could not be
 * debited must not stay confirmable for free. Runs while the
 * stored job is still `running` (confirm 409s, taps refuse), so
 * nothing can pin mid-cleanup. Storage deletes are best-effort
 * per object, like deleteMyElement: once the records are gone an
 * orphaned object is unreachable through any route.
 */
async function discardJobCandidates(deps: DecomposeDeps, job: DecomposeJob): Promise<void> {
  for (const elementId of job.elementIds) {
    const element = await deps.boards.getElement(elementId).catch(() => null);
    await deps.boards.deleteElement(elementId).catch(() => undefined);
    if (!element) continue;
    for (const ref of [element.cutoutRef, element.flattenedRef]) {
      if (!ref.startsWith("elements/")) continue;
      await deps.store.delete(ref).catch(() => undefined);
    }
  }
  job.elementIds = [];
  job.pinIds = [];
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
  // PIN-169: on a board deleted mid-run the records were refused, but
  // objects may have landed after the delete's sweep. A live board: no-op.
  await sweepDeletedBoardStorage(done.boardId, deps);
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
  // PIN-151: set the moment this job's make is spent, so a later
  // terminal-write failure never discards a paid result.
  let makeDebited = false;

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
      labelMaxChars: policy.elementLabelMaxChars,
      maxTokens: policy.maxTokens.sparkElements,
      timeoutMs: policy.timeoutsMs.spark,
      promptVersion: policy.promptVersions.elements,
      boardId: job.boardId,
      participantId: job.participantId,
      userIdAtCall: deps.userIdAtCall ?? null,
      photoId: job.id,
      jobId: job.id,
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
        photoId: job.id,
        timeoutMs: policy.timeoutsMs.sam,
        boardId: job.boardId,
        participantId: job.participantId,
        userIdAtCall: deps.userIdAtCall ?? null,
        jobId: job.id,
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

    if (job.pinIds.length > 0) {
      // PIN-151 debit seam (exact): the one make for this photo is
      // debited here — after at least one candidate pin landed,
      // before the job may finish `ready`, under the job's
      // deterministic debit event id. The preflight in board-api
      // uploadPhoto keeps an empty pool from ever reaching this
      // run; if a concurrent make drained the last credit while
      // this job ran, the debit refuses atomically, the candidate
      // pins are discarded (still `running`, so unconfirmable)
      // and the job fails `credits_pool_empty` instead of
      // exposing a free make. Disabled = no ledger call at all.
      let debit: Awaited<ReturnType<typeof tryDebitMake>>;
      try {
        debit = await tryDebitMake(job.boardId, photoDebitEventId(job.id), deps);
      } catch {
        await discardJobCandidates(deps, job);
        return finish(deps, job, "failed", CREDIT_DEBIT_FAILED);
      }
      makeDebited = debit === "debited";
      if (debit === "pool_empty") {
        await discardJobCandidates(deps, job);
        return finish(deps, job, "failed", CREDITS_POOL_EMPTY);
      }
      // awaited (not bare return) so a terminal-write failure
      // reaches the paid-make retry in the catch below.
      return await finish(deps, job, "ready");
    }
    if (refusedCount > 0 && refusedCount === kept.length) {
      return finish(deps, job, "refused", "segment_refused");
    }
    return finish(deps, job, "failed", "no_usable_pins");
  } catch {
    // Unexpected service failure: typed terminal state, and any
    // candidate pins already persisted above stay persisted.
    // PIN-151: a paid make is never discarded — if the ready
    // write itself threw, retry it once here; a second throw
    // propagates with the job and its pins still stored.
    if (makeDebited) return finish(deps, job, "ready");
    // PIN-151: while credits are on, candidates from a job that
    // never reached the debit seam are not left confirmable for
    // free; while off, the PIN-64 keep-what-landed rule stands.
    if (creditsEnabled(deps.policy) && job.pinIds.length > 0) {
      await discardJobCandidates(deps, job);
    }
    return finish(deps, job, "failed", "decompose_failed");
  }
}

export interface TapPoint {
  x: number;
  y: number;
}

/**
 * Tap-to-add outcome (PIN-78). Every refusal/failure is typed data
 * for the API layer to map to a friendly line — never a throw and
 * never a 500 for a provider outcome.
 */
export type TapAddOutcome =
  | { status: "ready"; job: DecomposeJob; element: Element; pin: Pin }
  | { status: "not_found" }
  | { status: "job_not_ready" }
  | { status: "working_copy_gone" }
  | { status: "cap_reached" }
  | { status: "no_usable_mask" }
  | { status: "failed" | "refused"; errorCode?: string };

/**
 * Tap-to-add (PIN-78, docs/11 sections 5.7/6): one normalized
 * point on the job's still-live working copy -> Segmenter point
 * prompt (PIN-60 buildObjectPrompt via the decorated port) ->
 * the same Policy usable-mask gate as concepts -> cut-out +
 * flattened -> one candidate pin appended to the SAME job, so
 * "Pin N" confirms tap-adds with the rest and A6a still deletes
 * the working copy at confirm.
 *
 * Pre-confirm only: a deleted or TTL-expired working copy is
 * `working_copy_gone` (an expired copy is deleted + marked here,
 * mirroring the board-api sweep). Only a `ready` job accepts
 * taps — a running job's in-flight persist chain owns
 * elementIds/pinIds, so taps wait for it to land. The
 * elementsPerPhoto.max cap counts every element already on the
 * job (concept + tap) and is checked BEFORE any SAM spend, then
 * re-checked against a fresh read before appending; a lost
 * late race cleans up its just-created element/pin/storage.
 * The element cap alone does not bound SPEND: a tap that fails
 * or finds no usable mask adds no element. PIN-92 closes that —
 * the decorated Segmenter reserves every invocation (concept,
 * tap, retry, failure) against Policy segmentsPerPhoto /
 * segmentsPerParticipantPerDay before the provider call, and a
 * cap denial surfaces here as the same `cap_reached` stop.
 *
 * Label (PIN-117): the flattened crop goes through the
 * TapNamer port (prompts/tap-name.v1.md, one Spark vision
 * call on the single cut-out) for a real label, description
 * and faceFlag — so a tapped person gets the face note. The
 * call reserves under its own Policy counter
 * (tapNamesPerParticipantPerDay), never the photo quota. The
 * generic i18n label remains only as the typed fallback.
 */
export async function addTapElement(
  jobId: string,
  point: TapPoint,
  genericLabel: string,
  deps: DecomposeDeps,
): Promise<TapAddOutcome> {
  const now = deps.now ?? Date.now;
  const { policy } = deps;
  const job = await deps.jobs.get(jobId);
  if (!job) return { status: "not_found" };
  if (job.status !== "ready") return { status: "job_not_ready" };
  if (job.workingDeletedAt !== undefined) return { status: "working_copy_gone" };
  const at = now();
  if (at - job.createdAt >= policy.workingCopyTtlHours * 60 * 60 * 1000) {
    await deps.store.delete(job.workingRef).catch(() => undefined);
    await deps.jobs
      .update({ ...job, workingDeletedAt: at, updatedAt: at })
      .catch(() => undefined);
    return { status: "working_copy_gone" };
  }
  if (job.elementIds.length >= policy.elementsPerPhoto.max) {
    return { status: "cap_reached" };
  }

  const working = await deps.store.get(job.workingRef);
  if (!working) return { status: "working_copy_gone" };
  let frame: { width: number; height: number };
  try {
    const meta = await sharp(Buffer.from(working)).metadata();
    frame = { width: meta.width ?? 0, height: meta.height ?? 0 };
  } catch {
    return { status: "failed", errorCode: "working_copy_unreadable" };
  }
  if (!(frame.width > 0 && frame.height > 0)) {
    return { status: "failed", errorCode: "working_copy_unreadable" };
  }
  const imageRef = `data:image/webp;base64,${Buffer.from(working).toString("base64")}`;

  const outcome = await deps.segmenter.segment({
    imageRef,
    photoId: job.id,
    prompt: {
      kind: "point",
      points: [{ x: point.x, y: point.y, label: "positive" }],
      frame,
    },
    timeoutMs: policy.timeoutsMs.sam,
    boardId: job.boardId,
    participantId: job.participantId,
    userIdAtCall: deps.userIdAtCall ?? null,
    jobId: job.id,
  });
  if (outcome.status !== "ready") {
    // PIN-92: a segment-cap denial is the same friendly stop as
    // the element cap, not a failure.
    if (outcome.errorCode === "participant_cap" || outcome.errorCode === "photo_cap") {
      return { status: "cap_reached" };
    }
    return {
      status: outcome.status,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    };
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
  if (!usable) return { status: "no_usable_mask" };

  let tapIndex = job.elementIds.filter((id) => id.includes("-tap")).length;
  let elementId = `${job.id}-tap${tapIndex}`;
  while (await deps.boards.getElement(elementId)) {
    tapIndex += 1;
    elementId = `${job.id}-tap${tapIndex}`;
  }
  const cutoutRef = buildElementCutoutRef(job.boardId, elementId);
  const flattenedRef = buildElementFlattenedRef(job.boardId, elementId);
  let element: Element;
  let pin: Pin;
  try {
    const cutout = await renderCutout(working, usable);
    const flattened = await renderFlattened(cutout, {
      maxPx: policy.flattenedMaxPx,
      paddingFraction: policy.flattenedPaddingFraction,
    });
    await deps.store.put(cutoutRef, cutout, "image/png");
    await deps.store.put(flattenedRef, flattened, "image/jpeg");
    // PIN-117: name the crop (tap-name.v1 via the decorated
    // TapNamer). Any non-ready outcome — refusal, failure, cap
    // denial, absent port — keeps the generic i18n label and
    // faceFlag:false; naming never fails the tap.
    let label = genericLabel.trim() || t("en", "add.tapLabel");
    let description = label;
    let faceFlag = false;
    if (deps.tapNamer) {
      try {
        const named = await deps.tapNamer.nameOne({
          imageRef: `data:image/jpeg;base64,${Buffer.from(flattened).toString("base64")}`,
          conceptMaxWords: policy.conceptMaxWords,
          labelMaxChars: policy.elementLabelMaxChars,
          maxTokens: policy.maxTokens.sparkTapName,
          timeoutMs: policy.timeoutsMs.spark,
          promptVersion: policy.promptVersions.tapName,
          boardId: job.boardId,
          participantId: job.participantId,
          userIdAtCall: deps.userIdAtCall ?? null,
          photoId: job.id,
          jobId: job.id,
        });
        if (named.status === "ready" && named.value.name.label) {
          label = named.value.name.label;
          description = named.value.name.description || label;
          faceFlag = named.value.name.faceFlag;
        }
      } catch {
        // Fall through to the generic label.
      }
    }
    element = {
      id: elementId,
      boardId: job.boardId,
      ownerId: job.participantId,
      label,
      description,
      maskBox: toMaskBox(usable.box, frame),
      cutoutRef,
      flattenedRef,
      sourcePhotoId: job.id,
      faceFlag,
      createdAt: at,
    };
    await deps.boards.createElement(element);
    pin = {
      id: `${job.id}-tappin${tapIndex}`,
      boardId: job.boardId,
      elementId,
      pinnedBy: job.participantId,
      status: "candidate",
      createdAt: at,
    };
    await deps.boards.createPin(pin);
  } catch {
    // PIN-169: a board deleted mid-tap refuses the records after the
    // objects landed; sweep them (a no-op on a live board).
    await sweepDeletedBoardStorage(job.boardId, deps);
    return { status: "failed", errorCode: "tap_add_failed" };
  }

  // Fresh re-read before appending: confirm (A6a delete) or a
  // parallel tap may have landed while SAM ran.
  const fresh = await deps.jobs.get(jobId);
  const cleanup = async (result: TapAddOutcome): Promise<TapAddOutcome> => {
    await deps.boards.deleteElement(elementId).catch(() => undefined);
    await deps.store.delete(cutoutRef).catch(() => undefined);
    await deps.store.delete(flattenedRef).catch(() => undefined);
    return result;
  };
  if (!fresh) return cleanup({ status: "not_found" });
  if (fresh.workingDeletedAt !== undefined) {
    return cleanup({ status: "working_copy_gone" });
  }
  if (fresh.elementIds.length >= policy.elementsPerPhoto.max) {
    return cleanup({ status: "cap_reached" });
  }
  const updated: DecomposeJob = {
    ...fresh,
    // PIN-117: a tapped face raises the same consent note the
    // concept pass sets (runDecomposeJob); the Add sheet banner
    // reads job.faceNote, not the element flag.
    faceNote: fresh.faceNote || (policy.faces === "note" && element.faceFlag),
    elementIds: fresh.elementIds.includes(elementId)
      ? fresh.elementIds
      : [...fresh.elementIds, elementId],
    pinIds: fresh.pinIds.includes(pin.id)
      ? fresh.pinIds
      : [...fresh.pinIds, pin.id],
    updatedAt: now(),
  };
  await deps.jobs.update(updated);
  return { status: "ready", job: cloneJob(updated), element, pin };
}
