import { describe, expect, it } from "vitest";
import {
  PLUS_SKIN_IDS,
  canUseSkin,
  grantPlus,
  hasPlus,
  isPlusMode,
  isPlusPlan,
  isPlusSkin,
  planCovers,
  plusView,
  type BoardPlus,
} from "./plus";

const LABELS = { board: "$3.99", host: "$4.99/month" };
const GRANT: BoardPlus = { plan: "board", source: "mock", grantedAt: 1_000 };

describe("Board Plus domain (PIN-103)", () => {
  it("knows exactly the three Plus skins", () => {
    expect(PLUS_SKIN_IDS).toEqual(["darkroom", "postcard", "marigold"]);
    for (const id of PLUS_SKIN_IDS) expect(isPlusSkin(id)).toBe(true);
    for (const id of ["paper", "cork", "fridge", "zine", "Darkroom", "", null, 3]) {
      expect(isPlusSkin(id)).toBe(false);
    }
  });

  it("validates plans and modes by exact id", () => {
    expect(isPlusPlan("board")).toBe(true);
    expect(isPlusPlan("host")).toBe(true);
    expect(isPlusPlan("Board")).toBe(false);
    expect(isPlusPlan(undefined)).toBe(false);
    expect(isPlusMode("off")).toBe(true);
    expect(isPlusMode("mock")).toBe(true);
    expect(isPlusMode("stripe")).toBe(false);
  });

  it("gates Plus skins on the entitlement; free skins stay free", () => {
    const free = {};
    const plus = { plus: GRANT };
    expect(hasPlus(free)).toBe(false);
    expect(hasPlus(plus)).toBe(true);
    expect(canUseSkin(free, "paper")).toBe(true);
    expect(canUseSkin(free, "darkroom")).toBe(false);
    expect(canUseSkin(plus, "darkroom")).toBe(true);
    expect(canUseSkin(plus, "cork")).toBe(true);
    // A malformed stored plan never counts as Plus.
    expect(hasPlus({ plus: { ...GRANT, plan: "gold" as never } })).toBe(false);
  });

  it("host plan covers the board plan, not the other way round", () => {
    expect(planCovers("board", "board")).toBe(true);
    expect(planCovers("host", "host")).toBe(true);
    expect(planCovers("host", "board")).toBe(true);
    expect(planCovers("board", "host")).toBe(false);
  });

  it("grants a dated entitlement", () => {
    expect(grantPlus("host", "mock", 42)).toEqual({ plan: "host", source: "mock", grantedAt: 42 });
  });

  it("view exposes state, mode and labels — never source or grant time", () => {
    expect(plusView({}, { mode: "off", priceLabels: LABELS })).toEqual({
      active: false,
      mode: "off",
      priceLabels: LABELS,
    });
    const view = plusView({ plus: GRANT }, { mode: "mock", priceLabels: LABELS });
    expect(view).toEqual({ active: true, plan: "board", mode: "mock", priceLabels: LABELS });
    expect(JSON.stringify(view)).not.toMatch(/source|grantedAt/);
  });
});
