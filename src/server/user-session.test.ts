import { describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type Participant } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { signPlayerCookie, signUserCookie } from "../domain/tokens";
import { InMemoryUserRepository } from "../domain/user-repository";
import { mockElementNamer, mockSegmenter } from "../gateway/mock-ports";
import { resolvePolicy } from "../policy/policy";
import { createBoard, getBoardView, type BoardApiDeps } from "./board-api";
import {
  BoardApiError,
  joinBoard,
  publicParticipant,
  type BoardSessionDeps,
} from "./board-session";
import { InMemoryDecomposeJobStore } from "./decompose-job";
import { InMemoryDerivativeStore } from "./derivative-store";
import { FakeTokenVerifier } from "./token-verifier";
import {
  claimParticipantForUser,
  establishUserSession,
  findClaimedParticipant,
  isFreshAuth,
  linkParticipantOnJoin,
  linkParticipantToUser,
  resolveUserSession,
  resolveUserSessionContext,
  type ClaimDeps,
  type EstablishUserSessionDeps,
} from "./user-session";

const SECRET = "test-secret-test-secret-test-secret-32";
const SLUG = "AAAAAAAAAAAAAAAAAAAAAQ";
const T0 = Date.UTC(2026, 9, 29, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

const ALICE = {
  uid: "synthetic-alice",
  displayName: "Alice A",
  photoUrl: "https://example.test/alice.png",
};
const BOB = { uid: "synthetic-bob" };

interface Harness {
  boards: InMemoryBoardRepository;
  users: InMemoryUserRepository;
  deps: EstablishUserSessionDeps;
  setNow(now: number): void;
  getNow(): number;
  /** Fresh claim deps anchored at the harness clock (PIN-94). */
  claimDeps(authTimeMs?: number): ClaimDeps;
}

function makeHarness(): Harness {
  const boards = new InMemoryBoardRepository();
  const users = new InMemoryUserRepository();
  const policy = resolvePolicy();
  let now = T0;
  return {
    boards,
    users,
    deps: {
      users,
      sessionSecret: SECRET,
      policy,
      now: () => now,
      verifier: new FakeTokenVerifier(
        {
          "token-alice": ALICE,
          "token-bob": BOB,
          // PIN-94 fixtures: wrong provider, missing provider,
          // revoked token, and a stale (2h-old) sign-in.
          "token-anon": { uid: "synthetic-anon", signInProvider: "anonymous" },
          "token-no-provider": { uid: "synthetic-noprov", signInProvider: "" },
          "token-revoked": { uid: "synthetic-revoked", revoked: true },
          "token-stale": {
            uid: "synthetic-stale",
            authTimeMs: T0 - 2 * 60 * 60 * 1000,
          },
        },
        () => now,
      ),
    },
    setNow(value: number) {
      now = value;
    },
    getNow() {
      return now;
    },
    claimDeps(authTimeMs?: number) {
      return {
        boards,
        users,
        policy,
        authTimeMs: authTimeMs ?? now,
        now: () => now,
      };
    },
  };
}

async function seedParticipant(
  h: Harness,
  overrides: Partial<Participant> = {},
): Promise<Participant> {
  await h.boards.createBoard({
    slug: SLUG,
    title: "Claim test board",
    counters: emptyBoardCounters(),
    createdAt: T0,
    version: 1,
  });
  const participant: Participant = {
    id: "part-1",
    boardId: SLUG,
    displayName: "Aye",
    cookieSecretHash: "hash",
    createdAt: T0,
    ...overrides,
  };
  await h.boards.putParticipant(participant);
  return participant;
}

async function establish(h: Harness, idToken: string) {
  return establishUserSession({ idToken }, h.deps);
}

describe("user session (PIN-83)", () => {
  it("establishes a session, stores the minimal profile (never email), resolves back", async () => {
    const h = makeHarness();
    const result = await establish(h, "token-alice");
    expect(result.user).toEqual({
      uid: "synthetic-alice",
      displayName: "Alice A",
      photoUrl: "https://example.test/alice.png",
      createdAt: T0,
      updatedAt: T0,
    });
    expect(result.user).not.toHaveProperty("email");
    expect(await h.users.getUser("synthetic-alice")).toEqual(result.user);
    expect(result.cookieExpiresAt).toBe(T0 + 30 * DAY_MS);
    expect(await resolveUserSession(result.cookieValue, h.deps)).toEqual(result.user);

    // Re-establish later: createdAt preserved, updatedAt bumps.
    h.setNow(T0 + DAY_MS);
    const again = await establish(h, "token-alice");
    expect(again.user.createdAt).toBe(T0);
    expect(again.user.updatedAt).toBe(T0 + DAY_MS);
  });

  it("fails closed: bad token 401, missing token 400, unconfigured secret 503", async () => {
    const h = makeHarness();
    await expect(establish(h, "not-a-token")).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
    await expect(establishUserSession({}, h.deps)).rejects.toMatchObject({ status: 400 });
    await expect(
      establishUserSession({ idToken: "token-alice" }, { ...h.deps, sessionSecret: null }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await h.users.listUserBoards("synthetic-alice")).toEqual([]);
  });

  it("rejects tampered, cross-type, expired and orphaned cookies", async () => {
    const h = makeHarness();
    const { cookieValue } = await establish(h, "token-alice");
    const tampered =
      cookieValue.slice(0, -1) + (cookieValue.endsWith("A") ? "B" : "A");
    expect(await resolveUserSession(tampered, h.deps)).toBeNull();

    const playerCookie = signPlayerCookie(
      { gameId: SLUG, playerId: "part-1", issuedAt: T0 },
      SECRET,
    );
    expect(await resolveUserSession(playerCookie, h.deps)).toBeNull();

    // Cookie older than Policy.userSessionDays no longer resolves.
    h.setNow(T0 + 31 * DAY_MS);
    expect(await resolveUserSession(cookieValue, h.deps)).toBeNull();
    h.setNow(T0);

    // A validly signed cookie for a profile that does not exist: null.
    const orphan = await establish(h, "token-bob");
    const fresh = makeHarness();
    expect(await resolveUserSession(orphan.cookieValue, fresh.deps)).toBeNull();
  });

  it("claim matrix: empty -> set + index, same -> ok, other -> 409", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h);
    const alice = (await establish(h, "token-alice")).user;
    const bob = (await establish(h, "token-bob")).user;

    // Empty -> set, index written.
    const claimed = await claimParticipantForUser(participant, alice, h.claimDeps());
    expect(claimed.userId).toBe("synthetic-alice");
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBe(
      "synthetic-alice",
    );
    expect(await h.users.getUserBoard("synthetic-alice", SLUG)).toEqual({
      boardId: SLUG,
      participantId: "part-1",
      claimedAt: T0,
      updatedAt: T0,
    });

    // Same user again -> ok, claimedAt preserved, updatedAt refreshed.
    // (A day later the claim carries a fresh sign-in at the new
    // clock: h.claimDeps() anchors auth_time at now, PIN-94.)
    h.setNow(T0 + DAY_MS);
    const reclaim = await claimParticipantForUser(claimed, alice, h.claimDeps());
    expect(reclaim.userId).toBe("synthetic-alice");
    expect(await h.users.getUserBoard("synthetic-alice", SLUG)).toEqual({
      boardId: SLUG,
      participantId: "part-1",
      claimedAt: T0,
      updatedAt: T0 + DAY_MS,
    });

    // Other user -> 409, nothing changes for either store.
    await expect(claimParticipantForUser(claimed, bob, h.claimDeps())).rejects.toMatchObject({
      status: 409,
      code: "claim_conflict",
    });
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBe(
      "synthetic-alice",
    );
    expect(await h.users.listUserBoards("synthetic-bob")).toEqual([]);
  });

  it("join auto-link: null user untouched, empty claimed, conflict silently left", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h);
    const alice = (await establish(h, "token-alice")).user;
    const bob = (await establish(h, "token-bob")).user;
    const deps = h.claimDeps();

    expect(await linkParticipantOnJoin(participant, null, deps)).toEqual(participant);

    const linked = await linkParticipantOnJoin(participant, alice, deps);
    expect(linked.userId).toBe("synthetic-alice");
    expect(await h.users.getUserBoard("synthetic-alice", SLUG)).not.toBeNull();

    // A different signed-in user joining never overwrites or throws.
    const after = await linkParticipantOnJoin(linked, bob, deps);
    expect(after.userId).toBe("synthetic-alice");
    expect(await h.users.listUserBoards("synthetic-bob")).toEqual([]);
  });

  it("flag-off parity: the pre-PIN-83 board flow shape is byte-identical", async () => {
    // The link-only contract: with no sign-in anywhere, the
    // participant record, its public shape and the board view
    // carry exactly the pre-PIN-83 fields — no userId key, ever.
    const boards = new InMemoryBoardRepository();
    const policy = resolvePolicy();
    const deps: BoardApiDeps = {
      boards,
      jobs: new InMemoryDecomposeJobStore(),
      store: new InMemoryDerivativeStore(),
      namer: mockElementNamer,
      segmenter: mockSegmenter,
      policy,
      now: () => T0,
      createSlug: () => SLUG,
    };
    const session: BoardSessionDeps = {
      boards,
      sessionSecret: SECRET,
      policy,
      now: () => T0,
      createParticipantId: () => "part-fixed",
    };
    const board = await createBoard({ title: "Parity board" }, deps);
    expect(board.slug).toBe(SLUG);
    const joined = await joinBoard(SLUG, { displayName: "Aye" }, null, session);

    expect(joined.participant).not.toHaveProperty("userId");
    expect(Object.keys(joined.participant).sort()).toEqual([
      "boardId",
      "cookieSecretHash",
      "createdAt",
      "displayName",
      "id",
    ]);
    expect(publicParticipant(joined.participant)).toEqual({
      id: "part-fixed",
      boardId: SLUG,
      displayName: "Aye",
      hasReclaimPin: false,
      createdAt: T0,
    });

    const view = await getBoardView(SLUG, joined.participant, deps);
    expect(view).not.toBeNull();
    expect(Object.keys(view!)).toEqual([
      "board",
      "me",
      "participants",
      "pins",
      "elements",
      "scenes",
      "activity",
      // PIN-103 (additive, not auth): host bit + Plus offer.
      "viewer",
      "plus",
    ]);
    expect(view!.viewer).toEqual({ isHost: false, canChangeLook: false });
    expect(view!.me).toEqual({
      id: "part-fixed",
      boardId: SLUG,
      displayName: "Aye",
      hasReclaimPin: false,
      createdAt: T0,
    });
    expect(view!.participants).toEqual([
      {
        id: "part-fixed",
        boardId: SLUG,
        displayName: "Aye",
        hasReclaimPin: false,
        createdAt: T0,
      },
    ]);
  });

  it("PIN-94: wrong or missing provider is the uniform 401, no profile stored", async () => {
    const h = makeHarness();
    for (const token of ["token-anon", "token-no-provider"]) {
      await expect(establish(h, token)).rejects.toMatchObject({
        status: 401,
        code: "invalid_token",
      });
    }
    expect(await h.users.getUser("synthetic-anon")).toBeNull();
    expect(await h.users.getUser("synthetic-noprov")).toBeNull();
  });

  it("PIN-94: a revoked token is 401 at session exchange", async () => {
    const h = makeHarness();
    await expect(establish(h, "token-revoked")).rejects.toMatchObject({
      status: 401,
      code: "invalid_token",
    });
    expect(await h.users.getUser("synthetic-revoked")).toBeNull();
  });

  it("PIN-160: stale auth_time reads and auto-links on join, but cannot claim or restore", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h);
    const staleAuth = T0 - 2 * 60 * 60 * 1000;

    // Session exchange itself succeeds; /api/me's resolve path is
    // unaffected, and the cookie carries the stale auth_time.
    const established = await establish(h, "token-stale");
    expect(await resolveUserSession(established.cookieValue, h.deps)).toEqual(
      established.user,
    );
    const context = await resolveUserSessionContext(established.cookieValue, h.deps);
    expect(context?.authTimeMs).toBe(staleAuth);

    // Explicit claim -> 401 stale_auth, nothing written.
    await expect(
      claimParticipantForUser(participant, established.user, h.claimDeps(staleAuth)),
    ).rejects.toMatchObject({ status: 401, code: "stale_auth" });
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBeUndefined();
    expect(await h.users.listUserBoards("synthetic-stale")).toEqual([]);

    // Join auto-link links at any sign-in age: userId + index.
    const linked = await linkParticipantOnJoin(
      participant,
      established.user,
      h.claimDeps(staleAuth),
    );
    expect(linked.userId).toBe("synthetic-stale");
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBe(
      "synthetic-stale",
    );
    expect(await h.users.getUserBoard("synthetic-stale", SLUG)).toEqual({
      boardId: SLUG,
      participantId: "part-1",
      claimedAt: T0,
      updatedAt: T0,
    });

    // Restore restores nobody even with that live claim + index...
    expect(
      await findClaimedParticipant(SLUG, established.user, h.claimDeps(staleAuth)),
    ).toBeNull();
    // ...while the same lookup with a fresh sign-in restores.
    expect(
      (await findClaimedParticipant(SLUG, established.user, h.claimDeps()))?.id,
    ).toBe("part-1");
  });

  it("PIN-160: link core needs no fresh sign-in and never re-links another user's claim", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h);
    const alice = (await establish(h, "token-alice")).user;
    const bob = (await establish(h, "token-bob")).user;
    const staleAuth = T0 - 2 * 60 * 60 * 1000;
    // Stale and missing auth_time (pre-PIN-94 cookie) both link.
    const noAuthTime = { ...h.claimDeps(), authTimeMs: undefined };

    // Empty -> set + index.
    const linked = await linkParticipantToUser(participant, alice, noAuthTime);
    expect(linked.userId).toBe("synthetic-alice");
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBe(
      "synthetic-alice",
    );

    // Same user later -> kept, index refreshed, first claimedAt kept.
    h.setNow(T0 + DAY_MS);
    const again = await linkParticipantToUser(linked, alice, h.claimDeps(staleAuth));
    expect(again).toEqual(linked);
    expect(await h.users.getUserBoard("synthetic-alice", SLUG)).toEqual({
      boardId: SLUG,
      participantId: "part-1",
      claimedAt: T0,
      updatedAt: T0 + DAY_MS,
    });

    // Another user (core and join wrapper) -> unchanged, no throw,
    // nothing written for either account.
    expect(await linkParticipantToUser(linked, bob, h.claimDeps(staleAuth))).toEqual(
      linked,
    );
    expect(await linkParticipantOnJoin(linked, bob, h.claimDeps(staleAuth))).toEqual(
      linked,
    );
    expect((await h.boards.getParticipant(SLUG, "part-1"))?.userId).toBe(
      "synthetic-alice",
    );
    expect(await h.users.listUserBoards("synthetic-bob")).toEqual([]);
    expect((await h.users.getUserBoard("synthetic-alice", SLUG))?.updatedAt).toBe(
      T0 + DAY_MS,
    );
  });

  it("PIN-167: no index row for a deleted board, even when the delete lands mid-write", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h, { userId: "synthetic-alice" });
    const alice = (await establish(h, "token-alice")).user;
    // The delete (tombstone + row clean-up, no row yet) lands after
    // the live check and before the row write.
    const getRow = h.users.getUserBoard.bind(h.users);
    let armed = true;
    h.users.getUserBoard = async (uid, slug) => {
      if (armed) {
        armed = false;
        await h.boards.deleteBoard(SLUG, T0);
      }
      return getRow(uid, slug);
    };
    await linkParticipantToUser(participant, alice, h.claimDeps());
    expect(armed).toBe(false);
    expect(await getRow("synthetic-alice", SLUG)).toBeNull();
    // Already deleted: nothing is written at all.
    const writes = vi.spyOn(h.users, "putUserBoard");
    await linkParticipantToUser(participant, alice, h.claimDeps());
    expect(writes).not.toHaveBeenCalled();
    expect(await h.users.listUserBoards("synthetic-alice")).toEqual([]);
  });

  it("PIN-94: missing auth_time fails claim closed; pre-PIN-94 cookies still read", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h);
    const alice = (await establish(h, "token-alice")).user;

    await expect(
      claimParticipantForUser(participant, alice, {
        ...h.claimDeps(),
        authTimeMs: undefined,
      }),
    ).rejects.toMatchObject({ status: 401, code: "stale_auth" });

    // A cookie minted before PIN-94 (no authTimeMs) resolves for
    // ordinary reads, but its context carries no freshness.
    const legacyCookie = signUserCookie(
      { v: 1, uid: "synthetic-alice", issuedAt: T0 },
      SECRET,
    );
    expect(await resolveUserSession(legacyCookie, h.deps)).toEqual(alice);
    const context = await resolveUserSessionContext(legacyCookie, h.deps);
    expect(context?.user).toEqual(alice);
    expect(context?.authTimeMs).toBeUndefined();
  });

  it("PIN-94: freshness boundary is inclusive at the Policy window", () => {
    const policy = resolvePolicy();
    const window = policy.authFreshWindowMs;
    expect(isFreshAuth(T0, policy, T0 + window)).toBe(true);
    expect(isFreshAuth(T0, policy, T0 + window + 1)).toBe(false);
    expect(isFreshAuth(T0 + 60_000, policy, T0)).toBe(true); // clock skew
    expect(isFreshAuth(undefined, policy, T0)).toBe(false);
    expect(isFreshAuth(Number.NaN, policy, T0)).toBe(false);
  });

  it("claim errors are BoardApiError so routes map them uniformly", async () => {
    const h = makeHarness();
    const participant = await seedParticipant(h, { userId: "synthetic-bob" });
    const alice = (await establish(h, "token-alice")).user;
    await expect(
      claimParticipantForUser(participant, alice, h.claimDeps()),
    ).rejects.toBeInstanceOf(BoardApiError);
  });
});
