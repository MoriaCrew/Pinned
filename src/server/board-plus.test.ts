import { describe, expect, it, vi } from "vitest";
import type { Checkout } from "../billing/checkout";
import { MockCheckout } from "../billing/mock-checkout";
import { OffCheckout } from "../billing/off-checkout";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { getBoardTheme } from "../domain/board-themes";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy } from "../policy/policy";
import { createBoard, getBoardView, type BoardApiDeps } from "./board-api";
import { BoardPlusError, changeBoardSkin, startBoardPlus } from "./board-plus";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";

// The skin registry (board-themes.ts) gains the PIN-103 skin ids in
// a parallel change. Extend it here so these tests pin the gate
// logic, not the registry contents; real ids keep working too.
vi.mock("../domain/board-themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../domain/board-themes")>();
  const skins = ["paper", "cork", "fridge", "zine", "darkroom", "postcard", "marigold"];
  return {
    ...actual,
    isBoardThemeId: (value: unknown): value is string =>
      actual.isBoardThemeId(value) || (typeof value === "string" && skins.includes(value)),
  };
});

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const policy = resolvePolicy({ plus: { priceLabels: { board: "$1.00" } } });
const LABELS = { board: "$1.00", host: "$4.99/month" };

function harness() {
  const boards = new InMemoryBoardRepository();
  let seq = 0;
  const deps: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store: new InMemoryDerivativeStore(),
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    policy,
    now: () => T0,
    createSlug: () => `plus-slug-${String(++seq).padStart(12, "0")}`,
  };
  const plusDeps = (checkout: Checkout, plusMode: "off" | "mock" = "mock") => ({
    boards,
    checkout,
    policy,
    plusMode,
  });
  return { boards, deps, plusDeps };
}

async function expectPlusError(promise: Promise<unknown>, status: number, code?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(BoardPlusError);
  expect(error).toMatchObject({ status, ...(code ? { code } : {}) });
}

describe("changeBoardSkin (PIN-103)", () => {
  it("non-hosts get 403 whether or not the board exists", async () => {
    const h = harness();
    const board = await createBoard({ title: "Skins" }, h.deps);
    await expectPlusError(changeBoardSkin(board.slug, false, { skinId: "cork" }, h), 403, "host_only");
    await expectPlusError(changeBoardSkin("missing-board", false, { skinId: "cork" }, h), 403);
    await expectPlusError(changeBoardSkin("missing-board", true, { skinId: "cork" }, h), 404);
    expect((await h.boards.getBoard(board.slug))?.version).toBe(1);
  });

  it("unknown or missing skin ids are 400", async () => {
    const h = harness();
    const board = await createBoard({ title: "Skins" }, h.deps);
    for (const input of [{ skinId: "velvet" }, { skinId: 7 }, {}, null, "cork", ["cork"]]) {
      await expectPlusError(changeBoardSkin(board.slug, true, input, h), 400, "skin_unknown");
    }
  });

  it("Plus skins need the entitlement (402); free skins persist with a version bump", async () => {
    const h = harness();
    const board = await createBoard({ title: "Skins", themeId: "cat" }, h.deps);
    await expectPlusError(
      changeBoardSkin(board.slug, true, { skinId: "darkroom" }, h),
      402,
      "plus_required",
    );
    expect((await h.boards.getBoard(board.slug))?.themeId).toBe("cat");

    const cork = await changeBoardSkin(board.slug, true, { skinId: "cork" }, h);
    expect(cork).toMatchObject({ themeId: "cork", version: 2 });
    // Theme tokens follow the registry; an id without tokens drops the old palette.
    expect(cork.theme).toEqual(getBoardTheme("cork")?.tokens);
    expect(await h.boards.getBoard(board.slug)).toEqual(cork);

    await h.boards.updateBoardSettings(board.slug, {
      plus: { plan: "board", source: "mock", grantedAt: T0 },
    });
    const dark = await changeBoardSkin(board.slug, true, { skinId: "darkroom" }, h);
    expect(dark).toMatchObject({ themeId: "darkroom", version: 4 });
  });

  it("a new board cannot start on a Plus skin (402)", async () => {
    const h = harness();
    await expectPlusError(
      createBoard({ title: "Sneaky", themeId: "marigold" }, h.deps),
      402,
      "plus_required",
    );
  });
});

