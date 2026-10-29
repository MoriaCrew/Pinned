/**
 * Pure Make-a-scene logic (PIN-70, docs/11 section 6): board pin
 * multi-select capped at Policy.pinsPerScene, the fixed Policy
 * suggestion chips, the POST /scenes payload and the scene credit
 * line ("made from Robin's mug + Aye's cat"). Server caps stay
 * authoritative (PIN-69); these mirrors only prevent bad submits.
 */
import type {
  BoardViewElement,
  BoardViewParticipant,
  BoardViewScene,
  PinCard,
} from "./board-view";

/** Only real pins can be picked — candidates are not pinned yet. */
export function selectableCards(cards: readonly PinCard[]): PinCard[] {
  return cards.filter((card) => card.status === "pinned");
}

/**
 * Tap a pin: a picked pin drops out, a new one joins until the
 * Policy cap. At the cap the tap is rejected (the board shows the
 * max hint) instead of evicting an earlier pick silently.
 */
export function togglePinSelection(
  selected: ReadonlySet<string>,
  pinId: string,
  maxPins: number,
): { next: Set<string>; rejected: boolean } {
  const next = new Set(selected);
  if (next.has(pinId)) {
    next.delete(pinId);
    return { next, rejected: false };
  }
  if (next.size >= maxPins) return { next, rejected: true };
  next.add(pinId);
  return { next, rejected: false };
}

/** Drop picks whose pin left the board (deleted between polls). */
export function pruneSelection(
  selected: ReadonlySet<string>,
  selectablePinIds: readonly string[],
): Set<string> {
  const alive = new Set(selectablePinIds);
  return new Set([...selected].filter((pinId) => alive.has(pinId)));
}

/** Picked cards in board order (stable across polls). */
export function selectedCards(
  cards: readonly PinCard[],
  selected: ReadonlySet<string>,
): PinCard[] {
  return selectableCards(cards).filter((card) => selected.has(card.pinId));
}

const charCount = (value: string) => [...value].length;

/**
 * A chip fills an empty prompt, swaps a prompt that is just
 * another chip, or extends a typed idea ("a picnic" + chip ->
 * "a picnic floating in space"). A chip already in the text, or
 * one that would bust Policy.scenePromptMaxChars, changes nothing.
 */
export function applyChip(
  prompt: string,
  chip: string,
  chips: readonly string[],
  maxChars: number,
): string {
  const current = prompt.trim();
  if (!current) return charCount(chip) <= maxChars ? chip : prompt;
  if (chips.includes(current)) return charCount(chip) <= maxChars ? chip : prompt;
  if (current.includes(chip)) return prompt;
  const joined = `${current} ${chip}`;
  return charCount(joined) <= maxChars ? joined : prompt;
}

/** Stable identity of a pick set for generated chips (PIN-75). */
export function chipsSelectionKey(elementIds: readonly string[]): string {
  return [...new Set(elementIds)].sort().join(",");
}

/**
 * Chips to render for the current picks: generated chips only
 * when they were made for exactly this selection key — a slow
 * response for earlier picks must never swap in (PIN-75). The
 * fixed Policy list shows until then, so first paint is instant.
 */
export function chipsForSelection(
  generated: { key: string; chips: readonly string[] } | null,
  selectionKey: string,
  fallback: readonly string[],
): readonly string[] {
  return generated && generated.key === selectionKey && generated.chips.length > 0
    ? generated.chips
    : fallback;
}

export interface ScenePayload {
  /** Remix parent scene id (PIN-79); elementIds are the NEW pins only. */
  parentSceneId?: string;
  elementIds: string[];
  prompt: string;
  sceneId: string;
}

/**
 * The POST /scenes body, or null when the sheet must not submit:
 * picks within Policy.pinsPerScene (counted after de-duping pins
 * that share an element) and a non-empty prompt inside
 * Policy.scenePromptMaxChars. The client sceneId makes a retried
 * POST idempotent server-side (PIN-69).
 */
/** Only a ready scene with an image can be remixed (PIN-79). */
export function canRemixScene(
  scene: Pick<BoardViewScene, "status" | "imageUrl">,
): boolean {
  return scene.status === "ready" && scene.imageUrl !== null;
}

export function scenePayload(
  cards: readonly PinCard[],
  rawPrompt: string,
  sceneId: string,
  range: { min: number; max: number },
  maxPromptChars: number,
  parentSceneId?: string,
): ScenePayload | null {
  if (!sceneId) return null;
  const prompt = rawPrompt.trim().replace(/\s+/g, " ");
  if (!prompt || charCount(prompt) > maxPromptChars) return null;
  const elementIds = [...new Set(cards.map((card) => card.element.id))];
  if (elementIds.length < range.min || elementIds.length > range.max) return null;
  return { elementIds, prompt, sceneId, ...(parentSceneId ? { parentSceneId } : {}) };
}

export type SceneStatusLike = BoardViewScene["status"];

export function isTerminalScene(status: SceneStatusLike): boolean {
  return status === "ready" || status === "failed" || status === "refused";
}

/** Gallery order: newest first, stable for equal timestamps. */
export function scenesNewestFirst(scenes: readonly BoardViewScene[]): BoardViewScene[] {
  return [...scenes].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  );
}

export interface SceneCreditPart {
  /** Element owner's display name; null when unknown. */
  ownerName: string | null;
  label: string;
}

/**
 * Credit parts for a scene from the board view's visible
 * elements. An element no longer visible (its pin went away after
 * the scene was made) is skipped rather than mis-credited.
 */
/**
 * Element ids to credit for a scene (PIN-79): its own (new) pins
 * first, then — walking the remix parent chain — every ancestor's
 * pins, deduped. Credits are the union of these elements' owners.
 * A parent missing from the view (or a cycle in corrupt data)
 * just ends the walk.
 */
export function sceneCreditElementIds(
  scene: { id?: string; elementIds: string[]; parentSceneId?: string },
  scenes: readonly BoardViewScene[] = [],
): string[] {
  const byId = new Map(scenes.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const ids: string[] = [];
  const visited = new Set<string>();
  let current: { id?: string; elementIds: string[]; parentSceneId?: string } | undefined = scene;
  while (current && !(current.id && visited.has(current.id))) {
    if (current.id) visited.add(current.id);
    for (const elementId of current.elementIds) {
      if (seen.has(elementId)) continue;
      seen.add(elementId);
      ids.push(elementId);
    }
    current = current.parentSceneId ? byId.get(current.parentSceneId) : undefined;
  }
  return ids;
}

export function sceneCreditParts(
  scene: { id?: string; elementIds: string[]; parentSceneId?: string },
  elements: readonly BoardViewElement[],
  participants: readonly BoardViewParticipant[],
  scenes: readonly BoardViewScene[] = [],
): SceneCreditPart[] {
  const elementsById = new Map(elements.map((e) => [e.id, e]));
  const namesById = new Map(participants.map((p) => [p.id, p.displayName]));
  const parts: SceneCreditPart[] = [];
  for (const elementId of sceneCreditElementIds(scene, scenes)) {
    const element = elementsById.get(elementId);
    if (!element) continue;
    parts.push({
      ownerName: namesById.get(element.ownerId) ?? null,
      label: element.label,
    });
  }
  return parts;
}
