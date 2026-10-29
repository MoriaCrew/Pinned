/**
 * Shared UserRepository contract suite (PIN-83). Every
 * implementation runs this: the in-memory one here, the Firestore
 * one against a fake Firestore in src/server.
 */
import { describe, expect, it } from "vitest";
import type { UserBoardEntry, UserProfile } from "./user";
import type { UserRepository } from "./user-repository";

const UID = "synthetic-user-1";
const OTHER_UID = "synthetic-user-2";
const SLUG = "board-slug-00000000001";
const OTHER_SLUG = "board-slug-00000000002";

function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    uid: UID,
    displayName: "Test Person",
    photoUrl: "https://example.test/photo.png",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<UserBoardEntry> = {}): UserBoardEntry {
  return {
    boardId: SLUG,
    participantId: "part-1",
    claimedAt: 2_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

export function describeUserRepositoryContract(
  name: string,
  makeRepo: () => UserRepository,
): void {
  describe(`UserRepository contract: ${name}`, () => {
    it("stores and reads back a profile as an isolated copy", async () => {
      const repo = makeRepo();
      const profile = makeProfile();
      await repo.putUser(profile);
      profile.displayName = "mutated after write";
      const read = await repo.getUser(UID);
      expect(read).toEqual(makeProfile());
      read!.displayName = "mutated after read";
      expect(await repo.getUser(UID)).toEqual(makeProfile());
      expect(await repo.getUser("ghost")).toBeNull();
    });

    it("upserts by uid and keeps optional fields absent when unset", async () => {
      const repo = makeRepo();
      await repo.putUser(makeProfile());
      await repo.putUser({ uid: UID, createdAt: 1_000, updatedAt: 3_000 });
      expect(await repo.getUser(UID)).toEqual({
        uid: UID,
        createdAt: 1_000,
        updatedAt: 3_000,
      });
    });

    it("keeps users fully separate", async () => {
      const repo = makeRepo();
      await repo.putUser(makeProfile());
      await repo.putUser(makeProfile({ uid: OTHER_UID, displayName: "Other" }));
      expect((await repo.getUser(UID))?.displayName).toBe("Test Person");
      expect((await repo.getUser(OTHER_UID))?.displayName).toBe("Other");
    });

    it("upserts board index entries by slug and lists claimedAt-ascending", async () => {
      const repo = makeRepo();
      await repo.putUserBoard(UID, makeEntry({ boardId: OTHER_SLUG, claimedAt: 2_500 }));
      await repo.putUserBoard(UID, makeEntry());
      await repo.putUserBoard(UID, makeEntry({ updatedAt: 4_000 }));
      expect(await repo.getUserBoard(UID, SLUG)).toEqual(makeEntry({ updatedAt: 4_000 }));
      expect((await repo.listUserBoards(UID)).map((e) => e.boardId)).toEqual([
        SLUG,
        OTHER_SLUG,
      ]);
      expect(await repo.getUserBoard(UID, "ghost-board")).toBeNull();
      expect(await repo.listUserBoards(OTHER_UID)).toEqual([]);
    });

    it("stores board entries isolated from later caller mutation", async () => {
      const repo = makeRepo();
      const entry = makeEntry();
      await repo.putUserBoard(UID, entry);
      entry.participantId = "mutated";
      expect((await repo.getUserBoard(UID, SLUG))?.participantId).toBe("part-1");
    });
  });
}
