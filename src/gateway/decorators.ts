import "server-only";
/**
 * Decorator chain for every capability port (docs/11 section 5.2,
 * PIN-61): timeout (Policy) -> retry once on 429/5xx with backoff
 * -> reserve budget (fail closed) -> call -> AiCallLog with
 * promptVersion + cost -> ready/failed/refused outcome.
 *
 * Execution order per logical call: reserve once, then each attempt
 * runs under the timeout; a retry reuses the reservation (429/5xx
 * attempts are not billed by the provider, and the reserve estimate
 * is conservative). Over budget is a friendly `failed` outcome —
 * never a silent mock swap, never a throw. Timeout outcomes are
 * never retried. Segmenter is the reserve exception (PIN-92): it
 * reserves PER ATTEMPT, so concept, tap-add and retry invocations
 * all count against its per-participant/per-photo caps — a failed
 * or refused call consumed its reservation exactly like a ready
 * one, and the AiCallLog below still records every logical call
 * that reached the provider.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { AiCallLog } from "../domain/types";
import { t } from "../i18n";
import type { Policy } from "../policy/policy";
import {
  dayBucketFor,
  hourBucketFor,
  type BudgetStore,
  type ReserveDenyReason,
  type ReserveResult,
} from "./budget";
import {
  estimateMetaCostUsd,
  estimateReserveMicroUsd,
  estimateReserveUsd,
  usdToMicroUsd,
  type PortOperation,
} from "./costs";
import type { MetaCallLog } from "./meta-gateway";
import {
  classifyPortError,
  type ElementNamer,
  type PortOutcome,
  type SceneComposer,
  type TapNamer,
  type SpeechTranscriber,
  type ChipSuggester,
  type Segmenter,
} from "./ports";

/**
 * Meta transport logs are captured per logical port call so the
 * decorator can price ONE AiCallLog from real token usage. The
 * composition root passes `collectMetaCallLog` as the gateway
 * onLog; outside a decorated call it is a no-op.
 */
const metaLogCollector = new AsyncLocalStorage<MetaCallLog[]>();

export function collectMetaCallLog(entry: MetaCallLog): void {
  metaLogCollector.getStore()?.push(entry);
}

export interface PortDecoratorDeps {
  policy: Policy;
  budget: BudgetStore;
  appendLog: (log: AiCallLog) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  /** Log-write failures surface here; the call outcome is unchanged
   *  because spend was already counted at reserve time. */
  onLogError?: (cause: unknown) => void;
}

