import "server-only";
/**
 * CheckoutIntent (PIN-148): the server-minted opaque bridge
 * between a board and a future hosted checkout. The server mints
 * a random UUID intent id; the board mapping lives only in the
 * stored record. The public/Stripe-facing shape
 * (`toPublicCheckoutIntent`) carries the opaque intent id and the
 * pack offer only — never the board slug or any internal board
 * id, so nothing board-identifying can reach Stripe metadata,
 * `client_reference_id` or redirect URLs in the checkout slice.
 *
 * `purchaseId` is the intent id itself: one opaque identity for
 * the whole purchase. Creating an intent writes nothing to the
 * credit ledger — the caller drives the ledger's `recordPurchase`
 * flow with `{ purchaseId: intent.purchaseId, credits }` when it
 * starts checkout (and `closePurchase` only on a terminal outcome:
 * the session was never created, or Stripe reported it expired or
 * its async payment failed). Amounts, the per-board pending cap
 * and the TTL come from `Policy.credits` at the caller, mirroring
 * the credit ledger's no-Policy-import rule.
 *
 * Status (PIN-178): `pending` holds a per-board cap slot;
 * `expired` means the TTL passed and the slot was freed lazily,
 * while the ledger purchase stays pending so a late paid session
 * still grants; `closed` is final (granted, or a terminal outcome
 * above). The TTL never decides whether a paid session grants.
 *
 * No routes and no Stripe calls live here; this is the store port
 * plus its in-memory contract implementation.
 */
import { randomUUID } from "node:crypto";

export const CHECKOUT_INTENT_STATUSES = ["pending", "closed", "expired"] as const;
export type CheckoutIntentStatus = (typeof CHECKOUT_INTENT_STATUSES)[number];

/** The stored record. `boardId` is server-internal and never serialized into the public shape. */
export interface CheckoutIntent {
  /** Server-minted opaque UUID; the only identifier that may leave the server. */
  id: string;
  boardId: string;
  /** Pack lookup key from Policy.credits.packs at intent time. */
  packLookupKey: string;
  /** Pack size recorded at intent time; the later grant credits exactly this. */
  credits: number;
  /**
   * Pack price (EUR cents) recorded at intent time (PIN-181): the
   * webhook prices the amount check, refunds and disputes from
   * these stored terms, so a later Policy price change never
   * reprices an old purchase. Absent on intents created before
   * PIN-181; those fall back to the Policy pack by lookup key.
   * Server-only, never in the public shape.
   */
  eurCents?: number;
  /** Ledger purchase identity (equals `id`; see the module note). */
  purchaseId: string;
  status: CheckoutIntentStatus;
  createdAt: number;
  /** `createdAt + Policy.credits.intentTtlSeconds * 1000` at the caller. */
  expiresAt: number;
  /** Set when the intent leaves `pending` (closed or expired), and again when an expired intent closes. */
  closedAt?: number;
  /**
   * Stripe object mapping persisted by the webhook (PIN-150) at
   * grant time (or on any earlier session event), server-only:
   * later refund/dispute events carry charge/payment_intent ids,
   * never the intent id, so this is how they resolve back to
   * this purchase. Never enters the public shape.
   */
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeChargeId?: string;
  /** Epoch ms when the webhook granted this purchase (PIN-150). */
  grantedAt?: number;
  /**
   * Cumulative settled-EUR refund accounting (PIN-150): minor
   * units refunded across every counted per-refund delta, and
   * the makes those refunds have clawed back so far. The
   * webhook's cumulative money->makes formula reads both, so
   * partial refunds sum to the whole pack without drift.
   */
  refundedEurCents?: number;
  refundClawedMakes?: number;
  /** Refund ids whose EUR amount is already inside `refundedEurCents` (including zero-make deltas the ledger never saw). */
  countedRefundIds?: string[];
  /** Makes each counted refund clawed, by refund id (PIN-150): a retry after the atomic count replays exactly this delta into the ledger, which dedupes by refund id. */
  refundMakesById?: Record<string, number>;
  /** Makes finally clawed back per dispute id (PIN-150): a second final-clawback event for the same dispute is a no-op. */
  finalDisputeClawbacks?: Record<string, number>;
}

