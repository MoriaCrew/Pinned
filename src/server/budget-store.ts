import "server-only";
/**
 * BudgetStore selection (PIN-61), mirroring repository.ts: the
 * Firestore counter in hosted environments, the in-process counter
 * for memory backend/dev. Selected explicitly from DATA_BACKEND.
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryBudgetStore,
  type BudgetStore,
} from "../gateway/budget";
import { createFirestoreBudgetStore } from "./firestore-budget-store";

export function createBudgetStore(config: AppConfig = getConfig()): BudgetStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreBudgetStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryBudgetStore();
}

const globalBudget = globalThis as typeof globalThis & {
  __pinnedBudgetStore?: BudgetStore;
};

/** Process-wide store so the memory counter stays coherent in dev. */
export function getBudgetStore(): BudgetStore {
  globalBudget.__pinnedBudgetStore ??= createBudgetStore();
  return globalBudget.__pinnedBudgetStore;
}
