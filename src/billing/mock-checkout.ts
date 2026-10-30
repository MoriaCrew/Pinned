import "server-only";
/**
 * PLUS_MODE=mock (demo only): grants Board Plus instantly through
 * the BoardRepository with source "mock" — no money moves, and the
 * stored source keeps a mock grant distinguishable from a paid one
 * forever. The whole decision (decideMockGrant) runs INSIDE the
 * repository write, so concurrent requests cannot race it: a
 * covering grant is kept (host beats board in either order) and a
 * paid (stripe) grant is never replaced — a request it does not
 * cover answers "unavailable". The host plan is recorded on this
 * board only for now (no host account yet; docs/15).
 */
import type { BoardRepository } from "../domain/board-repository";
import { decideMockGrant, planCovers } from "../domain/plus";
import {
  BoardNotFoundError,
  type Checkout,
  type CheckoutRequest,
  type CheckoutResult,
} from "./checkout";

export interface MockCheckoutDeps {
  boards: BoardRepository;
  now?: () => number;
}

export class MockCheckout implements Checkout {
  constructor(private readonly deps: MockCheckoutDeps) {}

  async startCheckout({ slug, plan }: CheckoutRequest): Promise<CheckoutResult> {
    const now = this.deps.now?.() ?? Date.now();
    const updated = await this.deps.boards.updateBoardSettings(slug, (current) => {
      const decision = decideMockGrant(current.plus, plan, now);
      return decision.kind === "grant" ? { plus: decision.plus } : null;
    });
    if (!updated) throw new BoardNotFoundError(slug);
    // Answer from what is stored: covered (kept or just granted) or
    // blocked by a paid grant the mock may not replace.
    if (updated.plus != null && planCovers(updated.plus.plan, plan)) {
      return { status: "granted", plus: updated.plus };
    }
    return { status: "unavailable" };
  }
}
