import "server-only";
/**
 * CheckoutIntentStore selection (PIN-149), mirroring
 * ./budget-store.ts: Firestore in hosted environments, the
 * in-memory contract store for the memory backend. Added by the
 * first slice that calls the store (PIN-148 shipped the stores
 * without selection on purpose).
 */
import { getConfig, type AppConfig } from "../config";
import {
  InMemoryCheckoutIntentStore,
  type CheckoutIntentStore,
} from "./checkout-intent";
import { createFirestoreCheckoutIntentStore } from "./firestore-checkout-intent-store";

export function createCheckoutIntentStore(
  config: AppConfig = getConfig(),
): CheckoutIntentStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreCheckoutIntentStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryCheckoutIntentStore();
}

const globalIntents = globalThis as typeof globalThis & {
  __pinnedCheckoutIntentStore?: CheckoutIntentStore;
};

/** Process-wide store so the memory fallback stays coherent in dev. */
export function getCheckoutIntentStore(): CheckoutIntentStore {
  globalIntents.__pinnedCheckoutIntentStore ??= createCheckoutIntentStore();
  return globalIntents.__pinnedCheckoutIntentStore;
}
