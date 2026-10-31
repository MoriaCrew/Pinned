import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buyReturnSkinWrite } from "../../../domain/plus-ui";
import { applyBuyReturnSkinWrite, markReturnSkinReturned, readReturnSkin } from "./return-skin";

/**
 * The stored return look across buy taps (PIN-182, PIN-233 F10), on
 * the real storage helpers over an in-memory sessionStorage.
 */
const SLUG = "boardRRRRRRRRRRRRRRRR1";

beforeEach(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    sessionStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("return look across buy taps (PIN-233 F10)", () => {
  it("a failed retry with no try-on keeps the look the first tap stored", () => {
    applyBuyReturnSkinWrite(SLUG, buyReturnSkinWrite("darkroom", "leaving"));
    markReturnSkinReturned(SLUG); // back from Checkout, webhook still landing
    applyBuyReturnSkinWrite(SLUG, buyReturnSkinWrite(null, "leaving"));
    applyBuyReturnSkinWrite(SLUG, buyReturnSkinWrite(null, "failed"));
    expect(readReturnSkin(SLUG)).toEqual({ skin: "darkroom", returned: true });
  });

  it("a tap that stored a look and then failed forgets it", () => {
    applyBuyReturnSkinWrite(SLUG, buyReturnSkinWrite("darkroom", "leaving"));
    expect(readReturnSkin(SLUG)).toEqual({ skin: "darkroom", returned: false });
    applyBuyReturnSkinWrite(SLUG, buyReturnSkinWrite("darkroom", "failed"));
    expect(readReturnSkin(SLUG)).toBeNull();
  });
});
