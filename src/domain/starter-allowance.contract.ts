/**
 * Shared StarterAllowanceStore contract (PIN-204). Every store
 * (in-memory, Firestore) runs this suite, so both enforce the
 * same free-creations-per-maker semantics.
 */
import { describe, expect, it } from "vitest";
import type { StarterAllowanceParams, StarterAllowanceStore } from "./starter-allowance";

const PARAMS: StarterAllowanceParams = { maxBoards: 2, windowMs: 1_000 };

export function describeStarterAllowanceStoreContract(
  name: string,
  makeStore: () => StarterAllowanceStore,
): void {
  describe(`StarterAllowanceStore contract: ${name}`, () => {
    it("allows maxBoards per window, then refuses until the window ends", async () => {
      const store = makeStore();
      expect(await store.tryClaim("maker-a", 10_000, PARAMS)).toBe(true);
      expect(await store.tryClaim("maker-a", 10_100, PARAMS)).toBe(true);
      expect(await store.tryClaim("maker-a", 10_200, PARAMS)).toBe(false);
      // A refusal records nothing, so it cannot push the window out.
      expect(await store.tryClaim("maker-a", 10_999, PARAMS)).toBe(false);
      expect(await store.tryClaim("maker-a", 11_000, PARAMS)).toBe(true);
    });

    it("keeps makers apart", async () => {
      const store = makeStore();
      expect(await store.tryClaim("maker-a", 10_000, PARAMS)).toBe(true);
      expect(await store.tryClaim("maker-a", 10_000, PARAMS)).toBe(true);
      expect(await store.tryClaim("maker-a", 10_000, PARAMS)).toBe(false);
      expect(await store.tryClaim("maker-b", 10_000, PARAMS)).toBe(true);
    });

    it("maxBoards 0 refuses every claim", async () => {
      const store = makeStore();
      expect(await store.tryClaim("maker-a", 10_000, { maxBoards: 0, windowMs: 1_000 })).toBe(false);
      expect(await store.tryClaim("maker-a", 20_000, { maxBoards: 0, windowMs: 1_000 })).toBe(false);
    });

    it("concurrent claims for the last slot: exactly one wins", async () => {
      const store = makeStore();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.tryClaim("maker-a", 10_000, PARAMS)),
      );
      expect(results.filter(Boolean)).toHaveLength(PARAMS.maxBoards);
    });

    it("rejects an empty or path-like key", async () => {
      const store = makeStore();
      await expect(store.tryClaim("", 10_000, PARAMS)).rejects.toThrow(RangeError);
      await expect(store.tryClaim("a/b", 10_000, PARAMS)).rejects.toThrow(RangeError);
    });
  });
}
