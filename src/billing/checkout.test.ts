import { describe, expect, it } from "vitest";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { MockCheckout } from "./mock-checkout";
import { describeMockCheckoutBehaviour, seedBoard, CONTRACT_SLUG as SLUG } from "./mock-checkout.contract";
import { OffCheckout } from "./off-checkout";
import { createCheckout } from "./server";

describeMockCheckoutBehaviour("in-memory", () => new InMemoryBoardRepository());

describe("Checkout adapters (PIN-103)", () => {
  it("off: always unavailable and writes nothing", async () => {
    const boards = new InMemoryBoardRepository();
    await seedBoard(boards);
    const before = await boards.getBoard(SLUG);
    const checkout = new OffCheckout();
    for (const plan of ["board", "host"] as const) {
      expect(await checkout.startCheckout({ slug: SLUG, plan })).toEqual({ status: "unavailable" });
    }
    expect(await boards.getBoard(SLUG)).toEqual(before);
  });

  it("createCheckout selects by mode", () => {
    const boards = new InMemoryBoardRepository();
    expect(createCheckout("off", { boards })).toBeInstanceOf(OffCheckout);
    expect(createCheckout("mock", { boards })).toBeInstanceOf(MockCheckout);
    // PIN-149: stripe sells credit packs only; the Plus-plan port stays off.
    expect(createCheckout("stripe", { boards })).toBeInstanceOf(OffCheckout);
  });
});
