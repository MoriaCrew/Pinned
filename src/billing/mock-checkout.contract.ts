/**
 * Mock checkout behaviour every BoardRepository must support
 * (PIN-103): run by src/billing/checkout.test.ts (memory) and
 * src/server/firestore-board-repository.test.ts (fake Firestore) —
 * the race cases are what the in-write decision exists for.
 */
import { describe, expect, it } from "vitest";
import { emptyBoardCounters, type Board } from "../domain/board";
import type { BoardRepository } from "../domain/board-repository";
import { BoardNotFoundError } from "./checkout";
import { MockCheckout } from "./mock-checkout";

export const CONTRACT_SLUG = "board-slug-00000000001";
const SLUG = CONTRACT_SLUG;

export async function seedBoard(boards: BoardRepository, overrides: Partial<Board> = {}) {
  await boards.createBoard({
    slug: SLUG,
    title: "Plus board",
    counters: emptyBoardCounters(),
    createdAt: 1_000,
    version: 1,
    ...overrides,
  });
}

export function describeMockCheckoutBehaviour(name: string, makeRepo: () => BoardRepository): void {
  describe(`MockCheckout on ${name} (PIN-103)`, () => {
    it("grants and persists a mock entitlement", async () => {
      const boards = makeRepo();
      await seedBoard(boards);
      const checkout = new MockCheckout({ boards, now: () => 5_000 });
      const plus = { plan: "board", source: "mock", grantedAt: 5_000 };
      expect(await checkout.startCheckout({ slug: SLUG, plan: "board" })).toEqual({
        status: "granted",
        plus,
      });
      expect(await boards.getBoard(SLUG)).toMatchObject({ plus, version: 2 });
    });

    it("idempotent when the held plan covers the request (no write, no bump)", async () => {
      const held = { plan: "host" as const, source: "mock" as const, grantedAt: 10 };
      const boards = makeRepo();
      await seedBoard(boards, { plus: held });
      const checkout = new MockCheckout({ boards, now: () => 9_999 });
      for (const plan of ["host", "board"] as const) {
        expect(await checkout.startCheckout({ slug: SLUG, plan })).toEqual({ status: "granted", plus: held });
      }
      expect((await boards.getBoard(SLUG))?.version).toBe(1);
    });

    it("a stored plus: null is a free board", async () => {
      const boards = makeRepo();
      await seedBoard(boards, { plus: null });
      const result = await new MockCheckout({ boards, now: () => 7 }).startCheckout({ slug: SLUG, plan: "board" });
      expect(result).toEqual({ status: "granted", plus: { plan: "board", source: "mock", grantedAt: 7 } });
    });

    it("host vs board race: host survives in either order", async () => {
      for (const order of [["host", "board"], ["board", "host"]] as const) {
        const boards = makeRepo();
        await seedBoard(boards);
        const checkout = new MockCheckout({ boards, now: () => 20 });
        const results = await Promise.all(order.map((plan) => checkout.startCheckout({ slug: SLUG, plan })));
        expect(results.every((r) => r.status === "granted")).toBe(true);
        expect((await boards.getBoard(SLUG))?.plus?.plan).toBe("host");
      }
    });

    it("never replaces a paid (stripe) grant, even racing", async () => {
      const paid = { plan: "board" as const, source: "stripe" as const, grantedAt: 10 };
      const boards = makeRepo();
      await seedBoard(boards, { plus: paid });
      const checkout = new MockCheckout({ boards, now: () => 30 });
      const [host, board] = await Promise.all([
        checkout.startCheckout({ slug: SLUG, plan: "host" }),
        checkout.startCheckout({ slug: SLUG, plan: "board" }),
      ]);
      expect(host).toEqual({ status: "unavailable" });
      expect(board).toEqual({ status: "granted", plus: paid });
      expect(await boards.getBoard(SLUG)).toMatchObject({ plus: paid, version: 1 });
    });

    it("a missing board is a typed BoardNotFoundError, never a grant", async () => {
      await expect(
        new MockCheckout({ boards: makeRepo() }).startCheckout({ slug: SLUG, plan: "board" }),
      ).rejects.toBeInstanceOf(BoardNotFoundError);
    });
  });
}
