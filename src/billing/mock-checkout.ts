import "server-only";
/**
 * PLUS_MODE=mock (demo only): grants Board Plus instantly through
 * the BoardRepository with source "mock" — no money moves, and the
 * stored source keeps a mock grant distinguishable from a paid one
 * forever. Idempotent: a held plan that already covers the request
 * (same plan, or host covering board) is returned without a write.
 * The host plan is recorded on this board only for now (no host
 * account yet to hang cross-board coverage on; docs/15).
 */
import type { BoardRepository } from "../domain/board-repository";
import { grantPlus, planCovers } from "../domain/plus";
import type { Checkout, CheckoutRequest, CheckoutResult } from "./checkout";

export interface MockCheckoutDeps {
  boards: BoardRepository;
  now?: () => number;
}

export class MockCheckout implements Checkout {
  constructor(private readonly deps: MockCheckoutDeps) {}

  async startCheckout({ slug, plan }: CheckoutRequest): Promise<CheckoutResult> {
    const board = await this.deps.boards.getBoard(slug);
    if (!board) throw new RangeError(`Board ${slug} not found`);
    if (board.plus && planCovers(board.plus.plan, plan)) {
      return { status: "granted", plus: board.plus };
    }
    const now = this.deps.now?.() ?? Date.now();
    const updated = await this.deps.boards.updateBoardSettings(slug, {
      plus: grantPlus(plan, "mock", now),
    });
    if (!updated?.plus) throw new RangeError(`Board ${slug} not found`);
    return { status: "granted", plus: updated.plus };
  }
}
