/**
 * The board page's memory of the last photo's local preview
 * (PIN-122, PIN-126): a browser object URL of the picked file, kept
 * for this page visit only so "Pin them" can show the photo again.
 * It is never uploaded or stored as-is. Pure helpers: the caller
 * passes `revoke` (URL.revokeObjectURL) and stores what they return.
 */
export type PhotoSlot = { jobId: string | null; url: string } | null;

/** A photo whose job is known replaces the memory; the old URL is released. */
export function rememberJobPhoto(
  current: PhotoSlot,
  jobId: string,
  url: string,
  revoke: (url: string) => void,
): PhotoSlot {
  if (current && current.url !== url) revoke(current.url);
  return { jobId, url };
}

/**
 * The sheet closed while this photo was still uploading: keep it,
 * job unknown yet, instead of revoking it.
 */
export function stashUploadingPhoto(
  current: PhotoSlot,
  url: string,
  revoke: (url: string) => void,
): PhotoSlot {
  if (current && current.url !== url) revoke(current.url);
  return { jobId: null, url };
}

/** The stashed upload landed: it gets its job, unless a newer photo replaced it. */
export function claimStashedPhoto(current: PhotoSlot, url: string, jobId: string): PhotoSlot {
  return current && current.url === url && current.jobId === null ? { jobId, url } : current;
}

/** The stashed upload failed: nothing to resume, release it. */
export function dropStashedPhoto(
  current: PhotoSlot,
  url: string,
  revoke: (url: string) => void,
): PhotoSlot {
  if (current && current.url === url && current.jobId === null) {
    revoke(url);
    return null;
  }
  return current;
}

/** The preview to show when "Pin them" reopens this job, if any. */
export function photoForJob(current: PhotoSlot, jobId: string | null): string | null {
  return jobId !== null && current?.jobId === jobId ? current.url : null;
}

/**
 * The board page's photo memory: a slot that tells open sheets when
 * it changes. A photo stashed mid-upload only learns its job when
 * the upload returns (the request runs the whole cut), so a sheet
 * reopened by "Pin them" before then picks the photo up the moment
 * it lands (PIN-126).
 */
export interface PhotoMemoryStore {
  current: PhotoSlot;
  subscribe(listener: () => void): () => void;
}

export function createPhotoMemory(): PhotoMemoryStore {
  let slot: PhotoSlot = null;
  const listeners = new Set<() => void>();
  return {
    get current() {
      return slot;
    },
    set current(next: PhotoSlot) {
      if (next === slot) return;
      slot = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
