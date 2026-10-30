import "server-only";
/**
 * Generated suggestion chips service (PIN-75, docs/11 Q10 + s6).
 *
 * Read path is cache-first: a fresh entry for the sorted
 * lowercased label set (Policy.chipsCacheTtlHours) answers with
 * zero model calls. A miss goes through the decorated
 * ChipSuggester port (PIN-61 timeout/retry/budget/log) and only a
 * ready, non-empty outcome is cached. Refused, failed and
 * budget-denied outcomes — and a missing port or a broken cache —
 * all degrade to the fixed Policy chip list: chips never block or
 * break Make a scene.
 */
import type { Participant } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { chipsCacheKeyBase, isChipsCacheFresh } from "../domain/chips";
import type { ChipSuggester } from "../gateway/ports";
import type { Policy } from "../policy/policy";
import { BoardApiError } from "./board-session";
import type { ChipsCacheStore } from "./chips-cache";

export interface SceneChipsDeps {
  boards: BoardRepository;
  /** Decorated port (PIN-61); absent = fixed-list fallback only. */
  suggester?: ChipSuggester;
  cache: ChipsCacheStore;
  policy: Policy;
  now?: () => number;
}

export interface SceneChipsResult {
  chips: string[];
  source: "cache" | "generated" | "fallback";
}

export function parseSceneChipsInput(
  value: unknown,
  policy: Policy,
): { elementIds: string[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoardApiError("Pick some pins first.");
  }
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body.elementIds) ||
    body.elementIds.length === 0 ||
    body.elementIds.some((id) => typeof id !== "string" || !id)
  ) {
    throw new BoardApiError("Pick at least one pin.");
  }
  const elementIds = [...new Set(body.elementIds as string[])];
  if (
    elementIds.length < policy.pinsPerScene.min ||
    elementIds.length > policy.pinsPerScene.max
  ) {
    throw new BoardApiError("Too many pins for one scene.");
  }
  return { elementIds };
}

export async function resolveSceneChips(
  slug: string,
  participant: Participant,
  rawInput: unknown,
  deps: SceneChipsDeps,
): Promise<SceneChipsResult> {
  const { policy } = deps;
  const fallback: SceneChipsResult = {
    chips: [...policy.sceneChips],
    source: "fallback",
  };

  const board = await deps.boards.getBoard(slug);
  if (!board) throw new BoardApiError("Board not found.", 404);
  const { elementIds } = parseSceneChipsInput(rawInput, policy);

  // Same chosen-pin rule as a scene (PIN-69): every element must
  // exist on this board and be pinned — labels never come from
  // the client, so a chip set cannot be minted for foreign pins.
  const pinnedElementIds = new Set(
    (await deps.boards.listPins(slug, "pinned")).map((pin) => pin.elementId),
  );
  const labels: string[] = [];
  for (const elementId of elementIds) {
    const element = await deps.boards.getElement(elementId);
    if (!element || element.boardId !== slug || !pinnedElementIds.has(elementId)) {
      throw new BoardApiError("One of those pins is not on this board anymore.", 404);
    }
    labels.push(element.label);
  }

  if (policy.chipsMax <= 0 || !deps.suggester) return fallback;

  const keyBase = chipsCacheKeyBase(labels);
  if (!keyBase) return fallback;
  const now = deps.now?.() ?? Date.now();

  const cached = await deps.cache.get(keyBase).catch(() => null);
  if (cached && cached.chips.length > 0 && isChipsCacheFresh(cached, now, policy.chipsCacheTtlHours)) {
    return { chips: cached.chips.slice(0, policy.chipsMax), source: "cache" };
  }

  const outcome = await deps.suggester.suggestChips({
    labels,
    maxChips: policy.chipsMax,
    maxChipChars: policy.scenePromptMaxChars,
    maxTokens: policy.maxTokens.sparkChips,
    timeoutMs: policy.timeoutsMs.spark,
    promptVersion: policy.promptVersions.chips,
    boardId: slug,
    participantId: participant.id,
    userIdAtCall: participant.userId ?? null,
  });
  if (outcome.status !== "ready" || outcome.value.chips.length === 0) {
    // Refused / failed / budget-denied: fixed list, nothing cached
    // so a later open can succeed once budget or provider recovers.
    return fallback;
  }

  const chips = outcome.value.chips.slice(0, policy.chipsMax);
  await deps.cache
    .put({
      key: keyBase,
      chips,
      promptVersion: outcome.value.promptVersion,
      createdAt: now,
    })
    .catch(() => undefined);
  return { chips, source: "generated" };
}
