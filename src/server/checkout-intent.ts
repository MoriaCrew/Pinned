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
 * starts checkout (and `closePurchase` when an intent closes or
 * expires unpaid). Amounts, the per-board pending cap and the TTL
 * come from `Policy.credits` at the caller, mirroring the credit
 * ledger's no-Policy-import rule.
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
  /** Ledger purchase identity (equals `id`; see the module note). */
  purchaseId: string;
  status: CheckoutIntentStatus;
  createdAt: number;
  /** `createdAt + Policy.credits.intentTtlSeconds * 1000` at the caller. */
  expiresAt: number;
  /** Set when the intent leaves `pending` (closed or expired). */
  closedAt?: number;
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

/** Payable right now: still pending and strictly before its expiry instant. */
export function isCheckoutIntentResolvable(intent: CheckoutIntent, at: number): boolean {
  return intent.status === "pending" && at < intent.expiresAt;
}

export interface CreateCheckoutIntentInput {
  boardId: string;
  packLookupKey: string;
  credits: number;
  at: number;
  /** Policy.credits.intentTtlSeconds at the caller. */
  intentTtlSeconds: number;
  /** Policy.credits.pendingIntentCapPerBoard at the caller. */
  pendingIntentCapPerBoard: number;
}

/**
 * Intent store port. `create` enforces the per-board pending cap
 * atomically (concurrent creates for one board cannot both pass
 * the cap) and lazily expires that board's stale pending intents
 * first, so an abandoned tab cannot block the board forever.
 * `resolvePending` is the webhook-side question "is this intent
 * still payable": it lazily expires a stale pending intent and
 * answers `null` for anything not resolvable.
 */
export interface CheckoutIntentStore {
  create(input: CreateCheckoutIntentInput): Promise<CheckoutIntent>;
  get(intentId: string): Promise<CheckoutIntent | null>;
  resolvePending(intentId: string, at: number): Promise<CheckoutIntent | null>;
  close(intentId: string, at: number): Promise<CheckoutIntent | null>;
  expire(intentId: string, at: number): Promise<CheckoutIntent | null>;
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

  async resolvePending(intentId: string, at: number): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    assertAt(at);
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    if (intent.status === "pending" && at >= intent.expiresAt) {
      this.intents.set(intentId, { ...intent, status: "expired", closedAt: at });
      return null;
    }
    return isCheckoutIntentResolvable(intent, at) ? structuredClone(intent) : null;
  }

  async close(intentId: string, at: number): Promise<CheckoutIntent | null> {
    assertId(intentId, "intentId");
    assertAt(at);
    const intent = this.intents.get(intentId);
    if (!intent) return null;
    if (intent.status !== "pending") return structuredClone(intent);
    const next: CheckoutIntent = { ...intent, status: "closed", closedAt: at };
    this.intents.set(intentId, next);
    return structuredClone(next);
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