/** Everything a checkout/browser surface may see. No board identifier beyond the opaque `id`. */
export interface PublicCheckoutIntent {
  id: string;
  packLookupKey: string;
  credits: number;
  status: CheckoutIntentStatus;
  createdAt: number;
  expiresAt: number;
}

export function toPublicCheckoutIntent(intent: CheckoutIntent): PublicCheckoutIntent {
  return {
    id: intent.id,
    packLookupKey: intent.packLookupKey,
    credits: intent.credits,
    status: intent.status,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
  };
}

export interface CreateCheckoutIntentInput {
  boardId: string;
  packLookupKey: string;
  credits: number;
  /** The pack's Policy price in EUR cents at the caller (PIN-181). */
  eurCents: number;
  at: number;
  /** Policy.credits.intentTtlSeconds at the caller. */
  intentTtlSeconds: number;
  /** Policy.credits.pendingIntentCapPerBoard at the caller. */
  pendingIntentCapPerBoard: number;
}

/** Stripe ids the webhook may learn for one purchase (PIN-150). Any subset; set fields never change to a different value. */
export interface StripeIntentMapping {
  sessionId?: string;
  paymentIntentId?: string;
  chargeId?: string;
}

/** The Stripe ids a refund/dispute event carries (PIN-150). At least one is expected. */
export interface StripeIntentLookup {
  chargeId?: string;
  paymentIntentId?: string;
  sessionId?: string;
}

/**
 * Intent store port. `create` enforces the per-board pending cap
 * atomically (concurrent creates for one board cannot both pass
 * the cap) and lazily expires that board's stale pending intents
 * first, so an abandoned tab cannot block the board forever.
 * Lazy expiry only frees the cap slot (status `expired`); it never
 * touches the ledger, and the webhook resolves an intent by id
 * whatever its status (PIN-178).
 */
export interface CheckoutIntentStore {
  create(input: CreateCheckoutIntentInput): Promise<CheckoutIntent>;
  get(intentId: string): Promise<CheckoutIntent | null>;
  /** Final state for a pending or lazily expired intent (granted, or a terminal outcome); a closed intent stays as is. */
  close(intentId: string, at: number): Promise<CheckoutIntent | null>;
  /** Free a pending intent's cap slot once `at` reaches its expiry; anything else is returned unchanged. */
  expire(intentId: string, at: number): Promise<CheckoutIntent | null>;
  /**
   * Persist Stripe ids on the intent (PIN-150), idempotently:
   * re-recording the same ids is a no-op, and a conflicting id
   * for an already-set field throws RangeError (the webhook
   * dead-letters it) rather than silently remapping a purchase.
   * `grantedAt`, when passed, stamps the fulfilment instant.
   */
  recordStripeMapping(
    intentId: string,
    mapping: StripeIntentMapping,
    at: number,
    grantedAt?: number,
  ): Promise<CheckoutIntent | null>;
  /** Resolve a later refund/dispute back to its intent by charge, then payment_intent, then session id (PIN-150). Closed intents still resolve. */
  findByStripeIds(lookup: StripeIntentLookup): Promise<CheckoutIntent | null>;
  /**
   * Count one per-refund EUR delta + the makes it clawed back
   * (PIN-150), atomically and once per refund id: a repeat
   * returns `applied: false` with the stored record unchanged.
   */
  applyRefundAccounting(
    intentId: string,
    refundId: string,
    refundEurCents: number,
    clawedMakesDelta: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean }>;
  /**
   * Atomically count one refund AND compute its make delta
   * inside the same read-modify-write (PIN-150): the cumulative
   * floor formula `min(packCredits, floor(cumulativeCents *
   * packCredits / packEurCents)) - refundClawedMakes` must be
   * evaluated against the stored cumulative, never a caller
   * snapshot, or two concurrent refunds would both price
   * themselves as the first increment. A repeat refund id
   * returns `applied: false` with the originally computed
   * `deltaMakes`, so a retry replays the same ledger clawback
   * (the ledger itself dedupes by refund id).
   */
  countRefund(
    intentId: string,
    refundId: string,
    refundEurCents: number,
    packEurCents: number,
    packCredits: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean; deltaMakes: number }>;
  /** Record a dispute's final clawback makes once per dispute id (PIN-150); a repeat returns `applied: false`. */
  recordFinalDisputeClawback(
    intentId: string,
    disputeId: string,
    makes: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean }>;
}