interface CallMeta {
  operation: PortOperation;
  model: string;
  promptVersion?: string;
  timeoutMs: number;
  boardId?: string;
  participantId?: string;
  /** PIN-137 attribution for AiCallLog v2. */
  userIdAtCall?: string | null;
  sceneId?: string;
  jobId?: string;
  /** PIN-136: photo (ElementNamer) vs scene (SceneComposer) caps use separate counters. */
  participantPhotoCap?: number;
  participantSceneCap?: number;
  boardCap?: number;
  /** PIN-117: TapNamer-only per-participant cap (own counter). */
  participantTapNameCap?: number;
  /** PIN-119: SpeechTranscriber-only cap + clip seconds for pricing. */
  participantTranscriptionCap?: number;
  audioSeconds?: number;
  /** PIN-92: Segmenter-only per-participant / per-photo caps. */
  participantSegmentCap?: number;
  photoId?: string;
  photoCap?: number;
  /** PIN-92: reserve before EVERY attempt so retries count too. */
  reservePerAttempt?: boolean;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** Counter-doc field paths need dot-free ids; drop anything else. */
function safeId(id: string | undefined): string | undefined {
  return id && SAFE_ID.test(id) ? id : undefined;
}

function deniedOutcome<T>(reason: ReserveDenyReason | "budget_unavailable"): PortOutcome<T> {
  const messages = {
    off: t("en", "ai.budgetOff"),
    call_limit: t("en", "ai.budgetExhausted"),
    budget: t("en", "ai.budgetExhausted"),
    hourly_budget: t("en", "ai.budgetExhausted"),
    participant_cap: t("en", "ai.participantCap"),
    board_cap: t("en", "ai.boardCap"),
    photo_cap: t("en", "ai.photoCap"),
    budget_unavailable: t("en", "ai.failed"),
  } as const;
  return {
    status: "failed",
    errorCode: reason === "off" ? "budget_off" : reason,
    message: messages[reason],
  };
}

function isRetryable<T>(outcome: PortOutcome<T>): boolean {
  if (outcome.status !== "failed") return false;
  if (outcome.errorCode === "timeout") return false;
  if (outcome.httpStatus !== undefined) {
    return outcome.httpStatus === 429 || outcome.httpStatus >= 500;
  }
  return (
    /^http_(429|5\d\d)$/.test(outcome.errorCode ?? "") ||
    outcome.errorCode === "rate_limit" ||
    outcome.errorCode === "rate_limited" ||
    outcome.errorCode === "overloaded"
  );
}

async function withTimeout<T>(
  call: () => Promise<PortOutcome<T>>,
  timeoutMs: number,
): Promise<PortOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PortOutcome<T>>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "failed",
          errorCode: "timeout",
          message: t("en", "ai.timeout"),
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      (async () => {
        try {
          return await call();
        } catch (cause) {
          return classifyPortError(cause);
        }
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runDecorated<T>(
  deps: Required<Omit<PortDecoratorDeps, "policy" | "budget" | "appendLog">> &
    Pick<PortDecoratorDeps, "policy" | "budget" | "appendLog">,
  meta: CallMeta,
  call: () => Promise<PortOutcome<T>>,
): Promise<PortOutcome<T>> {
  const { policy } = deps;
  const startedAt = deps.now();
  const dayBucket = dayBucketFor(startedAt);
  const hourBucket = hourBucketFor(startedAt);
  const boardId = safeId(meta.boardId);
  const participantId = safeId(meta.participantId);
  const photoId = safeId(meta.photoId);
  const sceneId = safeId(meta.sceneId);
  const jobId = safeId(meta.jobId);
  const userIdAtCall = meta.userIdAtCall ? safeId(meta.userIdAtCall) ?? null : null;
  const reserveLimits = {
    sparkElementsMaxTokens: policy.maxTokens.sparkElements,
    sparkChipsMaxTokens: policy.maxTokens.sparkChips,
    sparkTapNameMaxTokens: policy.maxTokens.sparkTapName,
    voiceMaxSeconds: policy.dictationMaxSeconds,
    voiceSeconds: meta.audioSeconds,
  };
  const reservedPerReserveMicroUsd = estimateReserveMicroUsd(meta.operation, reserveLimits);
  let reservedMicroUsd = 0;
  let denialReason: string | undefined;

  const writeLog = async (partial: {
    outcome: AiCallLog["outcome"];
    attempt: number;
    attempts: number;
    costEstimateUsd: number;
    collected: MetaCallLog[];
    reservedMicroUsd: number;
    denialReason?: string;
  }): Promise<void> => {
    const finishedAt = deps.now();
    const sum = (pick: (e: MetaCallLog) => number | undefined) =>
      partial.collected.reduce((acc, e) => acc + (pick(e) ?? 0), 0);
    const audioSeconds = sum((e) => e.audioSeconds) || (meta.audioSeconds ? Math.ceil(meta.audioSeconds) : undefined);
    try {
      await deps.appendLog({
        id: deps.newId(),
        schemaVersion: 2,
        ...(boardId ? { gameId: boardId, boardId } : {}),
        ...(participantId ? { participantId } : {}),
        userIdAtCall,
        ...(sceneId ? { sceneId } : {}),
        ...(photoId ? { photoId } : {}),
        ...(jobId ? { jobId } : {}),
        operation: meta.operation,
        model: partial.collected[0]?.model ?? meta.model,
        ...(meta.promptVersion ? { promptVersion: meta.promptVersion } : {}),
        inputTokens: sum((e) => e.inputTokens) || undefined,
        outputTokens: sum((e) => e.outputTokens) || undefined,
        images: sum((e) => e.images) || undefined,
        ...(audioSeconds ? { audioSeconds } : {}),
        latencyMs: Math.max(0, finishedAt - startedAt),
        costEstimateUsd: partial.costEstimateUsd,
        costMicroUsdEst: usdToMicroUsd(partial.costEstimateUsd),
        reservedMicroUsd: partial.reservedMicroUsd,
        attempt: partial.attempt,
        attempts: partial.attempts,
        ...(partial.denialReason ? { denialReason: partial.denialReason } : {}),
        outcome: partial.outcome,
        dayBucket,
        createdAt: finishedAt,
        expireAt: finishedAt + policy.aiCallLogRetentionDays * 86_400_000,
      });
    } catch (cause) {
      deps.onLogError(cause);
    }
  };

  const tryReserve = async (): Promise<ReserveResult | "unavailable"> => {
    try {
      return await deps.budget.reserve({
        dayBucket,
        estimatedCostUsd: estimateReserveUsd(meta.operation, reserveLimits),
        budgetUsd: policy.dailyBudgetUsd,
        hourBucket,
        hourlyBudgetUsd: policy.hourlyBudgetUsd,
        callLimit: policy.dailyCallLimit,
        participantId,
        participantPhotoCap: participantId ? meta.participantPhotoCap : undefined,
        participantSceneCap: participantId ? meta.participantSceneCap : undefined,
        boardId,
        boardCap: boardId ? meta.boardCap : undefined,
        participantSegmentCap: participantId ? meta.participantSegmentCap : undefined,
        participantTapNameCap: participantId ? meta.participantTapNameCap : undefined,
        participantTranscriptionCap: participantId ? meta.participantTranscriptionCap : undefined,
        photoId,
        photoCap: photoId ? meta.photoCap : undefined,
      });
    } catch {
      return "unavailable";
    }
  };

  const collected: MetaCallLog[] = [];
  let outcome: PortOutcome<T> = { status: "failed", errorCode: "not_run" };
  let attemptsRun = 0;
  let lastAttempt = 0;
  for (let attempt = 0; attempt <= policy.retries; attempt += 1) {
    lastAttempt = attempt;
    if (attempt > 0) await deps.sleep(policy.retryBackoffMs);
    if (attempt === 0 || meta.reservePerAttempt) {
      const reserve = await tryReserve();
      if (reserve === "unavailable" || !reserve.ok) {
        denialReason = reserve === "unavailable" ? "budget_unavailable" : reserve.reason;
        const denied = deniedOutcome<T>(
          reserve === "unavailable" ? "budget_unavailable" : reserve.reason,
        );
        // PIN-137: denials are logged (one denied_* record) even
        // before any provider call; the outcome stays fail-closed.
        if (attemptsRun === 0) {
          await writeLog({
            outcome: denialReason === "off" ? "denied_off" : (`denied_${denialReason}` as AiCallLog["outcome"]),
            attempt,
            attempts: 0,
            costEstimateUsd: 0,
            collected,
            reservedMicroUsd: 0,
            denialReason,
          });
          return denied;
        }
        outcome = denied;
        break;
      }
      reservedMicroUsd += reserve.estimatedMicroUsd ?? reservedPerReserveMicroUsd;
    }
    attemptsRun += 1;
    outcome = await metaLogCollector.run(collected, () =>
      withTimeout(call, meta.timeoutMs),
    );
    if (outcome.status !== "failed" || !isRetryable(outcome)) break;
  }

  const costEstimateUsd = collected.reduce((acc, e) => acc + estimateMetaCostUsd(e), 0);
  await writeLog({
    outcome:
      denialReason && attemptsRun > 0
        ? (denialReason === "off" ? "denied_off" : (`denied_${denialReason}` as AiCallLog["outcome"]))
        : outcome.status === "ready"
          ? "ok"
          : outcome.status === "refused"
            ? "refused"
            : "error",
    attempt: lastAttempt,
    attempts: attemptsRun,
    costEstimateUsd,
    collected,
    reservedMicroUsd,
    ...(denialReason ? { denialReason } : {}),
  });
  return outcome;
}

export interface DecoratedPorts {
  elementNamer: ElementNamer;
  segmenter: Segmenter;
  sceneComposer?: SceneComposer;
  chipSuggester?: ChipSuggester;
  tapNamer?: TapNamer;
  speechTranscriber?: SpeechTranscriber;
}

/** Wrap base ports (Meta/mock/fixture) in the PIN-61 chain. */
export function decoratePorts(
  base: DecoratedPorts,
  deps: PortDecoratorDeps,
): DecoratedPorts {
  const full = {
    ...deps,
    now: deps.now ?? Date.now,
    sleep:
      deps.sleep ??
      ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    newId: deps.newId ?? randomUUID,
    onLogError:
      deps.onLogError ??
      ((cause: unknown) => console.error("AiCallLog write failed", cause)),
  };
  const { policy } = deps;
  const ports: DecoratedPorts = {
    elementNamer: {
      nameElements: (input) =>
        runDecorated(
          full,
          {
            operation: "nameElements",
            model: policy.models.spark,
            promptVersion: input.promptVersion,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
            photoId: input.photoId,
            jobId: input.jobId,
            participantPhotoCap: policy.photosPerParticipantPerDay,
          },
          () => base.elementNamer.nameElements(input),
        ),
    },
    segmenter: {
      segment: (input) =>
        runDecorated(
          full,
          {
            operation: "segment",
            model: policy.models.sam,
            participantSegmentCap: policy.segmentsPerParticipantPerDay,
            photoId: input.photoId,
            photoCap: policy.segmentsPerPhoto,
            reservePerAttempt: true,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
            jobId: input.jobId,
          },
          () => base.segmenter.segment(input),
        ),
    },
  };
  if (base.sceneComposer) {
    const composer = base.sceneComposer;
    ports.sceneComposer = {
      composeScene: (input) =>
        runDecorated(
          full,
          {
            operation: "composeScene",
            model: policy.models.image,
            promptVersion: input.promptVersion,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
            sceneId: input.sceneId,
            jobId: input.jobId,
            participantSceneCap: policy.scenesPerParticipantPerDay,
            boardCap: policy.scenesPerBoardPerDay,
          },
          () => composer.composeScene(input),
        ),
    };
  }
  if (base.chipSuggester) {
    const suggester = base.chipSuggester;
    ports.chipSuggester = {
      suggestChips: (input) =>
        runDecorated(
          full,
          {
            operation: "suggestChips",
            model: policy.models.spark,
            promptVersion: input.promptVersion,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
          },
          () => suggester.suggestChips(input),
        ),
    };
  }
  if (base.tapNamer) {
    const tapNamer = base.tapNamer;
    ports.tapNamer = {
      nameOne: (input) =>
        runDecorated(
          full,
          {
            operation: "nameOne",
            model: policy.models.spark,
            promptVersion: input.promptVersion,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
            photoId: input.photoId,
            jobId: input.jobId,
            participantTapNameCap: policy.tapNamesPerParticipantPerDay,
          },
          () => tapNamer.nameOne(input),
        ),
    };
  }
  if (base.speechTranscriber) {
    const transcriber = base.speechTranscriber;
    ports.speechTranscriber = {
      transcribe: (input) =>
        runDecorated(
          full,
          {
            operation: "transcribe",
            model: policy.models.voice,
            timeoutMs: input.timeoutMs,
            boardId: input.boardId,
            participantId: input.participantId,
            userIdAtCall: input.userIdAtCall,
            participantTranscriptionCap: policy.dictationsPerParticipantPerDay,
            audioSeconds: input.durationSeconds,
          },
          () => transcriber.transcribe(input),
        ),
    };
  }
  return ports;
}
