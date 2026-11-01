import "server-only";
/**
 * ChipsCacheStore selection (PIN-75), mirroring budget-store.ts:
 * the Firestore doc cache in hosted environments, the in-process
 * cache for the memory backend/dev. Selected from DATA_BACKEND.
 */
import { getConfig, type AppConfig } from "../config";
import { InMemoryChipsCacheStore, type ChipsCacheStore } from "./chips-cache";
import { createFirestoreChipsCacheStore } from "./firestore-chips-cache";

export function createChipsCacheStore(config: AppConfig = getConfig()): ChipsCacheStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreChipsCacheStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryChipsCacheStore();
}

const globalChipsCache = globalThis as typeof globalThis & {
  __pinnedChipsCacheStore?: ChipsCacheStore;
};

/** Process-wide store so the memory cache stays coherent in dev. */
export function getChipsCacheStore(): ChipsCacheStore {
  globalChipsCache.__pinnedChipsCacheStore ??= createChipsCacheStore();
  return globalChipsCache.__pinnedChipsCacheStore;
}
