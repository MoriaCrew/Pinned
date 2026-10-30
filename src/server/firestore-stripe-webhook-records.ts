import "server-only";
/**
 * Firestore StripeWebhookRecordStore (PIN-150).
 *
 * Layout:
 * - stripeWebhookEvents/{eventId}: the processed-event record,
 *   create-if-absent inside a transaction so a replay after a
 *   restart (or a concurrent retry) never re-runs ledger work
 *   for an event the first delivery finished.
 * - billingDeadLetters/{eventId:reason}: operator-flag records
 *   for PIN-153 reconciliation, also create-if-absent. The doc
 *   id is URI-encoded (the `:` separator is legal, but encoding
 *   keeps every id shape safe by construction).
 *
 * Client access stays deny-all in firestore.rules, like every
 * other billing collection.
 */
import {
  Firestore,
  type DocumentData,
  type DocumentReference,
} from "@google-cloud/firestore";
import type {
  BillingDeadLetter,
  ProcessedStripeEvent,
  StripeWebhookRecordStore,
} from "./stripe-webhook-records";

const PROCESSED_EVENTS = "stripeWebhookEvents";
const DEAD_LETTERS = "billingDeadLetters";

function toFirestoreData<T extends object>(value: T): DocumentData {
  return JSON.parse(JSON.stringify(value)) as DocumentData;
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

export class FirestoreStripeWebhookRecordStore implements StripeWebhookRecordStore {
  constructor(private readonly db: Firestore) {}

  private processedRef(eventId: string): DocumentReference {
    return this.db.collection(PROCESSED_EVENTS).doc(encodeURIComponent(eventId));
  }

  private deadLetterRef(id: string): DocumentReference {
    return this.db.collection(DEAD_LETTERS).doc(encodeURIComponent(id));
  }

  async getProcessed(eventId: string): Promise<ProcessedStripeEvent | null> {
    assertId(eventId, "eventId");
    const snap = await this.processedRef(eventId).get();
    return snap.exists
      ? (structuredClone(snap.data()) as unknown as ProcessedStripeEvent)
      : null;
  }

  async markProcessed(record: ProcessedStripeEvent): Promise<boolean> {
    assertId(record.eventId, "eventId");
    const ref = this.processedRef(record.eventId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, toFirestoreData(record));
      return true;
    });
  }

  async addDeadLetter(record: BillingDeadLetter): Promise<boolean> {
    assertId(record.id, "id");
    const ref = this.deadLetterRef(record.id);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, toFirestoreData(record));
      return true;
    });
  }

  async listDeadLetters(): Promise<BillingDeadLetter[]> {
    const snap = await this.db.collection(DEAD_LETTERS).get();
    return snap.docs.map(
      (doc) => structuredClone(doc.data()) as unknown as BillingDeadLetter,
    );
  }
}

export interface FirestoreStripeWebhookRecordStoreOptions {
  projectId?: string | null;
  emulatorHost?: string | null;
}

export function createFirestoreStripeWebhookRecordStore(
  options: FirestoreStripeWebhookRecordStoreOptions = {},
): FirestoreStripeWebhookRecordStore {
  const db = options.emulatorHost
    ? new Firestore({
        projectId: options.projectId ?? undefined,
        host: options.emulatorHost,
        ssl: false,
      })
    : new Firestore({ projectId: options.projectId ?? undefined });
  return new FirestoreStripeWebhookRecordStore(db);
}
