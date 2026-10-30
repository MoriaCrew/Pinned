/**
 * Pure view helpers for the rebuilt board page (PIN-98, design
 * system v1, docs/14): header counts, the latest-activity line,
 * scene numbering and credits, which scenes the strip shows and
 * how, and picking order. Client-safe: no i18n, no server code;
 * the page turns these shapes into words.
 */
import type { ActivityKind, ActivityLine } from "./board-activity";
import type {
  BoardViewElement,
  BoardViewLike,
  BoardViewParticipant,
  BoardViewScene,
  PinCard,
} from "./board-view";
import { sceneCreditElementIds, selectableCards } from "./make-sheet";

/** A ready scene the board can show as a print. */
export function isVisibleReadyScene(scene: Pick<BoardViewScene, "status" | "imageUrl">): boolean {
  return scene.status === "ready" && scene.imageUrl !== null;
}

export interface BoardCountsView extends BoardViewLike {
  scenes: readonly Pick<BoardViewScene, "status" | "imageUrl">[];
}

/**
 * Header meta counts: everyone on the roster, pinned things (a
 * private candidate is not on the board yet) and ready scenes
 * (the view already leaves hidden scenes out).
 */
export function boardCounts(view: BoardCountsView): { people: number; things: number; scenes: number } {
  return {
    people: view.participants.length,
    things: view.pins.filter((pin) => pin.status === "pinned").length,
    scenes: view.scenes.filter(isVisibleReadyScene).length,
  };
}

/**
 * A thing's name inside a sentence or a credit is lower case
 * ("Sam pinned teal mug"; brand book, Words). Words that are all
 * capitals (TV, DJ) or carry digits keep their spelling.
 */
export function thingInSentence(label: string): string {
  return label
    .trim()
    .split(/(\s+)/)
    .map((word) => {
      if (/\d/.test(word)) return word;
      const letters = word.replace(/[^\p{L}]/gu, "");
      if (letters.length > 1 && letters === letters.toUpperCase()) return word;
      return word.toLowerCase();
    })
    .join("");
}

export interface LatestActivity {
  kind: ActivityKind;
  /** Actor display name; null when no longer on the roster. */
  name: string | null;
  /** Thing name for "pinned", already in sentence case; null otherwise. */
  thing: string | null;
}

/** The one quiet "latest" line under the header: the newest activity line, if any. */
export function latestActivity(lines: readonly ActivityLine[]): LatestActivity | null {
  const line = lines[0];
  if (!line) return null;
  return {
    kind: line.kind,
    name: line.actorName,
    thing: line.label ? thingInSentence(line.label) : null,
  };
}

