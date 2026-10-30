import "server-only";
/**
 * CreditLedgerStore selection (PIN-149), mirroring
 * ./budget-store.ts: Firestore in hosted environments, the
 * in-memory contract store for the memory backend. Added by the
 * first slice that calls the store (PIN-148 shipped the stores
 * without selection on purpose).
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryCreditLedgerStore,
  type CreditLedgerStore,
} from "../domain/credit-ledger";
import { createFirestoreCreditLedgerStore } from "./firestore-credit-ledger-store";

export function createCreditLedgerStore(
  config: AppConfig = getConfig(),
): CreditLedgerStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreCreditLedgerStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryCreditLedgerStore();
}

const globalLedger = globalThis as typeof globalThis & {
  __pinnedCreditLedgerStore?: CreditLedgerStore;
};

/** Process-wide store so the memory fallback stays coherent in dev. */
export function getCreditLedgerStore(): CreditLedgerStore {
  globalLedger.__pinnedCreditLedgerStore ??= createCreditLedgerStore();
  return globalLedger.__pinnedCreditLedgerStore;
}
