/**
 * Shared ReportStore contract suite (PIN-269): run by the in-memory
 * store and by the Firestore store against its fake.
 */
import { describe, expect, it } from "vitest";
import type { ReportRecord } from "./board-report";
import type { ReportStore } from "./report-store";

function makeReport(overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    id: "rep-1",
    boardId: "board-slug-00000000001",
    reference: "0123456789abcdef",
    scope: "element",
    targetId: "el-1",
    reason: "likeness",
    reporterKind: "visitor",
    severity: "normal",
    createdAt: 1_000,
    status: "open",
    held: { elementIds: ["el-1"], sceneIds: [], boardReview: false, storageHold: false },
    ...overrides,
  };
}

export function describeReportStoreContract(name: string, makeStore: () => ReportStore): void {
  describe(`ReportStore contract: ${name}`, () => {
    it("creates and reads back an isolated copy; a duplicate id throws", async () => {
      const store = makeStore();
      const record = makeReport({ message: "that is me", reporterEmail: "a@b.co", deleteAt: 5_000 });
      await store.create(record);
      record.message = "mutated";
      record.held.elementIds.push("el-9");
      const read = await store.get("rep-1");
      expect(read).toEqual(makeReport({ message: "that is me", reporterEmail: "a@b.co", deleteAt: 5_000 }));
      expect(await store.get("missing")).toBeNull();
      await expect(store.create(makeReport())).rejects.toThrow(RangeError);
    });

    it("lists by reference newest first, and open reports per board oldest first", async () => {
      const store = makeStore();
      await store.create(makeReport({ id: "a", createdAt: 1_000 }));
      await store.create(makeReport({ id: "b", createdAt: 3_000 }));
      await store.create(makeReport({ id: "c", createdAt: 2_000, status: "dismissed", decidedAt: 2_500 }));
      await store.create(makeReport({ id: "other", reference: "fedcba9876543210", boardId: "board-b", createdAt: 1_500 }));
      expect((await store.listByReference("0123456789abcdef")).map((r) => r.id)).toEqual(["b", "c", "a"]);
      expect((await store.listOpenForBoard("board-slug-00000000001")).map((r) => r.id)).toEqual(["a", "b"]);
      expect((await store.listOpenForBoard("board-b")).map((r) => r.id)).toEqual(["other"]);
      expect(await store.listOpenForBoard("nobody")).toEqual([]);
      // The operator's queue: open reports of every board, oldest first, capped.
      expect((await store.listOpen(10)).map((r) => r.id)).toEqual(["a", "other", "b"]);
      expect((await store.listOpen(2)).map((r) => r.id)).toEqual(["a", "other"]);
      expect(await store.listOpen(0)).toEqual([]);
    });

    it("listOpenDue: open reports with a deadline before `before`, oldest deadline first, capped", async () => {
      const store = makeStore();
      await store.create(makeReport({ id: "late", createdAt: 1_000, deleteAt: 9_000 }));
      await store.create(makeReport({ id: "due-2", createdAt: 1_100, deleteAt: 4_000 }));
      await store.create(makeReport({ id: "due-1", createdAt: 1_200, deleteAt: 3_000 }));
      await store.create(makeReport({ id: "no-deadline", createdAt: 1_300 }));
      await store.create(makeReport({ id: "decided", createdAt: 1_400, deleteAt: 2_000, status: "takedown", decidedAt: 2_100 }));
      expect((await store.listOpenDue(5_000, 10)).map((r) => r.id)).toEqual(["due-1", "due-2"]);
      expect((await store.listOpenDue(5_000, 1)).map((r) => r.id)).toEqual(["due-1"]);
      expect(await store.listOpenDue(5_000, 0)).toEqual([]);
      expect(await store.listOpenDue(2_500, 10)).toEqual([]);
      // A decision takes the report out of the due list for good.
      await store.decide("due-1", { status: "dismissed", decidedAt: 3_500 });
      expect((await store.listOpenDue(5_000, 10)).map((r) => r.id)).toEqual(["due-2"]);
    });

    it("decide closes an open report once and keeps the deadline for the record", async () => {
      const store = makeStore();
      await store.create(makeReport({ deleteAt: 5_000 }));
      const decided = await store.decide("rep-1", { status: "takedown", decidedAt: 4_000, note: "confirmed" });
      expect(decided).toEqual(makeReport({ deleteAt: 5_000, status: "takedown", decidedAt: 4_000, note: "confirmed" }));
      expect(await store.get("rep-1")).toEqual(decided);
      expect(await store.decide("rep-1", { status: "dismissed", decidedAt: 4_500 })).toBeNull();
      expect((await store.get("rep-1"))?.status).toBe("takedown");
      expect(await store.decide("missing", { status: "dismissed", decidedAt: 4_500 })).toBeNull();
    });
  });
}
