import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBoardCounters } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { InMemoryUserRepository } from "../domain/user-repository";
import { DEFAULT_POLICY } from "../policy/policy";
import { deleteBoardForEveryone } from "./board-delete";
import { BoardApiError } from "./board-session";
import { InMemoryDerivativeStore } from "./derivative-store";
import { issueHostCredential } from "./host-session";

/**
 * Board delete clean-up order (PIN-167, PIN-169, PIN-233 F8): once the
 * tombstone is set, a retry only gets the 404, so the storage sweep
 * must run on this call whatever the My boards unlinking does.
 */
const SLUG = "boardDDDDDDDDDDDDDDDD1";
const NOW = 1_000_000;
const UID = "synthetic-alice";

async function harness() {
  const boards = new InMemoryBoardRepository();
  const users = new InMemoryUserRepository();
  const store = new InMemoryDerivativeStore();
  const host = issueHostCredential(NOW);
  await boards.createBoard({
    slug: SLUG, title: "Delete me", counters: emptyBoardCounters(), createdAt: NOW, version: 1, host: host.record,
  });
  await boards.createParticipantIfBelowCap(
    { id: "p1", boardId: SLUG, displayName: "Alice", cookieSecretHash: "x", userId: UID, createdAt: NOW },
    10,
  );
  await users.putUserBoard(UID, { boardId: SLUG, participantId: "p1", claimedAt: NOW, updatedAt: NOW });
  const refs = [
    `tmp/boards/${SLUG}/jobs/j1/working.webp`,
    `elements/boards/${SLUG}/e1/cutout.png`,
    `scenes/boards/${SLUG}/s1/scene.png`,
  ];
  for (const ref of refs) await store.put(ref, Buffer.from(ref), "image/png");
  const stored = async () =>
    (await Promise.all(["tmp", "elements", "scenes"].map((root) => store.listPrefix(`${root}/boards/${SLUG}/`)))).flat();
  const deps = { boards, users, store, policy: DEFAULT_POLICY, now: () => NOW };
  return { boards, users, store, deps, token: host.token, stored };
}

afterEach(() => vi.restoreAllMocks());

describe("deleteBoardForEveryone clean-up (PIN-233 F8)", () => {
  it("unlinks My boards rows and empties the board's storage", async () => {
    const h = await harness();
    expect(await h.stored()).toHaveLength(3);
    await deleteBoardForEveryone(SLUG, h.token, h.deps);
    expect(await h.boards.getBoard(SLUG)).toBeNull();
    expect(await h.users.getUserBoard(UID, SLUG)).toBeNull();
    expect(await h.stored()).toEqual([]);
  });

  it("still sweeps storage and answers success when listing participants fails after the tombstone", async () => {
    const h = await harness();
    vi.spyOn(h.boards, "listParticipants").mockRejectedValue(new Error("participants read failed"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deleteBoardForEveryone(SLUG, h.token, h.deps)).resolves.toBeUndefined();
    expect(await h.boards.getBoard(SLUG)).toBeNull();
    expect(await h.stored()).toEqual([]);
    // The stale My boards row stays (board GET answers it as gone);
    // the log names the error kind only, never the slug or a uid.
    expect(await h.users.getUserBoard(UID, SLUG)).not.toBeNull();
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(new RegExp(`${SLUG}|${UID}`));
    // Why this call has to finish the job: a retry only gets the 404.
    await expect(deleteBoardForEveryone(SLUG, h.token, h.deps)).rejects.toMatchObject({ status: 404 });
    await expect(deleteBoardForEveryone(SLUG, h.token, h.deps)).rejects.toBeInstanceOf(BoardApiError);
  });
});
