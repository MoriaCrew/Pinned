import { describe, expect, it, vi } from "vitest";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryCreditLedgerStore } from "../domain/credit-ledger";
import { makerKey } from "../domain/maker-key";
import { InMemoryStarterAllowanceStore, type StarterAllowanceStore } from "../domain/starter-allowance";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy, type PolicyOverrides } from "../policy/policy";
import { createBoardWithHost, getBoardView, type BoardApiDeps, type CreateBoardContext } from "./board-api";
import { starterEventId } from "./credit-pool";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import { requestMakerKey } from "./maker-context";

/**
 * Free creations per maker (PIN-205, docs/15 "Free creations
 * rule"): only a maker's first credits.starterBoardsPerMaker new
 * boards per window get the starter pool. Credits off or no maker
 * context keeps creation exactly as before.
 */
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);
const WEEK = 604_800_000;
const ON: PolicyOverrides = { credits: { enabled: true, starterMakes: 5, starterBoardsPerMaker: 3 } };
const MAKER_A: CreateBoardContext = { makerKey: makerKey({ clientIp: "203.0.113.7" }) };
const MAKER_B: CreateBoardContext = { makerKey: makerKey({ clientIp: "198.51.100.9" }) };

function harness(overrides: PolicyOverrides, starterAllowance?: StarterAllowanceStore | null) {
  const boards = new InMemoryBoardRepository();
  const ledger = new InMemoryCreditLedgerStore();
  const allowance = starterAllowance === undefined ? new InMemoryStarterAllowanceStore() : starterAllowance;
  let now = T0;
  const deps: BoardApiDeps = {
    boards,
    jobs: new InMemoryDecomposeJobStore(),
    store: new InMemoryDerivativeStore(),
    namer: mockElementNamer,
    segmenter: mockSegmenter,
    credits: ledger,
    ...(allowance ? { starterAllowance: allowance } : {}),
    policy: resolvePolicy(overrides),
    now: () => now,
  };
  return {
    deps,
    boards,
    ledger,
    advance(ms: number) {
      now += ms;
    },
    async create(context?: CreateBoardContext) {
      const { board } = await createBoardWithHost({ title: "Family board" }, deps, context);
      return board.slug;
    },
  };
}

describe("free creations per maker (PIN-205)", () => {
  it("a maker's first N boards get the pool; the next starts at 0; another maker is unaffected", async () => {
    const h = harness(ON);
    const firstThree = [await h.create(MAKER_A), await h.create(MAKER_A), await h.create(MAKER_A)];
    for (const slug of firstThree) {
      expect((await h.boards.getBoard(slug))?.starterMakes).toBe(5);
      expect((await h.ledger.getBalance(slug)).available).toBe(5);
    }
    const fourth = await h.create(MAKER_A);
    expect((await h.boards.getBoard(fourth))?.starterMakes).toBe(0);
    // Starter marked granted at 0, so polls stay one head read (PIN-179).
    expect(await h.ledger.getBalance(fourth)).toMatchObject({ available: 0, starterGranted: true });
    expect((await getBoardView(fourth, null, h.deps))?.credits).toEqual({ availableMakes: 0 });
    expect((await h.ledger.getBalance(await h.create(MAKER_B))).available).toBe(5);
  });

  it("the window refills a maker's free boards", async () => {
    const h = harness(ON);
    for (let i = 0; i < 3; i += 1) await h.create(MAKER_A);
    expect((await h.ledger.getBalance(await h.create(MAKER_A))).available).toBe(0);
    h.advance(WEEK);
    expect((await h.ledger.getBalance(await h.create(MAKER_A))).available).toBe(5);
  });

  it("credits off: no claim, no stored field, no ledger write (unchanged creation)", async () => {
    const store = new InMemoryStarterAllowanceStore();
    const claim = vi.spyOn(store, "tryClaim");
    const h = harness({}, store);
    const slug = await h.create(MAKER_A);
    expect(claim).not.toHaveBeenCalled();
    expect(await h.boards.getBoard(slug)).not.toHaveProperty("starterMakes");
    expect(await h.ledger.getAccount(slug)).toBeNull();
  });

  it("no maker context (internal callers): no claim, Policy pool, no stored field", async () => {
    const store = new InMemoryStarterAllowanceStore();
    const claim = vi.spyOn(store, "tryClaim");
    const h = harness(ON, store);
    const slug = await h.create();
    expect(claim).not.toHaveBeenCalled();
    expect(await h.boards.getBoard(slug)).not.toHaveProperty("starterMakes");
    expect((await h.ledger.getBalance(slug)).available).toBe(5);
  });

  it("fails closed to 0 when the counter throws or no store is wired; creation still succeeds", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken: StarterAllowanceStore = {
      tryClaim: async () => {
        throw new Error("contention");
      },
    };
    const h = harness(ON, broken);
    const slug = await h.create(MAKER_A);
    expect((await h.boards.getBoard(slug))?.starterMakes).toBe(0);
    expect((await h.ledger.getBalance(slug)).available).toBe(0);
    expect(errors).toHaveBeenCalledWith("starter allowance claim failed", expect.anything());
    errors.mockRestore();

    const unwired = harness(ON, null);
    expect((await unwired.ledger.getBalance(await unwired.create(MAKER_A))).available).toBe(0);
  });

  it("a failed grant at creation is repaired lazily with the stored amount, never the full pool", async () => {
    const h = harness(ON);
    for (let i = 0; i < 3; i += 1) await h.create(MAKER_A);
    const grant = vi.spyOn(h.ledger, "grantStarter").mockRejectedValueOnce(new Error("blip"));
    const slug = await h.create(MAKER_A);
    expect(grant).toHaveBeenCalledTimes(1);
    expect(await h.ledger.getAccount(slug)).toBeNull();
    expect((await getBoardView(slug, null, h.deps))?.credits).toEqual({ availableMakes: 0 });
    expect((await h.ledger.listEntries(slug)).map((e) => [e.id, e.amount])).toEqual([
      [starterEventId(slug), 0],
    ]);
  });

  it("a slug retry claims one maker slot, not two", async () => {
    const store = new InMemoryStarterAllowanceStore();
    const claim = vi.spyOn(store, "tryClaim");
    const h = harness(ON, store);
    const taken = await h.create();
    const slugs = [taken, "fresh-slug-fresh-slug1"];
    h.deps.createSlug = () => slugs.shift()!;
    expect(await h.create(MAKER_A)).toBe("fresh-slug-fresh-slug1");
    expect(claim).toHaveBeenCalledTimes(1);
  });
});

describe("requestMakerKey (PIN-205)", () => {
  const request = new Request("https://x.example/api/boards", {
    method: "POST",
    headers: { "x-forwarded-for": "203.0.113.7" },
  });

  it("uses the signed-in user when there is one, else the client address", async () => {
    expect(await requestMakerKey(request, async () => "uid-1")).toBe(makerKey({ userId: "uid-1" }));
    expect(await requestMakerKey(request, async () => null)).toBe(makerKey({ clientIp: "203.0.113.7" }));
  });

  it("a failing session read falls back to the address", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = await requestMakerKey(request, async () => {
      throw new Error("bad cookie");
    });
    expect(key).toBe(makerKey({ clientIp: "203.0.113.7" }));
    errors.mockRestore();
  });
});
