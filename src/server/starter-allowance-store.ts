import "server-only";
/**
 * StarterAllowanceStore selection (PIN-204), mirroring
 * ./credit-ledger-store.ts: Firestore in hosted environments, the
 * in-memory contract store for the memory backend.
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryStarterAllowanceStore,
  type StarterAllowanceStore,
} from "../domain/starter-allowance";
import { createFirestoreStarterAllowanceStore } from "./firestore-starter-allowance-store";

export function createStarterAllowanceStore(
  config: AppConfig = getConfig(),
): StarterAllowanceStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreStarterAllowanceStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryStarterAllowanceStore();
}

const globalAllowance = globalThis as typeof globalThis & {
  __pinnedStarterAllowanceStore?: StarterAllowanceStore;
};

/** Process-wide store so the memory fallback stays coherent in dev. */
export function getStarterAllowanceStore(): StarterAllowanceStore {
  globalAllowance.__pinnedStarterAllowanceStore ??= createStarterAllowanceStore();
  return globalAllowance.__pinnedStarterAllowanceStore;
}
