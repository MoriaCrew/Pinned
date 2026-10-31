/**
 * Pin filter row for busy boards (PIN-218, docs/11 section 6): which
 * chips a board offers above its pins grid, what each one shows, and
 * what a remembered choice turns into once the board has moved on.
 * Pure: the board page keeps the choice (sessionStorage) and the
 * viewer's last visit (localStorage); this module only reads them.
 */
import type { PinCard } from "./board-view";

export type PinFilter =
  | { kind: "all" }
  | { kind: "mine" }
  | { kind: "person"; participantId: string }
  | { kind: "new"; since: number };

/** One chip: the filter it applies and how many pins it shows. */
export type PinFilterOption =
  | { kind: "new"; since: number; count: number }
  | { kind: "all"; count: number }
  | { kind: "mine"; participantId: string; count: number }
  | { kind: "person"; participantId: string; name: string | null; count: number };

const ALL: PinFilter = { kind: "all" };

/** Only pinned pins are in the grid (candidates have their own line, PIN-122). */
function pinned(cards: readonly PinCard[]): PinCard[] {
  return cards.filter((card) => card.status === "pinned");
}

function isNew(card: PinCard, since: number, meId: string | null): boolean {
  // Your own pins are never news to you.
  return card.createdAt > since && card.ownerId !== meId;
}

/** Newest pinned pin's time (server clock), or null on a board with none. */
export function newestPinAt(cards: readonly PinCard[]): number | null {
  let newest: number | null = null;
  for (const card of pinned(cards)) {
    if (newest === null || card.createdAt > newest) newest = card.createdAt;
  }
  return newest;
}

/**
 * The "last seen" watermark only moves forward: a stale background
 * tab, or deleting the newest pin, must never move it back and mark
 * already-seen pins New again. Returns the value to store, or null to
 * leave storage as it is (nothing pinned yet, or not newer).
 */
export function advanceSeenAt(stored: number | null, newest: number | null): number | null {
  if (newest === null || !Number.isFinite(newest) || newest <= 0) return null;
  if (stored !== null && stored >= newest) return null;
  return newest;
}

/**
 * The chips, in order: New (pins from others since `lastSeenAt`,
 * only when there are some), All, Mine (only when you have pins),
 * then one chip per other person with pins, most recently active
 * first. `lastSeenAt` is the newest pin time the viewer had seen on
 * their last visit (null on a first visit: no New chip). Empty when
 * no chip would narrow the grid (one person's pins, nothing new):
 * the board shows no row then.
 */
export function pinFilterOptions(
  cards: readonly PinCard[],
  meId: string | null,
  lastSeenAt: number | null,
): PinFilterOption[] {
  const shown = pinned(cards);
  const total = shown.length;
  const people = new Map<string, { name: string | null; count: number; latest: number }>();
  let mine = 0;
  let fresh = 0;
  for (const card of shown) {
    if (lastSeenAt !== null && isNew(card, lastSeenAt, meId)) fresh += 1;
    if (meId !== null && card.ownerId === meId) {
      mine += 1;
      continue;
    }
    const person = people.get(card.ownerId);
    if (person) {
      person.count += 1;
      person.latest = Math.max(person.latest, card.createdAt);
      person.name ??= card.ownerName;
    } else {
      people.set(card.ownerId, { name: card.ownerName, count: 1, latest: card.createdAt });
    }
  }
  const options: PinFilterOption[] = [];
  if (lastSeenAt !== null && fresh > 0) options.push({ kind: "new", since: lastSeenAt, count: fresh });
  options.push({ kind: "all", count: total });
  if (meId !== null && mine > 0) options.push({ kind: "mine", participantId: meId, count: mine });
  const byActivity = [...people.entries()].sort(
    ([idA, a], [idB, b]) => b.latest - a.latest || idA.localeCompare(idB),
  );
  for (const [participantId, person] of byActivity) {
    options.push({ kind: "person", participantId, name: person.name, count: person.count });
  }
  return options.some((option) => option.kind !== "all" && option.count < total) ? options : [];
}

/** The filter a chip applies. */
export function optionFilter(option: PinFilterOption): PinFilter {
  switch (option.kind) {
    case "new":
      return { kind: "new", since: option.since };
    case "mine":
      return { kind: "mine" };
    case "person":
      return { kind: "person", participantId: option.participantId };
    default:
      return ALL;
  }
}

/** Same chip? (New matches by kind: its `since` is this visit's, not the stored one.) */
export function sameFilter(a: PinFilter, b: PinFilter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "person" && b.kind === "person") return a.participantId === b.participantId;
  return true;
}

/**
 * What a remembered choice shows now: the matching chip's filter, or
 * All once that chip is gone (the person's pins were deleted, you
 * deleted your last pin, nothing is new any more, or the board no
 * longer offers a row at all). A person chip chosen before you joined
 * or reclaimed as that person is your Mine chip now, so it stays.
 */
export function resolvePinFilter(
  filter: PinFilter,
  options: readonly PinFilterOption[],
  meId: string | null = null,
): PinFilter {
  const wanted: PinFilter =
    filter.kind === "person" && meId !== null && filter.participantId === meId ? { kind: "mine" } : filter;
  const match = options.find((option) => sameFilter(optionFilter(option), wanted));
  return match ? optionFilter(match) : ALL;
}

/** The pinned pins a filter shows, in board order. */
export function applyPinFilter(cards: readonly PinCard[], filter: PinFilter, meId: string | null): PinCard[] {
  const shown = pinned(cards);
  switch (filter.kind) {
    case "mine":
      return meId === null ? [] : shown.filter((card) => card.ownerId === meId);
    case "person":
      return shown.filter((card) => card.ownerId === filter.participantId);
    case "new":
      return shown.filter((card) => isNew(card, filter.since, meId));
    default:
      return shown;
  }
}

/** One person's pins only: the owner line under every pin says nothing new. */
export function showsOnePerson(filter: PinFilter): boolean {
  return filter.kind === "mine" || filter.kind === "person";
}

/** sessionStorage form of a choice (New is stored without its time). */
/**
 * A fallback sticks: when the grid no longer shows the remembered
 * chip (it went away, or became Mine), the choice to keep is what the
 * grid shows, so the old chip can never come back later without a
 * tap. Null when the remembered choice still stands.
 */
export function settledPinFilter(chosen: PinFilter, active: PinFilter): PinFilter | null {
  return serializePinFilter(chosen) === serializePinFilter(active) ? null : active;
}

export function serializePinFilter(filter: PinFilter): string {
  if (filter.kind === "person") return `person:${filter.participantId}`;
  return filter.kind;
}

/** Back from sessionStorage; anything unknown is All. */
export function parsePinFilter(raw: string | null): PinFilter {
  if (raw === "mine") return { kind: "mine" };
  if (raw === "new") return { kind: "new", since: 0 };
  if (raw?.startsWith("person:") && raw.length > "person:".length) {
    return { kind: "person", participantId: raw.slice("person:".length) };
  }
  return ALL;
}
