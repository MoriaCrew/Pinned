import { describe, expect, it } from "vitest";
import {
  claimStashedPhoto,
  dropStashedPhoto,
  photoForJob,
  rememberJobPhoto,
  stashUploadingPhoto,
} from "./photo-memory";

const revoker = () => {
  const revoked: string[] = [];
  return { revoked, revoke: (url: string) => void revoked.push(url) };
};

describe("last photo memory (PIN-122, PIN-126)", () => {
  it("remembers the photo of a known job and releases the one it replaces", () => {
    const r = revoker();
    const first = rememberJobPhoto(null, "job-1", "blob:1", r.revoke);
    expect(first).toEqual({ jobId: "job-1", url: "blob:1" });
    const second = rememberJobPhoto(first, "job-2", "blob:2", r.revoke);
    expect(second).toEqual({ jobId: "job-2", url: "blob:2" });
    expect(r.revoked).toEqual(["blob:1"]);
    expect(photoForJob(second, "job-2")).toBe("blob:2");
    expect(photoForJob(second, "job-1")).toBeNull();
    expect(photoForJob(second, null)).toBeNull();
  });

  it("keeps a photo whose sheet closed mid-upload, then gives it its job", () => {
    const r = revoker();
    const before = { jobId: "job-1", url: "blob:1" };
    const stashed = stashUploadingPhoto(before, "blob:2", r.revoke);
    expect(stashed).toEqual({ jobId: null, url: "blob:2" });
    expect(r.revoked).toEqual(["blob:1"]);
    // No job yet: nothing to reopen, even for a null resume id.
    expect(photoForJob(stashed, null)).toBeNull();
    const landed = claimStashedPhoto(stashed, "blob:2", "job-2");
    expect(photoForJob(landed, "job-2")).toBe("blob:2");
  });

  it("leaves a newer photo alone when an older upload lands late", () => {
    const newer = { jobId: "job-3", url: "blob:3" };
    expect(claimStashedPhoto(newer, "blob:2", "job-2")).toBe(newer);
  });

  it("releases a stashed photo whose upload failed, and only that one", () => {
    const r = revoker();
    expect(dropStashedPhoto({ jobId: null, url: "blob:2" }, "blob:2", r.revoke)).toBeNull();
    expect(r.revoked).toEqual(["blob:2"]);
    const newer = { jobId: "job-3", url: "blob:3" };
    expect(dropStashedPhoto(newer, "blob:2", r.revoke)).toBe(newer);
    expect(r.revoked).toEqual(["blob:2"]);
  });
});