export interface CheckoutIntentStoreOptions {
  /** Id mint, injectable for deterministic tests. Defaults to a random UUID. */
  newId?: () => string;
}

export function mintCheckoutIntentId(options: CheckoutIntentStoreOptions = {}): string {
  return options.newId ? options.newId() : randomUUID();
}

function assertId(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new RangeError(`${name} must be a non-empty string`);
  }
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

function assertAt(at: number): void {
  if (!Number.isFinite(at) || at < 0) {
    throw new RangeError(`at must be a finite epoch-ms timestamp, got ${at}`);
  }
}

export function assertCreateCheckoutIntentInput(input: CreateCheckoutIntentInput): void {
  assertId(input.boardId, "boardId");
  assertId(input.packLookupKey, "packLookupKey");
  assertPositiveInt(input.credits, "credits");
  assertPositiveInt(input.eurCents, "eurCents");
  assertAt(input.at);
  assertPositiveInt(input.intentTtlSeconds, "intentTtlSeconds");
  assertPositiveInt(input.pendingIntentCapPerBoard, "pendingIntentCapPerBoard");
}

export function buildCheckoutIntent(
  id: string,
  input: CreateCheckoutIntentInput,
): CheckoutIntent {
  assertId(id, "intentId");
  return {
    id,
    boardId: input.boardId,
    packLookupKey: input.packLookupKey,
    credits: input.credits,
    eurCents: input.eurCents,
    purchaseId: id,
    status: "pending",
    createdAt: input.at,
    expiresAt: input.at + input.intentTtlSeconds * 1000,
  };
}

/** The pending intents that still count against the cap at `at`, and the stale ones to expire. */
export function partitionPendingIntents(
  intents: readonly CheckoutIntent[],
  at: number,
): { live: CheckoutIntent[]; stale: CheckoutIntent[] } {
  const live: CheckoutIntent[] = [];
  const stale: CheckoutIntent[] = [];
  for (const intent of intents) {
    if (intent.status !== "pending") continue;
    if (at < intent.expiresAt) live.push(intent);
    else stale.push(intent);
  }
  return { live, stale };
}

export function capExceededError(boardId: string, cap: number): RangeError {
  return new RangeError(
    `Board ${boardId} already holds ${cap} pending checkout intents (cap ${cap})`,
  );
}

/** In-memory store: the test double and the port's contract. Method bodies never await between read and write, so each call is atomic. */
/** Merge a Stripe mapping into a clone of the intent (PIN-150): set ids never change to a different value. Shared by both stores. */
export function mergeStripeMapping(
  intent: CheckoutIntent,
  mapping: StripeIntentMapping,
  grantedAt?: number,
): CheckoutIntent {
  const next: CheckoutIntent = { ...intent };
  const fields: Array<[keyof StripeIntentMapping, "stripeSessionId" | "stripePaymentIntentId" | "stripeChargeId"]> = [
    ["sessionId", "stripeSessionId"],
    ["paymentIntentId", "stripePaymentIntentId"],
    ["chargeId", "stripeChargeId"],
  ];
  for (const [from, to] of fields) {
    const value = mapping[from];
    if (value === undefined) continue;
    assertId(value, from);
    if (next[to] && next[to] !== value) {
      throw new RangeError(
        `CheckoutIntent ${intent.id} already mapped to a different ${to}`,
      );
    }
    next[to] = value;
  }
  if (grantedAt !== undefined) {
    assertAt(grantedAt);
    next.grantedAt ??= grantedAt;
  }
  return next;
}

