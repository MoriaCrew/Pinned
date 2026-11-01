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
const lower = (value: string) => value.replace(/\s+/g, " ").trim().toLocaleLowerCase();

/** A chip shows pressed while the idea holds its words, in any case (PIN-216). */
export function chipInPrompt(prompt: string, chip: string): boolean {
  const needle = lower(chip);
  return needle.length > 0 && lower(prompt).includes(needle);
}

/**
 * A chip tap (PIN-70, PIN-216): fills an empty idea, swaps an idea
 * that is just an earlier chip, else joins with ", " ("a picnic" +
 * chip -> "a picnic, floating in space"). Tapping a pressed chip takes
 * it back out when it is the idea or one comma part of it; words typed
 * around it are never touched. Busting Policy.scenePromptMaxChars
 * changes nothing.
 */
export function applyChip(
  prompt: string,
  chip: string,
  chips: readonly string[],
  maxChars: number,
): string {
  const current = prompt.trim();
  const fits = (next: string) => (charCount(next) <= maxChars ? next : prompt);
  if (!current) return fits(chip);
  if (lower(current) === lower(chip)) return "";
  if (chips.some((known) => lower(known) === lower(current))) return fits(chip);
  if (chipInPrompt(current, chip)) {
    const parts = current.split(/\s*,\s*/);
    const kept = parts.filter((part) => lower(part) !== lower(chip));
    return kept.length < parts.length ? kept.join(", ") : prompt;
  }
  return fits(joinIdea(current, chip));
}

/** Adds words to the end of an idea: ", " between parts, one space after . ! or ? (PIN-216). */
function joinIdea(current: string, addition: string): string {
  const base = current.trim().replace(/[\s,;]+$/, "");
  if (!base) return addition;
  return `${base}${/[.!?]$/.test(base) ? " " : ", "}${addition}`;
}

/**
 * The idea row (PIN-216): the fixed Policy chips first, then the
 * chips generated for these picks after them, so a late arrival
 * never moves a chip under the thumb.
 */
export function ideaChips(fixed: readonly string[], current: readonly string[]): string[] {
  return [...new Set([...fixed, ...current])];
}

const isWordChar = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/**
 * A chip's sticker (PIN-216): the first pick whose name the chip
 * says as whole words, in any case; a chip that names no pick gets
 * no thumbnail.
 */
export function chipThumb(chip: string, cards: readonly PinCard[]): string | undefined {
  const text = lower(chip);
  const names = (label: string) => {
    const needle = lower(label);
    for (let at = needle ? text.indexOf(needle) : -1; at >= 0; at = text.indexOf(needle, at + 1)) {
      if (!isWordChar(text[at - 1]) && !isWordChar(text[at + needle.length])) return true;
    }
    return false;
  };
  return cards.find((card) => names(card.element.label))?.element.imageUrl;
}

/**
 * Display, not Policy: the idea's "n/max" count shows from this share
 * of Policy.scenePromptMaxChars, so it only speaks near the limit.
 */
export const PROMPT_COUNT_FROM = 0.8;

export function promptCountVisible(prompt: string, maxChars: number): boolean {
  return charCount(prompt) >= Math.floor(maxChars * PROMPT_COUNT_FROM);
}

/** Recording clock "m:ss" (PIN-216), for elapsed and the Policy clip cap. */
export function clipClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Append a dictated transcript to the idea (PIN-119): fills an
 * empty prompt, else joins like a chip does (PIN-216). A trailing full stop
 * on the transcript drops (idea fragments read better without),
 * and text that would bust Policy.scenePromptMaxChars is cut at
 * the cap rather than rejected — the words already typed win.
 */
export function appendDictation(
  prompt: string,
  transcript: string,
  maxChars: number,
): string {
  const spoken = transcript.replace(/\s+/g, " ").trim().replace(/[.!\s]+$/, "");
  if (!spoken) return prompt;
  const joined = joinIdea(prompt, spoken);
  const cut = [...joined].slice(0, Math.max(0, maxChars)).join("");
  // A cut never leaves a dangling ", " behind.
  return cut === joined ? cut : cut.replace(/[\s,]+$/, "");
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

/**
 * My attempt's scene poll (PIN-143): `scene: null` = the scene route
 * 404'd (deleted or hidden), so the poll stops there, as it does at a
 * terminal status; otherwise it keeps the job cadence.
 */
export function attemptPollInterval(
  data: { scene: { status: SceneStatusLike } | null } | undefined,
  intervalMs: number,
): number | false {
  if (data && (data.scene === null || isTerminalScene(data.scene.status))) return false;
  return intervalMs;
}

/**
 * The strip's scenes with my attempt's polled copy on top (PIN-143).
 * It replaces the board view's copy (keeping that copy's per-viewer
 * flags), and only while the board view still lists the scene: once
 * it is deleted or hidden there, a stale polled copy never brings it
 * back.
 */
export function withPolledScene(viewScenes: readonly BoardViewScene[], polled: BoardViewScene | null | undefined): BoardViewScene[] {
  const inView = polled ? viewScenes.find((scene) => scene.id === polled.id) : undefined;
  if (!polled || !inView) return [...viewScenes];
  return [
    { ...polled, canDelete: inView.canDelete, parentDeleted: inView.parentDeleted },
    ...viewScenes.filter((scene) => scene.id !== polled.id),
  ];
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
