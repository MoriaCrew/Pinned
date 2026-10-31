import { describe, expect, it } from "vitest";
import {
  PLUS_SKIN_IDS,
  canUseSkin,
  decideMockGrant,
  decidePurchasePlusGrant,
  grantPlus,
  hasPlus,
  isPlusMode,
  isPlusPlan,
  isPlusSkin,
  planCovers,
  plusView,
  type BoardPlus,
} from "./plus";
import { DEFAULT_SKIN, SKINS, SKIN_IDS, getSkin, isPlusSkinId } from "./skins";

const MOCK: BoardPlus = { plan: "board", source: "mock", grantedAt: 1_000 };
const PAID: BoardPlus = { plan: "board", source: "stripe", grantedAt: 1_000 };

describe("Board Plus domain (PIN-103)", () => {
  it("Plus membership agrees with the skins catalogue exactly", () => {
    expect(PLUS_SKIN_IDS).toEqual(SKINS.filter((skin) => skin.plus).map((skin) => skin.id));
    for (const id of SKIN_IDS) {
      expect(isPlusSkin(id)).toBe(getSkin(id).plus);
      expect(isPlusSkin(id)).toBe(isPlusSkinId(id));
    }
    expect(PLUS_SKIN_IDS.length).toBeGreaterThan(0);
    expect(isPlusSkin(DEFAULT_SKIN)).toBe(false);
    for (const id of ["Darkroom", "helpdesk", "", null, 3]) expect(isPlusSkin(id)).toBe(false);
  });

  it("validates plans and modes by exact id", () => {
    expect(isPlusPlan("board")).toBe(true);
    expect(isPlusPlan("host")).toBe(true);
    expect(isPlusPlan("Board")).toBe(false);
    expect(isPlusPlan(undefined)).toBe(false);
    expect(isPlusMode("off")).toBe(true);
    expect(isPlusMode("mock")).toBe(true);
    expect(isPlusMode("stripe")).toBe(true);
    expect(isPlusMode("STRIPE")).toBe(false);
  });

  it("hasPlus is null-safe and counts mock grants only in mock mode", () => {
    expect(hasPlus({}, "mock")).toBe(false);
    expect(hasPlus({ plus: null }, "mock")).toBe(false);
    expect(hasPlus({ plus: MOCK }, "mock")).toBe(true);
    expect(hasPlus({ plus: MOCK }, "off")).toBe(false);
    expect(hasPlus({ plus: PAID }, "off")).toBe(true);
    expect(hasPlus({ plus: PAID }, "mock")).toBe(true);
    expect(hasPlus({ plus: MOCK }, "stripe")).toBe(false);
    expect(hasPlus({ plus: PAID }, "stripe")).toBe(true);
    // A malformed stored plan never counts as Plus.
    expect(hasPlus({ plus: { ...PAID, plan: "gold" as never } }, "off")).toBe(false);
  });

  it("gates Plus skins on an entitlement that counts; free skins stay free", () => {
    const plusSkin = PLUS_SKIN_IDS[0];
    const freeSkin = DEFAULT_SKIN;
    expect(canUseSkin({}, freeSkin, "off")).toBe(true);
    expect(canUseSkin({ plus: null }, plusSkin, "mock")).toBe(false);
    expect(canUseSkin({ plus: MOCK }, plusSkin, "mock")).toBe(true);
    expect(canUseSkin({ plus: MOCK }, plusSkin, "off")).toBe(false);
    expect(canUseSkin({ plus: PAID }, plusSkin, "off")).toBe(true);
  });

  it("host plan covers the board plan, not the other way round", () => {
    expect(planCovers("board", "board")).toBe(true);
    expect(planCovers("host", "host")).toBe(true);
    expect(planCovers("host", "board")).toBe(true);
    expect(planCovers("board", "host")).toBe(false);
  });

  it("mock grant decision: keep covering grants, never replace a paid one", () => {
    expect(grantPlus("host", "mock", 42)).toEqual({ plan: "host", source: "mock", grantedAt: 42 });
    expect(decideMockGrant(undefined, "board", 5)).toEqual({ kind: "grant", plus: grantPlus("board", "mock", 5) });
    expect(decideMockGrant(null, "host", 5)).toEqual({ kind: "grant", plus: grantPlus("host", "mock", 5) });
    expect(decideMockGrant({ ...MOCK, plan: "host" }, "board", 5)).toEqual({ kind: "keep" });
    expect(decideMockGrant(MOCK, "board", 5)).toEqual({ kind: "keep" });
    expect(decideMockGrant(MOCK, "host", 5)).toEqual({ kind: "grant", plus: grantPlus("host", "mock", 5) });
    expect(decideMockGrant(PAID, "board", 5)).toEqual({ kind: "keep" });
    expect(decideMockGrant(PAID, "host", 5)).toEqual({ kind: "blocked" });
  });

  it("purchase grant (PIN-181): paid board Plus once, replaces mock, never touches a stripe grant", () => {
    const paidBoard = { plus: grantPlus("board", "stripe", 7) };
    expect(decidePurchasePlusGrant({}, 7)).toEqual(paidBoard);
    expect(decidePurchasePlusGrant({ plus: null }, 7)).toEqual(paidBoard);
    expect(decidePurchasePlusGrant({ plus: MOCK }, 7)).toEqual(paidBoard);
    expect(decidePurchasePlusGrant({ plus: { ...MOCK, plan: "host" } }, 7)).toEqual(paidBoard);
    // Any stripe grant stays as it is: a replay or a paid host plan.
    expect(decidePurchasePlusGrant({ plus: PAID }, 7)).toBeNull();
    expect(decidePurchasePlusGrant({ plus: { ...PAID, plan: "host" } }, 7)).toBeNull();
    // The grant counts in every mode, including off.
    for (const mode of ["off", "mock", "stripe"] as const) {
      expect(hasPlus(paidBoard, mode)).toBe(true);
    }
  });

  it("view exposes state and mode — never source, grant time or a price", () => {
    expect(plusView({}, "off")).toEqual({ active: false, mode: "off" });
    expect(plusView({ plus: null }, "mock").active).toBe(false);
    expect(plusView({ plus: MOCK }, "off")).toEqual({ active: false, mode: "off" });
    const view = plusView({ plus: MOCK }, "mock");
    expect(view).toEqual({ active: true, plan: "board", mode: "mock" });
    expect(JSON.stringify(view)).not.toMatch(/source|grantedAt|price/i);
  });
});
