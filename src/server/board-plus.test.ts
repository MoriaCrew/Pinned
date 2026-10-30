import { describe, expect, it, vi } from "vitest";
import { BoardNotFoundError, type Checkout } from "../billing/checkout";
import { MockCheckout } from "../billing/mock-checkout";
import { OffCheckout } from "../billing/off-checkout";
import { emptyBoardCounters } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { PLUS_SKIN_IDS, type BoardPlus, type PlusMode } from "../domain/plus";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy } from "../policy/policy";
import { createBoardWithHost, getBoardView, type BoardApiDeps } from "./board-api";
import { BoardPlusError, changeBoardSkin, startBoardPlus } from "./board-plus";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import { issueHostCredential } from "./host-session";

const T0 = Date.UTC(2026, 9, 30, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const policy = resolvePolicy({ plus: { priceLabels: { board: "$1.00" }, hostCookieDays: 3 } });
const LABELS = { board: "$1.00", host: "$4.99/month" };
const PLUS_SKIN = PLUS_SKIN_IDS[0];
const FREE_SKIN = "cork";
const MOCK_GRANT: BoardPlus = { plan: "board", source: "mock", grantedAt: T0 };
const PAID_GRANT: BoardPlus = { plan: "board", source: "stripe", grantedAt: T0 };

function harness(plusMode: PlusMode = "mock") {
  const boards = new InMemoryBoardRepository();
  let seq = 0;
  let now = T0;
  const deps: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store: new InMemoryDerivativeStore(),
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    policy,
    plusMode,
    now: () => now,
    createSlug: () => `plus-slug-${String(++seq).padStart(12, "0")}`,
  };
  const host = { boards, policy, plusMode, now: () => now };
  const withCheckout = (checkout: Checkout) => ({ ...host, checkout });
  const grant = (slug: string, plus: BoardPlus) => boards.updateBoardSettings(slug, () => ({ plus }));
  return {
    boards,
    deps,
    host,
    withCheckout,
    grant,
    setNow: (value: number) => {
      now = value;
    },
  };
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
  it("403 for no, wrong, other-board or expired tokens and for unknown boards", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Skins" }, h.deps);
    const other = await createBoardWithHost({ title: "Other" }, h.deps);
    for (const token of [null, issueHostCredential(T0).token, other.hostToken]) {
      await expectPlusError(changeBoardSkin(board.slug, token, { skinId: FREE_SKIN }, h.host), 403, "host_only");
    }
    await expectPlusError(changeBoardSkin("missing-board", hostToken, { skinId: FREE_SKIN }, h.host), 403);
    h.setNow(T0 + 3 * DAY_MS + 1);
    await expectPlusError(changeBoardSkin(board.slug, hostToken, { skinId: FREE_SKIN }, h.host), 403);
    expect((await h.boards.getBoard(board.slug))?.version).toBe(1);
  });

  it("unknown or missing skin ids are 400", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Skins" }, h.deps);
    for (const input of [{ skinId: "velvet" }, { skinId: 7 }, {}, null, FREE_SKIN, [FREE_SKIN]]) {
      await expectPlusError(changeBoardSkin(board.slug, hostToken, input, h.host), 400, "skin_unknown");
    }
  });

  it("Plus skins need an entitlement (402); free skins persist; same skin is a no-op", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Skins", themeId: "cat" }, h.deps);
    expect(board.theme).toBeDefined();
    await expectPlusError(changeBoardSkin(board.slug, hostToken, { skinId: PLUS_SKIN }, h.host), 402, "plus_required");
    expect(await h.boards.getBoard(board.slug)).toMatchObject({ themeId: "cat", version: 1 });

    const cork = await changeBoardSkin(board.slug, hostToken, { skinId: FREE_SKIN }, h.host);
    expect(cork).toMatchObject({ themeId: FREE_SKIN, version: 2 });
    // Skins carry no legacy palette: the old theme tokens are dropped.
    expect(cork).not.toHaveProperty("theme");
    expect(await h.boards.getBoard(board.slug)).toEqual(cork);

    const again = await changeBoardSkin(board.slug, hostToken, { skinId: FREE_SKIN }, h.host);
    expect(again).toEqual(cork);
    expect((await h.boards.getBoard(board.slug))?.version).toBe(2);

    await h.grant(board.slug, MOCK_GRANT);
    const plus = await changeBoardSkin(board.slug, hostToken, { skinId: PLUS_SKIN }, h.host);
    expect(plus).toMatchObject({ themeId: PLUS_SKIN, version: 4 });
  });

  it("a mock grant counts only in mock mode; a paid grant counts in off", async () => {
    const off = harness("off");
    const a = await createBoardWithHost({ title: "Mock grant" }, off.deps);
    await off.grant(a.board.slug, MOCK_GRANT);
    await expectPlusError(changeBoardSkin(a.board.slug, a.hostToken, { skinId: PLUS_SKIN }, off.host), 402);
    const b = await createBoardWithHost({ title: "Paid grant" }, off.deps);
    await off.grant(b.board.slug, PAID_GRANT);
    expect(await changeBoardSkin(b.board.slug, b.hostToken, { skinId: PLUS_SKIN }, off.host)).toMatchObject({
      themeId: PLUS_SKIN,
    });
  });

  it("a stored plus: null is a free board, never a crash", async () => {
    const h = harness();
    const { token: hostToken, record } = issueHostCredential(T0);
    const board = { slug: "plus-null-board-000001", title: "Null plus", plus: null, host: record };
    await h.boards.createBoard({ ...board, counters: emptyBoardCounters(), createdAt: T0, version: 1 });
    expect((await h.boards.getBoard(board.slug))?.plus).toBeNull();
    await expectPlusError(changeBoardSkin(board.slug, hostToken, { skinId: PLUS_SKIN }, h.host), 402);
    expect(await changeBoardSkin(board.slug, hostToken, { skinId: FREE_SKIN }, h.host)).toMatchObject({
      themeId: FREE_SKIN,
    });
    const view = await getBoardView(board.slug, null, h.deps, { hostToken });
    expect(view?.plus).toEqual({ active: false, mode: "mock", priceLabels: LABELS });
  });

  it("a new board cannot start on a Plus skin (402)", async () => {
    const h = harness();
    await expectPlusError(createBoardWithHost({ title: "Sneaky", themeId: PLUS_SKIN }, h.deps), 402, "plus_required");
  });
});

