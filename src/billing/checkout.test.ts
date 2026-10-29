import { describe, expect, it } from "vitest";
import { emptyBoardCounters, type Board } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { MockCheckout } from "./mock-checkout";
import { OffCheckout } from "./off-checkout";
import { createCheckout } from "./server";

const SLUG = "board-slug-00000000001";

async function repoWithBoard(overrides: Partial<Board> = {}) {
  const boards = new InMemoryBoardRepository();
  await boards.createBoard({
    slug: SLUG,
    title: "Plus board",
    counters: emptyBoardCounters(),
    createdAt: 1_000,
    version: 1,
    ...overrides,
  });
  return boards;
}

describe("Checkout adapters (PIN-103)", () => {
  it("off: always unavailable and writes nothing", async () => {
    const boards = await repoWithBoard();
    const before = await boards.getBoard(SLUG);
    const checkout = new OffCheckout();
    expect(await checkout.startCheckout({ slug: SLUG, plan: "board" })).toEqual({
      status: "unavailable",
    });
    expect(await checkout.startCheckout({ slug: SLUG, plan: "host" })).toEqual({
      status: "unavailable",
    });
    expect(await boards.getBoard(SLUG)).toEqual(before);
  });

  it("mock: grants and persists a mock entitlement", async () => {
    const boards = await repoWithBoard();
    const checkout = new MockCheckout({ boards, now: () => 5_000 });
    const result = await checkout.startCheckout({ slug: SLUG, plan: "board" });
    const plus = { plan: "board", source: "mock", grantedAt: 5_000 };
    expect(result).toEqual({ status: "granted", plus });
    expect(await boards.getBoard(SLUG)).toMatchObject({ plus, version: 2 });
  });

  it("mock: idempotent when the held plan already covers the request", async () => {
    const held = { plan: "host" as const, source: "mock" as const, grantedAt: 10 };
    const boards = await repoWithBoard({ plus: held });
    const checkout = new MockCheckout({ boards, now: () => 9_999 });
    for (const plan of ["host", "board"] as const) {
      expect(await checkout.startCheckout({ slug: SLUG, plan })).toEqual({
        status: "granted",
        plus: held,
      });
    }
    expect((await boards.getBoard(SLUG))?.version).toBe(1);
  });

  it("mock: board -> host upgrades the stored plan", async () => {
    const boards = await repoWithBoard({
      plus: { plan: "board", source: "mock", grantedAt: 10 },
    });
    const checkout = new MockCheckout({ boards, now: () => 20 });
    const result = await checkout.startCheckout({ slug: SLUG, plan: "host" });
    expect(result).toEqual({
      status: "granted",
      plus: { plan: "host", source: "mock", grantedAt: 20 },
    });
    expect((await boards.getBoard(SLUG))?.plus?.plan).toBe("host");
  });

  it("mock: a missing board is a RangeError, never a grant", async () => {
    const boards = new InMemoryBoardRepository();
    await expect(
      new MockCheckout({ boards }).startCheckout({ slug: SLUG, plan: "board" }),
    ).rejects.toThrow(RangeError);
  });

  it("createCheckout selects by mode", () => {
    const boards = new InMemoryBoardRepository();
    expect(createCheckout("off", { boards })).toBeInstanceOf(OffCheckout);
    expect(createCheckout("mock", { boards })).toBeInstanceOf(MockCheckout);
  });
});
