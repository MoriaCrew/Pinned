import { describe, expect, it } from "vitest";
import { countedPhotos, freePhotoAllowance, freePhotosLeft } from "./free-photos";

const BOUND = 60_000;
const NOW = 1_000_000;

describe("freePhotoAllowance (PIN-230)", () => {
  const base = { creditsEnabled: true, hasPlus: false, stored: undefined, policyDefault: 15 };

  it("a free board gets the stored amount, else the Policy default", () => {
    expect(freePhotoAllowance(base)).toBe(15);
    expect(freePhotoAllowance({ ...base, stored: 0 })).toBe(0);
    expect(freePhotoAllowance({ ...base, stored: 7 })).toBe(7);
  });

  it("the board's own Policy override wins over what creation stored", () => {
    expect(freePhotoAllowance({ ...base, stored: 0, boardOverride: 1000 })).toBe(1000);
    expect(freePhotoAllowance({ ...base, stored: 15, boardOverride: 0 })).toBe(0);
  });

  it("Plus or credits off: no limit", () => {
    expect(freePhotoAllowance({ ...base, hasPlus: true, stored: 0 })).toBeNull();
    expect(freePhotoAllowance({ ...base, creditsEnabled: false, stored: 0 })).toBeNull();
  });
});

describe("countedPhotos (PIN-230)", () => {
  it("counts ready photos and live in-flight ones; never failed, refused or stale", () => {
    const jobs = [
      { status: "ready" as const, updatedAt: 1 },
      { status: "pending" as const, updatedAt: NOW - BOUND },
      { status: "running" as const, updatedAt: NOW - 10 },
      { status: "running" as const, updatedAt: NOW - BOUND - 1 },
      { status: "pending" as const, updatedAt: NOW - BOUND - 1 },
      { status: "failed" as const, updatedAt: NOW },
      { status: "refused" as const, updatedAt: NOW },
    ];
    expect(countedPhotos(jobs, NOW, BOUND)).toBe(3);
    expect(countedPhotos([], NOW, BOUND)).toBe(0);
  });
});

describe("freePhotosLeft (PIN-230)", () => {
  it("never goes below 0", () => {
    expect(freePhotosLeft(15, 3)).toBe(12);
    expect(freePhotosLeft(15, 15)).toBe(0);
    expect(freePhotosLeft(2, 5)).toBe(0);
  });
});
