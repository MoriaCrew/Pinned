import { describe, expect, it, vi } from "vitest";
import { emptyBoardCounters, type Element } from "../domain/board";
import { InMemoryBoardRepository } from "../domain/board-repository";
import { boardStoragePrefixes, sweepDeletedBoardStorage } from "./board-storage";
import { InMemoryDerivativeStore, type DerivativeStore } from "./derivative-store";

const DEAD = "boardAAAAAAAAAAAAAAAA1";
const LOOKALIKE = "boardAAAAAAAAAAAAAAAA2"; // shares DEAD's first 21 characters
const COPIES = "boardBBBBBBBBBBBBBBBB1"; // live: holds library copies
const SOURCE = "boardCCCCCCCCCCCCCCCC1"; // live: a copy's source stays here

const folderOf = (slug: string, id: string) => `elements/boards/${slug}/${id}/`;
const files = (slug: string, id: string) => [`${folderOf(slug, id)}cutout.png`, `${folderOf(slug, id)}flattened.jpg`];

function element(id: string, boardId: string, bytesIn = boardId, bytesId = id): Element {
  const [cutoutRef, flattenedRef] = files(bytesIn, bytesId);
  return {
    id, boardId, ownerId: "p1", label: id, description: id, maskBox: { x1: 0, y1: 0, x2: 1, y2: 1 },
    cutoutRef, flattenedRef, sourcePhotoId: "job", faceFlag: false, createdAt: 1,
  };
}

async function harness() {
  const boards = new InMemoryBoardRepository();
  const store = new InMemoryDerivativeStore();
  for (const slug of [DEAD, LOOKALIKE, COPIES, SOURCE]) {
    await boards.createBoard({ slug, title: slug, counters: emptyBoardCounters(), createdAt: 1, version: 1 });
  }
  const put = (...refs: string[]) => Promise.all(refs.map((ref) => store.put(ref, Buffer.from(ref), "image/png")));
  const everything = async () => (await Promise.all(["tmp/", "elements/", "scenes/"].map((p) => store.listPrefix(p)))).flat();
  return { boards, store, deps: { boards, store }, put, everything };
}

describe("boardStoragePrefixes (PIN-169)", () => {
  it("builds the three trailing-slash folders from a valid slug only", () => {
    expect(boardStoragePrefixes(DEAD)).toEqual([`tmp/boards/${DEAD}/`, `elements/boards/${DEAD}/`, `scenes/boards/${DEAD}/`]);
    for (const bad of ["", "board-1", "../etc", `${DEAD}/x`, `${DEAD}x`, "A".repeat(21)]) {
      expect(boardStoragePrefixes(bad)).toBeNull();
    }
  });
});

describe("sweepDeletedBoardStorage (PIN-169)", () => {
  it("does nothing at all for an invalid slug or a live board", async () => {
    const h = await harness();
    await h.put(`tmp/boards/${DEAD}/jobs/j/working.webp`);
    const lists = vi.spyOn(h.store, "listPrefix");
    const deletes = vi.spyOn(h.store, "delete");
    for (const slug of ["", "board-1", "../tmp", `${DEAD}/`, DEAD]) {
      expect(await sweepDeletedBoardStorage(slug, h.deps)).toEqual({ deleted: 0, kept: 0, failed: 0 });
    }
    expect(lists).not.toHaveBeenCalled();
    expect(deletes).not.toHaveBeenCalled();
    expect(await h.everything()).toHaveLength(1);
  });

  it("empties the three folders except a cut-out a live copy uses; a look-alike board is untouched", async () => {
    const h = await harness();
    const sweep = () => sweepDeletedBoardStorage(DEAD, h.deps);
    // own: board-only; shared: copied to COPIES; gone: copied, then its record deleted here.
    for (const id of ["own", "shared", "gone"]) await h.boards.createElement(element(id, DEAD));
    await h.boards.createElement(element("copy-shared", COPIES, DEAD, "shared"));
    await h.boards.createElement(element("copy-gone", COPIES, DEAD, "gone"));
    await h.boards.deleteElement("gone");
    const kept = [...files(DEAD, "gone"), ...files(DEAD, "shared")];
    const others = [
      ...files(LOOKALIKE, "own"), `tmp/boards/${LOOKALIKE}/jobs/j/working.webp`, `scenes/boards/${LOOKALIKE}/s/scene.png`,
      `tmp/boards/${DEAD}x/stray.webp`, `scenes/boards/${DEAD}-/s/scene.png`,
    ];
    const swept = [
      `tmp/boards/${DEAD}/jobs/j/working.webp`, ...files(DEAD, "own"), `elements/boards/${DEAD}/loose.png`,
      `scenes/boards/${DEAD}/s/scene.png`, `scenes/boards/${DEAD}/s/preview.webp`,
    ];
    await h.put(...kept, ...others, ...swept);
    await h.boards.deleteBoard(DEAD, 2);

    expect(await sweep()).toEqual({ deleted: swept.length, kept: kept.length, failed: 0 });
    expect((await h.everything()).sort()).toEqual([...kept, ...others].sort());
    expect(await sweep()).toEqual({ deleted: 0, kept: kept.length, failed: 0 }); // idempotent
  });

  it("deleting the board that held the last live copy frees the kept bytes; a live source keeps its own", async () => {
    const h = await harness();
    await h.boards.createElement(element("shared", DEAD));
    await h.boards.createElement(element("copy-shared", COPIES, DEAD, "shared"));
    await h.boards.createElement(element("src", SOURCE));
    await h.boards.createElement(element("copy-src", COPIES, SOURCE, "src"));
    await h.put(...files(DEAD, "shared"), ...files(SOURCE, "src"), ...files(COPIES, "mine"));
    await h.boards.deleteBoard(DEAD, 2);
    expect(await sweepDeletedBoardStorage(DEAD, h.deps)).toMatchObject({ deleted: 0, kept: 2 });

    await h.boards.deleteBoard(COPIES, 3);
    expect(await sweepDeletedBoardStorage(COPIES, h.deps)).toEqual({ deleted: 4, kept: 0, failed: 0 });
    expect(await h.everything()).toEqual(files(SOURCE, "src"));
  });

  it("a failed delete is counted and logged by error name only; a re-run finishes", async () => {
    const h = await harness();
    const refs = [`tmp/boards/${DEAD}/jobs/j/working.webp`, `scenes/boards/${DEAD}/s/scene.png`];
    await h.put(...refs);
    await h.boards.deleteBoard(DEAD, 2);
    const flaky: DerivativeStore = {
      put: (ref, bytes, type) => h.store.put(ref, bytes, type),
      get: (ref) => h.store.get(ref),
      listPrefix: (prefix) => h.store.listPrefix(prefix),
      delete: async (ref) => {
        if (ref === refs[0]) throw new TypeError(`gcs down for ${ref}`);
        return h.store.delete(ref);
      },
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sweepDeletedBoardStorage(DEAD, { boards: h.boards, store: flaky })).toEqual({ deleted: 1, kept: 0, failed: 1 });
    expect(log.mock.calls).toEqual([["Board storage clean-up left objects behind.", { error: "TypeError" }]]);
    log.mockRestore();
    expect(await sweepDeletedBoardStorage(DEAD, h.deps)).toEqual({ deleted: 1, kept: 0, failed: 0 });
    expect(await h.everything()).toEqual([]);
  });
});
