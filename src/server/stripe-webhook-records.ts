import "server-only";
/**
 * Durable Stripe webhook bookkeeping (PIN-150): one processed-
 * event record per Stripe event id (replay across restarts is a
 * no-op before any ledger work runs) and one dead-letter record
 * per event the handler could not apply but must still ack 200
 * (unknown/dead intent, amount mismatch, unknown refund/dispute
 * mapping). Dead letters are the operator flag: PIN-153's
 * reconciliation drains them. Records carry Stripe ids and ids
 * of our own only - never a full payload, never a board slug
 * beyond the server-internal boardId the ledger already keys.
 */

export interface ProcessedStripeEvent {
  eventId: string;
  eventType: string;
  /** Handler outcome word (granted, frozen, dead_letter, ...). */
  outcome: string;
  processedAt: number;
}

export interface BillingDeadLetter {
  /** Deterministic `{eventId}:{reason}` so a replay writes one record ever. */
  id: string;
  eventId: string;
  eventType: string;
  reason: string;
  intentId?: string;
  boardId?: string;
  stripeObjectId?: string;
  chargeId?: string;
  paymentIntentId?: string;
  refundId?: string;
  disputeId?: string;
  /** Always true: a human (or PIN-153 reconciliation) must look. */
  operatorFlag: true;
  createdAt: number;
}

export function deadLetterId(eventId: string, reason: string): string {
  return `${eventId}:${reason}`;
}

export interface StripeWebhookRecordStore {
  getProcessed(eventId: string): Promise<ProcessedStripeEvent | null>;
  /** Write the processed record once; a repeat keeps the first and returns false. */
  markProcessed(record: ProcessedStripeEvent): Promise<boolean>;
  /** Write the dead letter once (by deterministic id); a repeat keeps the first. */
  addDeadLetter(record: BillingDeadLetter): Promise<boolean>;
  listDeadLetters(): Promise<BillingDeadLetter[]>;
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

/** In-memory store: the test double and the port's contract. */
export class InMemoryStripeWebhookRecordStore implements StripeWebhookRecordStore {
  private readonly processed = new Map<string, ProcessedStripeEvent>();
  private readonly deadLetters = new Map<string, BillingDeadLetter>();

  async getProcessed(eventId: string): Promise<ProcessedStripeEvent | null> {
    assertId(eventId, "eventId");
    const record = this.processed.get(eventId);
    return record ? structuredClone(record) : null;
  }

  async markProcessed(record: ProcessedStripeEvent): Promise<boolean> {
    assertId(record.eventId, "eventId");
    if (this.processed.has(record.eventId)) return false;
    this.processed.set(record.eventId, structuredClone(record));
    return true;
  }

  async addDeadLetter(record: BillingDeadLetter): Promise<boolean> {
    assertId(record.id, "id");
    if (this.deadLetters.has(record.id)) return false;
    this.deadLetters.set(record.id, structuredClone(record));
    return true;
  }

  async listDeadLetters(): Promise<BillingDeadLetter[]> {
    return structuredClone([...this.deadLetters.values()]);
  }
}