describe("startBoardPlus (PIN-103)", () => {
  it("host verified and plan validated before any checkout call", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Plus" }, h.deps);
    const checkout = { startCheckout: vi.fn() };
    await expectPlusError(startBoardPlus(board.slug, null, { plan: "board" }, h.withCheckout(checkout)), 403);
    await expectPlusError(startBoardPlus("missing-board", hostToken, { plan: "board" }, h.withCheckout(checkout)), 403);
    for (const input of [{ plan: "gold" }, {}, null]) {
      await expectPlusError(startBoardPlus(board.slug, hostToken, input, h.withCheckout(checkout)), 400, "plan_unknown");
    }
    expect(checkout.startCheckout).not.toHaveBeenCalled();
  });

  it("off: unavailable, nothing written", async () => {
    const h = harness("off");
    const { board, hostToken } = await createBoardWithHost({ title: "Plus" }, h.deps);
    const result = await startBoardPlus(board.slug, hostToken, { plan: "host" }, h.withCheckout(new OffCheckout()));
    expect(result).toEqual({ status: "unavailable" });
    expect(await h.boards.getBoard(board.slug)).toEqual(board);
  });

  it("mock: granted with the public view, entitlement persisted", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Plus" }, h.deps);
    const checkout = new MockCheckout({ boards: h.boards, now: () => T0 });
    const result = await startBoardPlus(board.slug, hostToken, { plan: "board" }, h.withCheckout(checkout));
    expect(result).toEqual({
      status: "granted",
      plus: { active: true, plan: "board", mode: "mock", priceLabels: LABELS },
    });
    expect((await h.boards.getBoard(board.slug))?.plus).toEqual(MOCK_GRANT);
  });

  it("passes a redirect through; only a typed not-found maps to 404", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "Plus" }, h.deps);
    const redirect: Checkout = {
      startCheckout: async () => ({ status: "redirect", url: "https://checkout.example/s" }),
    };
    expect(await startBoardPlus(board.slug, hostToken, { plan: "host" }, h.withCheckout(redirect))).toEqual({
      status: "redirect",
      url: "https://checkout.example/s",
    });
    const vanished: Checkout = {
      startCheckout: async () => {
        throw new BoardNotFoundError(board.slug);
      },
    };
    await expectPlusError(startBoardPlus(board.slug, hostToken, { plan: "host" }, h.withCheckout(vanished)), 404);
    const broken: Checkout = {
      startCheckout: async () => {
        throw new RangeError("unrelated");
      },
    };
    await expect(
      startBoardPlus(board.slug, hostToken, { plan: "host" }, h.withCheckout(broken)),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("board view Plus fields (PIN-103)", () => {
  it("defaults: not host without a token, Plus off and inactive, Policy labels", async () => {
    const h = harness("off");
    const { board } = await createBoardWithHost({ title: "View" }, h.deps);
    const view = await getBoardView(board.slug, null, h.deps);
    expect(view?.viewer).toEqual({ isHost: false });
    expect(view?.plus).toEqual({ active: false, mode: "off", priceLabels: LABELS });
  });

  it("verifies the host token and reports an active plan that counts", async () => {
    const h = harness();
    const { board, hostToken } = await createBoardWithHost({ title: "View" }, h.deps);
    await h.grant(board.slug, { plan: "host", source: "mock", grantedAt: T0 });
    const view = await getBoardView(board.slug, null, h.deps, { hostToken });
    expect(view?.viewer).toEqual({ isHost: true });
    expect(view?.plus).toEqual({ active: true, plan: "host", mode: "mock", priceLabels: LABELS });
    expect((await getBoardView(board.slug, null, h.deps, { hostToken: issueHostCredential(T0).token }))?.viewer).toEqual({
      isHost: false,
    });
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/grantedAt|"source"|tokenHash|issuedAt/);
    expect(json).not.toContain(hostToken);
  });
});
