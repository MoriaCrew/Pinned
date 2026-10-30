import { describe, expect, it } from "vitest";
import {
  InMemoryBudgetStore,
  dayBucketFor,
  emptyBudgetDay,
  evaluateReserve,
  type ReserveRequest,
} from "./budget";

const DAY = "2026-10-29";

function req(over: Partial<ReserveRequest> = {}): ReserveRequest {
  return {
    dayBucket: DAY,
    estimatedCostUsd: 0.01,
    budgetUsd: 2,
    callLimit: 200,
    ...over,
  };
}

describe("evaluateReserve (PIN-61)", () => {
  it("budget 0 or call limit 0 means OFF", () => {
    expect(evaluateReserve(emptyBudgetDay(), req({ budgetUsd: 0 }))).toEqual({
      ok: false,
      reason: "off",
    });
    expect(evaluateReserve(emptyBudgetDay(), req({ callLimit: 0 }))).toEqual({
      ok: false,
      reason: "off",
    });
  });

  it("denies on call limit, USD budget, participant cap and board cap", () => {
    const state = {
      calls: 200,
      reservedMicroUsd: 0,
      participantPhotos: {},
      participantScenes: {},
      boards: {},
      participantSegments: {},
      participantTapNames: {},
      participantTranscriptions: {},
      photos: {},
    };
    expect(evaluateReserve(state, req())).toMatchObject({
      ok: false,
      reason: "call_limit",
    });
    expect(
      evaluateReserve(emptyBudgetDay(), req({ estimatedCostUsd: 3 })),
    ).toMatchObject({ ok: false, reason: "budget" });
    const capped = {
      ...emptyBudgetDay(),
      participantPhotos: { p1: 20 },
      boards: { b1: 40 },
    };
    expect(
      evaluateReserve(capped, req({ participantId: "p1", participantPhotoCap: 20 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(capped, req({ boardId: "b1", boardCap: 40 })),
    ).toMatchObject({ ok: false, reason: "board_cap" });
    // A different participant/board is unaffected.
    expect(
      evaluateReserve(
        capped,
        req({ participantId: "p2", participantPhotoCap: 20, boardId: "b2", boardCap: 40 }),
      ).ok,
    ).toBe(true);
  });
});

describe("segment caps (PIN-92)", () => {
  it("evaluateReserve denies on segment-participant and photo caps, independently of the photo quota", () => {
    const state = {
      ...emptyBudgetDay(),
      participantSegments: { p1: 150 },
      photos: { "job-1": 18 },
    };
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantSegmentCap: 150 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(state, req({ photoId: "job-1", photoCap: 18 })),
    ).toMatchObject({ ok: false, reason: "photo_cap" });
    // Different participant/photo unaffected.
    expect(
      evaluateReserve(
        state,
        req({ participantId: "p2", participantSegmentCap: 150, photoId: "job-2", photoCap: 18 }),
      ).ok,
    ).toBe(true);
    // Segment spend does not trip the namer photo quota.
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantPhotoCap: 20 })).ok,
    ).toBe(true);
  });

  it("store counts segments/photos apart from participants; a denied reserve writes nothing", async () => {
    const store = new InMemoryBudgetStore();
    const seg = req({
      participantId: "p1",
      participantSegmentCap: 2,
      photoId: "job-1",
      photoCap: 5,
    });
    expect((await store.reserve(seg)).ok).toBe(true);
    expect((await store.reserve(seg)).ok).toBe(true);
    expect(await store.reserve(seg)).toEqual({
      ok: false,
      reason: "participant_cap",
    });
    const snap = store.snapshot(DAY);
    expect(snap.calls).toBe(2);
    expect(snap.participantPhotos).toEqual({});
    expect(snap.participantSegments).toEqual({ p1: 2 });
    expect(snap.photos).toEqual({ "job-1": 2 });
  });
});

describe("tap-name caps (PIN-117)", () => {
  it("evaluateReserve denies on the tap-name cap, independently of the photo quota", () => {
    const state = {
      ...emptyBudgetDay(),
      participantTapNames: { p1: 100 },
    };
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantTapNameCap: 100 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    // A different participant is unaffected.
    expect(
      evaluateReserve(state, req({ participantId: "p2", participantTapNameCap: 100 })).ok,
    ).toBe(true);
    // Tap-name spend does not trip the namer photo quota.
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantPhotoCap: 20 })).ok,
    ).toBe(true);
  });

  it("store counts tap names apart from participants and segments", async () => {
    const store = new InMemoryBudgetStore();
    const name = req({ participantId: "p1", participantTapNameCap: 2 });
    expect((await store.reserve(name)).ok).toBe(true);
    expect((await store.reserve(name)).ok).toBe(true);
    expect(await store.reserve(name)).toEqual({
      ok: false,
      reason: "participant_cap",
    });
    const snap = store.snapshot(DAY);
    expect(snap.calls).toBe(2);
    expect(snap.participantPhotos).toEqual({});
    expect(snap.participantSegments).toEqual({});
    expect(snap.participantTapNames).toEqual({ p1: 2 });
  });
});

