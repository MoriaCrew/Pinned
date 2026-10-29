import "server-only";
/**
 * Generated-chips cache port (PIN-75). One entry per sorted
 * lowercased label set, addressed by the sha256 of the canonical
 * key material (src/domain/chips) so the Firestore home is a
 * direct doc get — no query, no new index. Labels themselves are
 * short element display names, already link-public on the board;
 * the hash just keeps doc ids tidy and slug-free.
 */
import { createHash } from "node:crypto";
import type { ChipsCacheEntry } from "../domain/chips";

export interface ChipsCacheStore {
  /** Entry for a canonical key base, or null (freshness is the caller's Policy check). */
  get(keyBase: string): Promise<ChipsCacheEntry | null>;
  put(entry: ChipsCacheEntry): Promise<void>;
}

export function chipsCacheDocId(keyBase: string): string {
  return createHash("sha256").update(keyBase, "utf8").digest("hex");
}

export class InMemoryChipsCacheStore implements ChipsCacheStore {
  private entries = new Map<string, ChipsCacheEntry>();

  async get(keyBase: string): Promise<ChipsCacheEntry | null> {
    const entry = this.entries.get(chipsCacheDocId(keyBase));
    return entry ? structuredClone(entry) : null;
  }

  async put(entry: ChipsCacheEntry): Promise<void> {
    this.entries.set(chipsCacheDocId(entry.key), structuredClone(entry));
  }
}