describe("startBoardPlus (PIN-103)", () => {
  it("host only, plan validated, before any checkout call", async () => {
    const h = harness();
    const board = await createBoard({ title: "Plus" }, h.deps);
    const checkout = { startCheckout: vi.fn() };
    await expectPlusError(startBoardPlus(board.slug, false, { plan: "board" }, h.plusDeps(checkout)), 403);
    await expectPlusError(startBoardPlus("missing-board", true, { plan: "board" }, h.plusDeps(checkout)), 404);
    for (const input of [{ plan: "gold" }, {}, null]) {
      await expectPlusError(startBoardPlus(board.slug, true, input, h.plusDeps(checkout)), 400, "plan_unknown");
    }
    expect(checkout.startCheckout).not.toHaveBeenCalled();
  });

  it("off: unavailable, nothing written", async () => {
    const h = harness();
    const board = await createBoard({ title: "Plus" }, h.deps);
    const result = await startBoardPlus(board.slug, true, { plan: "host" }, h.plusDeps(new OffCheckout(), "off"));
    expect(result).toEqual({ status: "unavailable" });
    expect(await h.boards.getBoard(board.slug)).toEqual(board);
  });

  it("mock: granted with the public view, entitlement persisted", async () => {
    const h = harness();
    const board = await createBoard({ title: "Plus" }, h.deps);
    const checkout = new MockCheckout({ boards: h.boards, now: () => T0 });
    const result = await startBoardPlus(board.slug, true, { plan: "board" }, h.plusDeps(checkout));
    expect(result).toEqual({
      status: "granted",
      plus: { active: true, plan: "board", mode: "mock", priceLabels: LABELS },
    });
    expect((await h.boards.getBoard(board.slug))?.plus).toEqual({
      plan: "board",
      source: "mock",
      grantedAt: T0,
    });
  });

  it("passes a redirect through and maps a vanished board to 404", async () => {
    const h = harness();
    const board = await createBoard({ title: "Plus" }, h.deps);
    const redirect: Checkout = {
      startCheckout: async () => ({ status: "redirect", url: "https://checkout.example/s" }),
    };
    expect(await startBoardPlus(board.slug, true, { plan: "host" }, h.plusDeps(redirect))).toEqual({
      status: "redirect",
      url: "https://checkout.example/s",
    });
    const vanished: Checkout = {
      startCheckout: async () => {
        throw new RangeError("gone");
      },
    };
    await expectPlusError(startBoardPlus(board.slug, true, { plan: "host" }, h.plusDeps(vanished)), 404);
  });
});

describe("board view Plus fields (PIN-103)", () => {
  it("defaults: not host, Plus off and inactive, Policy labels", async () => {
    const h = harness();
    const board = await createBoard({ title: "View" }, h.deps);
    const view = await getBoardView(board.slug, null, h.deps);
    expect(view?.viewer).toEqual({ isHost: false });
    expect(view?.plus).toEqual({ active: false, mode: "off", priceLabels: LABELS });
  });

  it("reflects the host bit, mode and an active plan", async () => {
    const h = harness();
    const board = await createBoard({ title: "View" }, h.deps);
    await h.boards.updateBoardSettings(board.slug, {
      plus: { plan: "host", source: "mock", grantedAt: T0 },
    });
    const view = await getBoardView(board.slug, null, h.deps, { isHost: true, plusMode: "mock" });
    expect(view?.viewer).toEqual({ isHost: true });
    expect(view?.plus).toEqual({ active: true, plan: "host", mode: "mock", priceLabels: LABELS });
    expect(JSON.stringify(view)).not.toMatch(/grantedAt|"source"/);
  });
});
