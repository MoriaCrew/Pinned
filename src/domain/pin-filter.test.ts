import { describe, expect, it } from "vitest";
import type { PinCard } from "./board-view";
import {
  applyPinFilter,
  newestPinAt,
  optionFilter,
  parsePinFilter,
  pinFilterOptions,
  resolvePinFilter,
  serializePinFilter,
  showsOnePerson,
  type PinFilter,
} from "./pin-filter";

const names: Record<string, string> = { me: "Robin", aye: "Aye", sam: "Sam" };

function card(pinId: string, ownerId: string, createdAt: number, status: PinCard["status"] = "pinned"): PinCard {
  return {
    pinId,
    element: { id: `e-${pinId}`, ownerId, label: pinId, faceFlag: false, imageUrl: `/${pinId}` },
    status,
    ownerName: names[ownerId] ?? null,
    ownerId,
    createdAt,
  };
}

// Board order (oldest first), as pinCards returns it.
const cards: PinCard[] = [
  card("m1", "me", 10),
  card("a1", "aye", 20),
  card("s1", "sam", 30),
  card("m2", "me", 40),
  card("a2", "aye", 50),
  card("cand", "me", 60, "candidate"),
];

const ids = (list: readonly PinCard[]) => list.map((c) => c.pinId);

describe("pin filter options (PIN-218)", () => {
  it("orders All, Mine, then people by latest pin, with pinned-only counts", () => {
    expect(pinFilterOptions(cards, "me", null)).toEqual([
      { kind: "all", count: 5 },
      { kind: "mine", participantId: "me", count: 2 },
      { kind: "person", participantId: "aye", name: "Aye", count: 2 },
      { kind: "person", participantId: "sam", name: "Sam", count: 1 },
    ]);
  });

  it("puts New first when others pinned since the last visit, never counting your own", () => {
    const options = pinFilterOptions([...cards, card("m3", "me", 70)], "me", 25);
    expect(options[0]).toEqual({ kind: "new", since: 25, count: 2 });
    expect(options.map((o) => o.kind)).toEqual(["new", "all", "mine", "person", "person"]);
  });

  it("offers no New on a first visit or when nothing is newer", () => {
    expect(pinFilterOptions(cards, "me", null).some((o) => o.kind === "new")).toBe(false);
    expect(pinFilterOptions(cards, "me", 50).some((o) => o.kind === "new")).toBe(false);
  });

  it("leaves Mine out until you have pins, and lists everyone for a viewer who has not joined", () => {
    const theirs = cards.filter((c) => c.ownerId !== "me");
    expect(pinFilterOptions(theirs, "me", null).map((o) => o.kind)).toEqual(["all", "person", "person"]);
    // Not joined: Robin is just another person (latest pins: Aye 50, Robin 40, Sam 30).
    expect(
      pinFilterOptions(cards, null, null).map((o) => (o.kind === "person" ? o.participantId : o.kind)),
    ).toEqual(["all", "aye", "me", "sam"]);
  });

  it("breaks activity ties by id so the row never reshuffles between polls", () => {
    const tied = [card("x", "sam", 5), card("y", "aye", 5)];
    expect(pinFilterOptions(tied, null, null).map((o) => (o.kind === "person" ? o.participantId : o.kind))).toEqual([
      "all",
      "aye",
      "sam",
    ]);
  });

  it("keeps an unknown owner as a chip with a null name (the UI says Someone)", () => {
    const options = pinFilterOptions([card("g1", "ghost", 1), card("a1", "aye", 2)], null, null);
    expect(options).toContainEqual({ kind: "person", participantId: "ghost", name: null, count: 1 });
  });

  it("shows no row when no chip would narrow the grid", () => {
    expect(pinFilterOptions([], "me", null)).toEqual([]);
    expect(pinFilterOptions([card("m1", "me", 1), card("m2", "me", 2)], "me", 0)).toEqual([]);
    expect(pinFilterOptions([card("a1", "aye", 1), card("a2", "aye", 2)], "me", 0)).toEqual([]);
    // Something new on a one-person board still narrows.
    expect(pinFilterOptions([card("a1", "aye", 1), card("a2", "aye", 2)], "me", 1).map((o) => o.kind)).toEqual([
      "new",
      "all",
      "person",
    ]);
  });
});

describe("applying and resolving a filter (PIN-218)", () => {
  it("shows the chosen pins in board order, never candidates", () => {
    expect(ids(applyPinFilter(cards, { kind: "all" }, "me"))).toEqual(["m1", "a1", "s1", "m2", "a2"]);
    expect(ids(applyPinFilter(cards, { kind: "mine" }, "me"))).toEqual(["m1", "m2"]);
    expect(ids(applyPinFilter(cards, { kind: "mine" }, null))).toEqual([]);
    expect(ids(applyPinFilter(cards, { kind: "person", participantId: "aye" }, "me"))).toEqual(["a1", "a2"]);
    expect(ids(applyPinFilter(cards, { kind: "new", since: 15 }, "me"))).toEqual(["a1", "s1", "a2"]);
  });

  it("matches every chip's count to what it shows", () => {
    const options = pinFilterOptions(cards, "me", 15);
    for (const option of options) {
      expect(applyPinFilter(cards, optionFilter(option), "me")).toHaveLength(option.count);
    }
  });

  it("keeps a choice while its chip exists and falls back to All once it is gone", () => {
    const options = pinFilterOptions(cards, "me", 15);
    const aye: PinFilter = { kind: "person", participantId: "aye" };
    expect(resolvePinFilter(aye, options)).toEqual(aye);
    expect(resolvePinFilter({ kind: "mine" }, options)).toEqual({ kind: "mine" });
    // New takes this visit's time, whatever was stored.
    expect(resolvePinFilter({ kind: "new", since: 0 }, options)).toEqual({ kind: "new", since: 15 });

    const ayeGone = pinFilterOptions(
      cards.filter((c) => c.ownerId !== "aye"),
      "me",
      null,
    );
    expect(resolvePinFilter(aye, ayeGone)).toEqual({ kind: "all" });
    expect(resolvePinFilter({ kind: "new", since: 15 }, ayeGone)).toEqual({ kind: "all" });
    expect(resolvePinFilter({ kind: "mine" }, pinFilterOptions(cards, "nobody", null))).toEqual({ kind: "all" });
    expect(resolvePinFilter(aye, [])).toEqual({ kind: "all" });
  });

  it("hides the owner line only for one person's pins", () => {
    expect(showsOnePerson({ kind: "mine" })).toBe(true);
    expect(showsOnePerson({ kind: "person", participantId: "aye" })).toBe(true);
    expect(showsOnePerson({ kind: "all" })).toBe(false);
    expect(showsOnePerson({ kind: "new", since: 1 })).toBe(false);
  });

  it("finds the newest pinned pin, ignoring candidates", () => {
    expect(newestPinAt(cards)).toBe(50);
    expect(newestPinAt([card("c", "me", 9, "candidate")])).toBeNull();
  });

  it("round-trips the stored choice and reads anything else as All", () => {
    const filters: PinFilter[] = [{ kind: "all" }, { kind: "mine" }, { kind: "person", participantId: "p:1" }];
    for (const filter of filters) expect(parsePinFilter(serializePinFilter(filter))).toEqual(filter);
    expect(parsePinFilter(serializePinFilter({ kind: "new", since: 99 }))).toEqual({ kind: "new", since: 0 });
    expect(parsePinFilter(null)).toEqual({ kind: "all" });
    expect(parsePinFilter("person:")).toEqual({ kind: "all" });
    expect(parsePinFilter("{bad")).toEqual({ kind: "all" });
  });
});
