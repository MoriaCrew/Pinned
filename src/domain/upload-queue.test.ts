import { describe, expect, it } from "vitest";
import {
  applyItemPatch,
  classifyUploadFailure,
  createQueueItems,
  isQueueSettled,
  itemStatusForJob,
  nextStepItem,
  pendingCount,
  stepPosition,
  uploadRetryMode,
  type UploadQueueItem,
} from "./upload-queue";

describe("createQueueItems", () => {
  it("caps at the Policy batch size and reports the over-cap drop count", () => {
    const ids = Array.from({ length: 7 }, (_, i) => ({ key: `k${i}`, uploadId: `u${i}` }));
    const { items, dropped } = createQueueItems(ids, 5);
    expect(items).toHaveLength(5);
    expect(dropped).toBe(2);
    expect(items[0]).toEqual({ key: "k0", uploadId: "u0", status: "queued", attempts: 0 });
  });
});

describe("classifyUploadFailure", () => {
  it("stops the queue on coded pool-empty and per-day 429s", () => {
    expect(classifyUploadFailure({ httpStatus: 429, code: "credits_pool_empty" })).toBe("stop");
    expect(classifyUploadFailure({ httpStatus: 429, code: "photos_per_day" })).toBe("stop");
  });

  it("backs off on code-less 429 brakes and on 503", () => {
    expect(classifyUploadFailure({ httpStatus: 429 })).toBe("backoff");
    expect(classifyUploadFailure({ httpStatus: 503 })).toBe("backoff");
  });

  it("checks the job before re-sending after network loss or an uncoded 5xx", () => {
    expect(classifyUploadFailure({ network: true })).toBe("check-job");
    expect(classifyUploadFailure({ httpStatus: 500 })).toBe("check-job");
  });

  it("stops when not joined, and treats other 4xx as per-file terminal", () => {
    expect(classifyUploadFailure({ httpStatus: 401 })).toBe("stop");
    expect(classifyUploadFailure({ httpStatus: 415, code: "unsupported_type" })).toBe("terminal");
    expect(classifyUploadFailure({ httpStatus: 413, code: "too_large" })).toBe("terminal");
    expect(classifyUploadFailure({ httpStatus: 400, code: "bad_upload_id" })).toBe("terminal");
  });
});

describe("stepper order", () => {
  const item = (key: string, status: UploadQueueItem["status"]): UploadQueueItem => ({
    key,
    uploadId: key,
    status,
    attempts: 0,
  });

  it("steps in pick order past done/skipped, including still-cutting and failed items", () => {
    const items = [item("a", "done"), item("b", "skipped"), item("c", "uploading"), item("d", "failed")];
    expect(nextStepItem(items)?.key).toBe("c");
    expect(nextStepItem([item("a", "done")])).toBeNull();
  });

  it("positions and pending counts read off the same list", () => {
    const items = [item("a", "done"), item("b", "ready"), item("c", "queued")];
    expect(stepPosition(items, "b")).toEqual({ index: 2, total: 3 });
    expect(stepPosition(items, "ghost")).toBeNull();
    expect(pendingCount(items)).toBe(1);
  });

  it("a driver patch never resurrects a skipped or done item (Bugbot #148)", () => {
    const skipped = item("a", "skipped");
    expect(applyItemPatch(skipped, { status: "uploading", attempts: 2 })).toEqual({
      ...skipped,
      attempts: 2,
    });
    expect(applyItemPatch(skipped, { status: "ready" }).status).toBe("skipped");
    expect(applyItemPatch(item("b", "done"), { status: "failed" }).status).toBe("done");
    // Unsettled items patch normally.
    expect(applyItemPatch(item("c", "uploading"), { status: "ready" }).status).toBe("ready");
    // A settled queue is exactly one with nothing left to step to.
    expect(isQueueSettled([item("a", "done"), item("b", "skipped")])).toBe(true);
    expect(isQueueSettled([item("a", "done"), item("b", "ready")])).toBe(false);
    expect(isQueueSettled([])).toBe(true);
  });

  it("maps job statuses onto item statuses", () => {
    expect(itemStatusForJob("pending")).toBe("uploading");
    expect(itemStatusForJob("running")).toBe("uploading");
    expect(itemStatusForJob("ready")).toBe("ready");
    expect(itemStatusForJob("failed")).toBe("failed");
    expect(itemStatusForJob("refused")).toBe("refused");
  });

  it("user retry adopts a live/ready job, fresh job only for none/terminal (Bugbot #148)", () => {
    expect(uploadRetryMode("pending")).toBe("adopt");
    expect(uploadRetryMode("running")).toBe("adopt");
    expect(uploadRetryMode("ready")).toBe("adopt");
    expect(uploadRetryMode("failed")).toBe("fresh-job");
    expect(uploadRetryMode("refused")).toBe("fresh-job");
    expect(uploadRetryMode(null)).toBe("fresh-job");
  });
});