/** Count one refund delta on a clone (PIN-150). Returns null when the refund id is already counted. Shared by both stores. */
export function applyRefundAccountingToIntent(
  intent: CheckoutIntent,
  refundId: string,
  refundEurCents: number,
  clawedMakesDelta: number,
): CheckoutIntent | null {
  assertId(refundId, "refundId");
  if (!Number.isInteger(refundEurCents) || refundEurCents < 0) {
    throw new RangeError(`refundEurCents must be a non-negative integer, got ${refundEurCents}`);
  }
  if (!Number.isInteger(clawedMakesDelta) || clawedMakesDelta < 0) {
    throw new RangeError(`clawedMakesDelta must be a non-negative integer, got ${clawedMakesDelta}`);
  }
  const counted = intent.countedRefundIds ?? [];
  if (counted.includes(refundId)) return null;
  return {
    ...intent,
    refundedEurCents: (intent.refundedEurCents ?? 0) + refundEurCents,
    refundClawedMakes: (intent.refundClawedMakes ?? 0) + clawedMakesDelta,
    countedRefundIds: [...counted, refundId],
    refundMakesById: { ...(intent.refundMakesById ?? {}), [refundId]: clawedMakesDelta },
  };
}

/**
 * Count one refund and price its make delta from the stored
 * cumulative (PIN-150, see countRefund on the port). Returns
 * the next intent plus the delta, or the original delta with
 * `next: null` when the refund id is already counted. Shared
 * by both stores so the formula lives in exactly one place.
 */
export function countRefundOnIntent(
  intent: CheckoutIntent,
  refundId: string,
  refundEurCents: number,
  packEurCents: number,
  packCredits: number,
): { next: CheckoutIntent | null; deltaMakes: number } {
  assertId(refundId, "refundId");
  if (!Number.isInteger(refundEurCents) || refundEurCents < 0) {
    throw new RangeError(`refundEurCents must be a non-negative integer, got ${refundEurCents}`);
  }
  assertPositiveInt(packEurCents, "packEurCents");
  assertPositiveInt(packCredits, "packCredits");
  if ((intent.countedRefundIds ?? []).includes(refundId)) {
    return { next: null, deltaMakes: intent.refundMakesById?.[refundId] ?? 0 };
  }
  const cumulativeCents = (intent.refundedEurCents ?? 0) + refundEurCents;
  const targetMakes = Math.min(
    packCredits,
    Math.floor((cumulativeCents * packCredits) / packEurCents),
  );
  const deltaMakes = Math.max(0, targetMakes - (intent.refundClawedMakes ?? 0));
  const next = applyRefundAccountingToIntent(intent, refundId, refundEurCents, deltaMakes);
  if (!next) return { next: null, deltaMakes: intent.refundMakesById?.[refundId] ?? 0 };
  return { next, deltaMakes };
}

/** Record a dispute final clawback on a clone (PIN-150). Returns null when that dispute is already recorded. Shared by both stores. */
export function recordFinalDisputeClawbackOnIntent(
  intent: CheckoutIntent,
  disputeId: string,
  makes: number,
): CheckoutIntent | null {
  assertId(disputeId, "disputeId");
  if (!Number.isInteger(makes) || makes < 0) {
    throw new RangeError(`makes must be a non-negative integer, got ${makes}`);
  }
  const finals = intent.finalDisputeClawbacks ?? {};
  if (disputeId in finals) return null;
  return { ...intent, finalDisputeClawbacks: { ...finals, [disputeId]: makes } };
}

export class InMemoryCheckoutIntentStore implements CheckoutIntentStore {
  private readonly intents = new Map<string, CheckoutIntent>();

  constructor(private readonly options: CheckoutIntentStoreOptions = {}) {}

