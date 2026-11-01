import "server-only";
/**
 * Server DecomposeJobStore selection (PIN-65), mirroring
 * ./board-repository.ts: Firestore in hosted environments,
 * in-memory as the deterministic local/test fallback.
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryDecomposeJobStore,
  type DecomposeJobStore,
} from "./decompose-job";
import { createFirestoreDecomposeJobStore } from "./firestore-decompose-job-store";

export function createDecomposeJobStore(
  config: AppConfig = getConfig(),
): DecomposeJobStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreDecomposeJobStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryDecomposeJobStore();
}

const globalStore = globalThis as typeof globalThis & {
  __pinnedDecomposeJobStore?: DecomposeJobStore;
};

/** Process-wide store; also makes the memory fallback coherent in dev. */
export function getDecomposeJobStore(): DecomposeJobStore {
  globalStore.__pinnedDecomposeJobStore ??= createDecomposeJobStore();
  return globalStore.__pinnedDecomposeJobStore;
}