describe("transcription caps (PIN-119)", () => {
  it("evaluateReserve denies on the transcription cap, independently of other quotas", () => {
    const state = { ...emptyBudgetDay(), participantTranscriptions: { p1: 50 } };
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantTranscriptionCap: 50 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(state, req({ participantId: "p2", participantTranscriptionCap: 50 })).ok,
    ).toBe(true);
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantPhotoCap: 20 })).ok,
    ).toBe(true);
  });

  it("store counts transcriptions in their own counter", async () => {
    const store = new InMemoryBudgetStore();
    const dictation = req({ participantId: "p1", participantTranscriptionCap: 1 });
    expect((await store.reserve(dictation)).ok).toBe(true);
    expect(await store.reserve(dictation)).toEqual({ ok: false, reason: "participant_cap" });
    const snap = store.snapshot(DAY);
    expect(snap.participantPhotos).toEqual({});
    expect(snap.participantTranscriptions).toEqual({ p1: 1 });
  });
});

describe("photo/scene cap independence (PIN-136)", () => {
  it("evaluateReserve: a full scene quota does not trip the photo cap and vice versa", () => {
    const sceneFull = { ...emptyBudgetDay(), participantScenes: { p1: 10 } };
    expect(
      evaluateReserve(sceneFull, req({ participantId: "p1", participantSceneCap: 10 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(sceneFull, req({ participantId: "p1", participantPhotoCap: 20 })).ok,
    ).toBe(true);
    const photoFull = { ...emptyBudgetDay(), participantPhotos: { p1: 20 } };
    expect(
      evaluateReserve(photoFull, req({ participantId: "p1", participantPhotoCap: 20 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(photoFull, req({ participantId: "p1", participantSceneCap: 10 })).ok,
    ).toBe(true);
  });

  it("store: 10 scenes leave the full photo quota; 20 photos leave the full scene quota", async () => {
    const store = new InMemoryBudgetStore();
    const scene = req({ participantId: "p1", participantSceneCap: 10 });
    for (let i = 0; i < 10; i += 1) expect((await store.reserve(scene)).ok).toBe(true);
    expect(await store.reserve(scene)).toEqual({ ok: false, reason: "participant_cap" });
    const photo = req({ participantId: "p1", participantPhotoCap: 20 });
    for (let i = 0; i < 20; i += 1) expect((await store.reserve(photo)).ok).toBe(true);
    expect(await store.reserve(photo)).toEqual({ ok: false, reason: "participant_cap" });
    const snap = store.snapshot(DAY);
    expect(snap.participantScenes).toEqual({ p1: 10 });
    expect(snap.participantPhotos).toEqual({ p1: 20 });
    expect(snap.calls).toBe(30);
  });
});

describe("InMemoryBudgetStore (PIN-61)", () => {
  it("counts calls, reserved micro-USD and per-id counters per day", async () => {
    const store = new InMemoryBudgetStore();
    const r = await store.reserve(
      req({ participantId: "p1", participantPhotoCap: 20, boardId: "b1", boardCap: 40 }),
    );
    expect(r).toEqual({ ok: true, estimatedMicroUsd: 10_000 });
    expect(store.snapshot(DAY)).toEqual({
      calls: 1,
      reservedMicroUsd: 10_000,
      participantPhotos: { p1: 1 },
      participantScenes: {},
      boards: { b1: 1 },
      participantSegments: {},
      participantTapNames: {},
      participantTranscriptions: {},
      photos: {},
    });
    expect(store.snapshot("2026-10-30").calls).toBe(0);
  });

  it("race: two concurrent reserves at the cap -> exactly one proceeds", async () => {
    const store = new InMemoryBudgetStore();
    await store.reserve(req({ callLimit: 2 }));
    const results = await Promise.all([
      store.reserve(req({ callLimit: 2 })),
      store.reserve(req({ callLimit: 2 })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([
      { ok: false, reason: "call_limit" },
    ]);
    expect(store.snapshot(DAY).calls).toBe(2);
  });

  it("dayBucketFor is the UTC date", () => {
    expect(dayBucketFor(Date.UTC(2026, 9, 29, 23, 59))).toBe("2026-10-29");
  });
});
