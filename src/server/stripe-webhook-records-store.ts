import "server-only";
/**
 * StripeWebhookRecordStore selection (PIN-150), mirroring
 * ./checkout-intent-store.ts: Firestore in hosted environments,
 * the in-memory contract store for the memory backend.
 */
import { getConfig, type AppConfig } from "../config";
import { createFirestoreStripeWebhookRecordStore } from "./firestore-stripe-webhook-records";
import {
  InMemoryStripeWebhookRecordStore,
  type StripeWebhookRecordStore,
} from "./stripe-webhook-records";

export function createStripeWebhookRecordStore(
  config: AppConfig = getConfig(),
): StripeWebhookRecordStore {
  if (config.dataBackend === "firestore") {
    return createFirestoreStripeWebhookRecordStore({
      projectId: config.firebaseProjectId,
      emulatorHost: config.firestoreEmulatorHost,
    });
  }
  return new InMemoryStripeWebhookRecordStore();
}

const globalRecords = globalThis as typeof globalThis & {
  __pinnedStripeWebhookRecordStore?: StripeWebhookRecordStore;
};

/** Process-wide store so the memory fallback stays coherent in dev. */
export function getStripeWebhookRecordStore(): StripeWebhookRecordStore {
  globalRecords.__pinnedStripeWebhookRecordStore ??= createStripeWebhookRecordStore();
  return globalRecords.__pinnedStripeWebhookRecordStore;
}