/** Oldest first, stable for equal timestamps (the reverse of the strip order). */
function oldestFirst<T extends Pick<BoardViewScene, "id" | "createdAt">>(scenes: readonly T[]): T[] {
  return [...scenes].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/**
 * Catalogue numbers ("Nº 03"): each ready scene's position on the
 * board counted from the oldest. Scenes still developing, failed
 * or refused get no number, so the prints count 1, 2, 3 without gaps.
 */
export function sceneNumbers(
  scenes: readonly Pick<BoardViewScene, "id" | "createdAt" | "status" | "imageUrl">[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  oldestFirst(scenes.filter(isVisibleReadyScene)).forEach((scene, index) => {
    numbers.set(scene.id, index + 1);
  });
  return numbers;
}

export interface SceneCreditItem {
  /** Thing name in sentence case ("teal mug"). */
  thing: string;
  owner: { id: string; name: string } | null;
  /** The thing's cut-out (board-link-checked image route). */
  src: string;
}

/**
 * Credits for a print: every visible element of the scene and,
 * for a remix, of its ancestors (sceneCreditElementIds), with the
 * owner and the cut-out. Elements that left the board are skipped
 * rather than mis-credited; an owner no longer on the roster
 * leaves the thing uncredited to a person.
 */
export function sceneCredits(
  scene: { id?: string; elementIds: string[]; parentSceneId?: string },
  elements: readonly BoardViewElement[],
  participants: readonly BoardViewParticipant[],
  scenes: readonly BoardViewScene[] = [],
): SceneCreditItem[] {
  const elementsById = new Map(elements.map((e) => [e.id, e]));
  const namesById = new Map(participants.map((p) => [p.id, p.displayName]));
  const items: SceneCreditItem[] = [];
  for (const elementId of sceneCreditElementIds(scene, scenes)) {
    const element = elementsById.get(elementId);
    if (!element) continue;
    const name = namesById.get(element.ownerId);
    items.push({
      thing: thingInSentence(element.label),
      owner: name === undefined ? null : { id: element.ownerId, name },
      src: element.imageUrl,
    });
  }
  return items;
}

/**
 * The print's tag: a mock collage says so first (never passed off
 * as AI output, PIN-71); otherwise a remix is tagged as one. A
 * remix collage still says "Remix of …" in its credit line.
 */
export function sceneTag(scene: Pick<BoardViewScene, "kind" | "parentSceneId">): "scene" | "collage" | "remix" {
  if (scene.kind === "collage") return "collage";
  if (scene.parentSceneId) return "remix";
  return "scene";
}

/** "Remix of “A tiny picnic” by Robin": the parent's idea and its maker, when still on the board. */
export function remixSource(
  scene: Pick<BoardViewScene, "parentSceneId">,
  scenes: readonly BoardViewScene[],
  participants: readonly BoardViewParticipant[],
): { title: string; owner?: string } | null {
  if (!scene.parentSceneId) return null;
  const parent = scenes.find((candidate) => candidate.id === scene.parentSceneId);
  if (!parent) return null;
  const owner = participants.find((p) => p.id === parent.createdBy)?.displayName;
  return owner ? { title: parent.prompt, owner } : { title: parent.prompt };
}

export type StripMode = "print" | "developing" | "problem";

export interface StripItem {
  scene: BoardViewScene;
  mode: StripMode;
  /** True for the viewer's own in-flight or failed attempt (it owns the retry buttons). */
  mine: boolean;
}

/**
 * What the Scenes strip shows, newest first. Ready prints for
 * everyone; anyone's scene still developing shows where it will
 * land; a failed or refused scene only for the attempt that made
 * it in this session (the one with Change idea / Try again) —
 * older dead ends and other people's never clutter the strip.
 * A ready scene with no image yet is left out.
 */
export function stripItems(
  scenesNewestFirst: readonly BoardViewScene[],
  attemptSceneId: string | null,
): StripItem[] {
  const items: StripItem[] = [];
  for (const scene of scenesNewestFirst) {
    const mine = attemptSceneId !== null && scene.id === attemptSceneId;
    if (isVisibleReadyScene(scene)) {
      items.push({ scene, mode: "print", mine });
    } else if (scene.status === "pending" || scene.status === "running") {
      items.push({ scene, mode: "developing", mine });
    } else if ((scene.status === "failed" || scene.status === "refused") && mine) {
      items.push({ scene, mode: "problem", mine });
    }
  }
  return items;
}

/**
 * Picked cards in the order they were tapped (the tray and the
 * numbered badges follow it). The selection Set keeps insertion
 * order; picks whose pin is no longer selectable drop out.
 */
export function pickedInOrder(cards: readonly PinCard[], selected: ReadonlySet<string>): PinCard[] {
  const byPin = new Map(selectableCards(cards).map((card) => [card.pinId, card]));
  const ordered: PinCard[] = [];
  for (const pinId of selected) {
    const card = byPin.get(pinId);
    if (card) ordered.push(card);
  }
  return ordered;
}

/** 1-based pick number per pin id, in tap order. */
export function pickNumbers(cards: readonly PinCard[], selected: ReadonlySet<string>): Map<string, number> {
  return new Map(pickedInOrder(cards, selected).map((card, index) => [card.pinId, index + 1]));
}

/** Developing clock: "0:07", "1:02". Negative or missing time reads as 0:00. */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