  async create(input: CreateCheckoutIntentInput): Promise<CheckoutIntent> {
    assertCreateCheckoutIntentInput(input);
    const pending = [...this.intents.values()].filter(
      (intent) => intent.boardId === input.boardId,
    );
    const { live, stale } = partitionPendingIntents(pending, input.at);
    if (live.length >= input.pendingIntentCapPerBoard) {
      throw capExceededError(input.boardId, input.pendingIntentCapPerBoard);
    }
    for (const intent of stale) {
      this.intents.set(intent.id, { ...intent, status: "expired", closedAt: input.at });
    }
    const intent = buildCheckoutIntent(mintCheckoutIntentId(this.options), input);
    if (this.intents.has(intent.id)) {
      throw new RangeError(`CheckoutIntent ${intent.id} already exists`);
    }
    this.intents.set(intent.id, structuredClone(intent));
    return structuredClone(intent);
  }

  async get(intentId: string): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    const intent = this.intents.get(intentId);
    return intent ? structuredClone(intent) : null;
  }

  async close(intentId: string, at: number): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    assertAt(at);
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    if (intent.status === "closed") return structuredClone(intent);
    const next: CheckoutIntent = { ...intent, status: "closed", closedAt: at };
    this.intents.set(intentId, next);
    return structuredClone(next);
  }

  async recordStripeMapping(
    intentId: string,
    mapping: StripeIntentMapping,
    at: number,
    grantedAt?: number,
  ): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    assertAt(at);
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    const next = mergeStripeMapping(intent, mapping, grantedAt);
    this.intents.set(intentId, structuredClone(next));
    return structuredClone(next);
  }

  async findByStripeIds(lookup: StripeIntentLookup): Promise<CheckoutIntent | null> {
    const all = [...this.intents.values()];
    const found =
      (lookup.chargeId
        ? all.find((intent) => intent.stripeChargeId === lookup.chargeId)
        : undefined) ??
      (lookup.paymentIntentId
        ? all.find((intent) => intent.stripePaymentIntentId === lookup.paymentIntentId)
        : undefined) ??
      (lookup.sessionId
        ? all.find((intent) => intent.stripeSessionId === lookup.sessionId)
        : undefined);
    return found ? structuredClone(found) : null;
  }

  async applyRefundAccounting(
    intentId: string,
    refundId: string,
    refundEurCents: number,
    clawedMakesDelta: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean }> {
    assertId(intentId, "intentId");
    const intent = this.intents.get(intentId);
    if (!intent) return { intent: null, applied: false };
    const next = applyRefundAccountingToIntent(intent, refundId, refundEurCents, clawedMakesDelta);
    if (!next) return { intent: structuredClone(intent), applied: false };
    this.intents.set(intentId, structuredClone(next));
    return { intent: structuredClone(next), applied: true };
  }

  async countRefund(
    intentId: string,
    refundId: string,
    refundEurCents: number,
    packEurCents: number,
    packCredits: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean; deltaMakes: number }> {
    assertId(intentId, "intentId");
    const intent = this.intents.get(intentId);
    if (!intent) return { intent: null, applied: false, deltaMakes: 0 };
    const { next, deltaMakes } = countRefundOnIntent(
      intent,
      refundId,
      refundEurCents,
      packEurCents,
      packCredits,
    );
    if (!next) return { intent: structuredClone(intent), applied: false, deltaMakes };
    this.intents.set(intentId, structuredClone(next));
    return { intent: structuredClone(next), applied: true, deltaMakes };
  }

  async recordFinalDisputeClawback(
    intentId: string,
    disputeId: string,
    makes: number,
  ): Promise<{ intent: CheckoutIntent | null; applied: boolean }> {
    assertId(intentId, "intentId");
    const intent = this.intents.get(intentId);
    if (!intent) return { intent: null, applied: false };
    const next = recordFinalDisputeClawbackOnIntent(intent, disputeId, makes);
    if (!next) return { intent: structuredClone(intent), applied: false };
    this.intents.set(intentId, structuredClone(next));
    return { intent: structuredClone(next), applied: true };
  }

  async expire(intentId: string, at: number): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    assertAt(at);
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    if (intent.status !== "pending" || at < intent.expiresAt) {
      return structuredClone(intent);
    }
    const next: CheckoutIntent = { ...intent, status: "expired", closedAt: at };
    this.intents.set(intentId, next);
    return structuredClone(next);
  }
}
