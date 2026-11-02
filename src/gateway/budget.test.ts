import { describe, expect, it } from "vitest";
import {
  InMemoryBudgetStore,
  dayBucketFor,
  hourBucketFor,
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
      participantChips: {},
      participantTranscriptions: {},
      hourBucket: "",
      hourReservedMicroUsd: 0,
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

describe("chips caps (PIN-241)", () => {
  it("evaluateReserve denies on the chips cap, independently of other quotas", () => {
    const state = { ...emptyBudgetDay(), participantChips: { p1: 100 } };
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantChipsCap: 100 })),
    ).toMatchObject({ ok: false, reason: "participant_cap" });
    expect(
      evaluateReserve(state, req({ participantId: "p2", participantChipsCap: 100 })).ok,
    ).toBe(true);
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantPhotoCap: 20 })).ok,
    ).toBe(true);
    expect(
      evaluateReserve(state, req({ participantId: "p1", participantTapNameCap: 100 })).ok,
    ).toBe(true);
  });

  it("store counts chips in their own counter", async () => {
    const store = new InMemoryBudgetStore();
    const chips = req({ participantId: "p1", participantChipsCap: 2 });
    expect((await store.reserve(chips)).ok).toBe(true);
    expect((await store.reserve(chips)).ok).toBe(true);
    expect(await store.reserve(chips)).toEqual({ ok: false, reason: "participant_cap" });
    const snap = store.snapshot(DAY);
    expect(snap.calls).toBe(2);
    expect(snap.participantPhotos).toEqual({});
    expect(snap.participantTapNames).toEqual({});
    expect(snap.participantChips).toEqual({ p1: 2 });
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

describe("hourly sub-cap (PIN-240)", () => {
  const H1 = "2026-10-29T10";
  const H2 = "2026-10-29T11";

  it("hourBucketFor is the UTC hour", () => {
    expect(hourBucketFor(Date.UTC(2026, 9, 29, 23, 59))).toBe("2026-10-29T23");
    expect(hourBucketFor(Date.UTC(2026, 9, 30, 0, 0))).toBe("2026-10-30T00");
  });

  it("off by default: no hourly cap means the daily cap alone decides", async () => {
    const store = new InMemoryBudgetStore();
    // No hourBucket/hourlyBudgetUsd at all (legacy caller): many calls in one hour pass.
    for (let i = 0; i < 5; i += 1) expect((await store.reserve(req())).ok).toBe(true);
    // Explicitly 0 / unset hourly cap is also off, even past any hourly amount.
    expect((await store.reserve(req({ hourBucket: H1, hourlyBudgetUsd: 0, estimatedCostUsd: 0.5 }))).ok).toBe(true);
    expect((await store.reserve(req({ hourBucket: H1, estimatedCostUsd: 0.5 }))).ok).toBe(true);
  });

  it("evaluateReserve denies hourly_budget at the cap; a stale bucket counts as 0", () => {
    const state = { ...emptyBudgetDay(), hourBucket: H1, hourReservedMicroUsd: 900_000 };
    expect(
      evaluateReserve(state, req({ hourBucket: H1, hourlyBudgetUsd: 1, estimatedCostUsd: 0.2 })),
    ).toMatchObject({ ok: false, reason: "hourly_budget" });
    // Exactly at the boundary is allowed.
    expect(
      evaluateReserve(state, req({ hourBucket: H1, hourlyBudgetUsd: 1, estimatedCostUsd: 0.1 })).ok,
    ).toBe(true);
    // Next hour resets: prior hour spend does not carry over.
    expect(
      evaluateReserve(state, req({ hourBucket: H2, hourlyBudgetUsd: 1, estimatedCostUsd: 0.2 })).ok,
    ).toBe(true);
  });

  it("daily cap stays authoritative over the hourly sub-cap", () => {
    const state = { ...emptyBudgetDay(), reservedMicroUsd: 1_900_000, hourBucket: H1, hourReservedMicroUsd: 0 };
    // Fits the hourly cap (1) but busts the daily cap (2): daily reason wins.
    expect(
      evaluateReserve(state, req({ hourBucket: H1, hourlyBudgetUsd: 1, estimatedCostUsd: 0.2 })),
    ).toMatchObject({ ok: false, reason: "budget" });
  });

  it("store accepts until the hourly cap, denies, then accepts in the next hour", async () => {
    const store = new InMemoryBudgetStore();
    const call = (hourBucket: string) => req({ hourBucket, hourlyBudgetUsd: 0.03, estimatedCostUsd: 0.01 });
    expect((await store.reserve(call(H1))).ok).toBe(true);
    expect((await store.reserve(call(H1))).ok).toBe(true);
    expect((await store.reserve(call(H1))).ok).toBe(true);
    expect(await store.reserve(call(H1))).toEqual({ ok: false, reason: "hourly_budget" });
    expect(store.snapshot(DAY)).toMatchObject({ hourBucket: H1, hourReservedMicroUsd: 30_000, calls: 3 });
    expect((await store.reserve(call(H2))).ok).toBe(true);
    expect(store.snapshot(DAY)).toMatchObject({
      hourBucket: H2,
      hourReservedMicroUsd: 10_000,
      reservedMicroUsd: 40_000,
      calls: 4,
    });
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
      participantChips: {},
      participantTranscriptions: {},
      hourBucket: "",
      hourReservedMicroUsd: 0,
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
