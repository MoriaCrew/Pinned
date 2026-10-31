import "server-only";
/**
 * Stripe webhook service (PIN-150, docs/15): translates signed
 * Stripe events into credit-ledger operations. The route hands
 * over the RAW body + `Stripe-Signature` header; verification
 * is the injected client's SDK `constructEvent` (see
 * src/billing/stripe-webhook.ts), so forged or tampered bodies
 * never reach a handler.
 *
 * Response contract (the route maps these): only config errors
 * (mode off / no signing secret / no client) and signature
 * errors are non-2xx, plus unexpected store/API failures, which
 * propagate so Stripe retries them. Everything a handler can
 * decide - processed, duplicate, unhandled type, and every
 * dead-letter below - returns 200, because retrying would only
 * replay the same decision.
 *
 * Idempotency is layered, mirroring the ledger (PIN-147): a
 * durable processed-event record per Stripe event id short-
 * circuits replays across restarts, and underneath it the
 * ledger ops are idempotent by event/purchase/refund/dispute
 * id, so a crash between the ledger write and the processed
 * record still converges on retry. An event that wrote a dead
 * letter gets no processed record (PIN-178): an operator who
 * fixed the cause re-runs it with the Dashboard's Resend, and
 * that ledger idempotency makes the re-run safe.
 *
 * MONEY -> MAKES (the one documented formula). For a pack of
 * `credits` makes sold for `eurCents` (the terms the intent
 * stored at buy time, PIN-181; legacy intents read
 * Policy.credits.packs), a settled-EUR amount of `c` cents is
 * worth, cumulatively:
 *
 *     makesFloor(c)  = min(credits, floor(c * credits / eurCents))
 *     makesFreeze(c) = min(credits, ceil (c * credits / eurCents))
 *
 * Refund clawbacks track the cumulative refunded EUR cents on
 * the intent: each succeeded per-refund delta adds its cents
 * to the cumulative, and claws back
 * `makesFloor(newCumulative) - makesAlreadyClawedForRefunds`,
 * so any split of partial refunds sums to exactly the pack at
 * a full refund, with no per-delta rounding drift. Dispute
 * final clawbacks use `makesFloor` on the disputed settled
 * amount; dispute freezes use `makesFreeze` (round up, so the
 * held pool is protected while the dispute is open - any
 * excess over the final floor amount is restored by the same
 * terminal event that claws).
 * Foreign-presentment amounts are never FX-guessed: the
 * settled EUR amount comes from the BalanceTransaction Stripe
 * reports (its amount/currency are the account settlement
 * values); when that cannot be read as EUR, the event
 * dead-letters for PIN-153 reconciliation instead.
 *
 * Event semantics checked against docs.stripe.com (webhooks,
 * Checkout fulfilment, Refund object, dispute lifecycle):
 * - Fulfilment must be idempotent per Checkout Session and
 *   keys off `payment_status`; `checkout.session.completed`
 *   with an async method arrives `unpaid` and grants only when
 *   `async_payment_succeeded` follows through the same path.
 * - A Refund's status transitions (`pending`/`requires_action`
 *   -> `succeeded`/`failed`/`canceled`, notified on
 *   `refund.updated` / `refund.failed`), so clawback happens
 *   only on `succeeded`, from the per-refund object - never
 *   from the cumulative `charge.refunded`.
 * - Disputes debit on creation, `funds_withdrawn` when funds
 *   leave the account, `funds_reinstated` when they return
 *   after a win, and `closed` carries `won`/`lost`/
 *   `warning_closed`. Card disputes withdraw funds within
 *   about a second of creation, so `funds_withdrawn` only
 *   keeps (or establishes) the freeze (PIN-178); the one final
 *   clawback is `closed` with `lost`. A reinstate arriving
 *   after a final clawback cannot be un-clawed by the ledger,
 *   so it dead-letters as an operator flag rather than
 *   pretending.
 */
import type { StripeWebhookClientLike } from "../billing/stripe-webhook";
import type { BoardRepository } from "../domain/board-repository";
import {
  availableCredits,
  type BoardCreditAccount,
  type CreditLedgerStore,
  type CreditPurchase,
} from "../domain/credit-ledger";
import type { PlusMode } from "../domain/plus";
import type { Policy, PolicyCreditPack } from "../policy/policy";
import type {
  CheckoutIntent,
  CheckoutIntentStore,
  StripeIntentMapping,
} from "./checkout-intent";
import {
  deadLetterId,
  type BillingDeadLetter,
  type StripeWebhookRecordStore,
} from "./stripe-webhook-records";

/** The exact event list PIN-153 registers on the endpoint (snapshot payloads, pinned API version). */
export const STRIPE_WEBHOOK_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
] as const;

/** The price terms one purchase is held to (PIN-181): its stored intent terms, or the Policy pack for a legacy intent. */
export type PackTerms = Pick<PolicyCreditPack, "credits" | "eurCents">;

/** `min(credits, floor(cents * credits / eurCents))` - refund + final-clawback conversion (see module note). */
export function makesFloorForCents(cents: number, pack: PackTerms): number {
  if (!Number.isInteger(cents) || cents <= 0) return 0;
  return Math.min(pack.credits, Math.floor((cents * pack.credits) / pack.eurCents));
}

/** `min(credits, ceil(cents * credits / eurCents))` - dispute freezes round up to protect the pool. */
export function makesFreezeForCents(cents: number, pack: PackTerms): number {
  if (!Number.isInteger(cents) || cents <= 0) return 0;
  return Math.min(pack.credits, Math.ceil((cents * pack.credits) / pack.eurCents));
}

export class StripeWebhookConfigError extends Error {
  constructor(message = "Stripe webhook is not configured.") {
    super(message);
    this.name = "StripeWebhookConfigError";
  }
}

export class StripeWebhookSignatureError extends Error {
  constructor(message = "Stripe webhook signature verification failed.") {
    super(message);
    this.name = "StripeWebhookSignatureError";
  }
}

export interface StripeWebhookDeps {
  plusMode: PlusMode;
  webhookSecret: string | null;
  client: StripeWebhookClientLike | null;
  intents: CheckoutIntentStore;
  ledger: CreditLedgerStore;
  records: StripeWebhookRecordStore;
  /** Board existence for the dead-board grant refusal; null skips the check (unit fakes). */
  boards: BoardRepository | null;
  policy: Policy;
  /** Per-board policy (the buy path packs came from it); falls back to `policy`. */
  resolvePolicyForBoard?: (boardId: string) => Promise<Policy>;
  now?: () => number;
}

export interface StripeWebhookResult {
  eventId: string;
  outcome: string;
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Structural payload reading: webhook snapshots are untyped here
// on purpose, so an API-version field drift reads as "absent"
// (and dead-letters) instead of throwing a TypeError into a 500.
// ---------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Obj;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** `"ch_..."` or an expanded `{ id: "ch_..." }` -> the id. */
function idOf(value: unknown): string | null {
  return str(value) ?? str(obj(value)?.id);
}

interface ParsedEvent {
  id: string;
  type: string;
  /** Event `created` as epoch ms, or null when absent/junk. */
  createdAt: number | null;
  object: Obj;
}

function parseEvent(raw: unknown): ParsedEvent | null {
  const event = obj(raw);
  if (!event) return null;
  const id = str(event.id);
  const type = str(event.type);
  const data = obj(event.data);
  const object = data ? obj(data.object) : null;
  if (!id || !type || !object) return null;
  const created = int(event.created);
  return { id, type, createdAt: created !== null && created >= 0 ? created * 1000 : null, object };
}

interface HandlerContext {
  event: ParsedEvent;
  /** Ledger `at`: the event's own creation time when it carries one. */
  at: number;
  /** Set by `deadLetter`: this delivery wrote an operator flag, so it is not recorded as processed (PIN-178). */
  deadLettered: boolean;
}

async function policyFor(deps: StripeWebhookDeps, boardId: string): Promise<Policy> {
  return deps.resolvePolicyForBoard ? deps.resolvePolicyForBoard(boardId) : deps.policy;
}

/**
 * The terms a purchase is priced against (PIN-181): the
 * `{ credits, eurCents }` its intent stored at buy time, so a
 * later Policy price change (or a retired pack) never reprices
 * an old purchase. Only a legacy intent without `eurCents` falls
 * back to the board's Policy pack by lookup key; null when that
 * pack is gone (the callers dead-letter `pack_mismatch`).
 */
async function packFor(deps: StripeWebhookDeps, intent: CheckoutIntent): Promise<PackTerms | null> {
  const stored = intent.eurCents;
  if (typeof stored === "number" && Number.isInteger(stored) && stored > 0) {
    return { credits: intent.credits, eurCents: stored };
  }
  const policy = await policyFor(deps, intent.boardId);
  return policy.credits.packs.find((pack) => pack.lookupKey === intent.packLookupKey) ?? null;
}

type DeadLetterExtra = Partial<
  Pick<
    BillingDeadLetter,
    "intentId" | "boardId" | "stripeObjectId" | "chargeId" | "paymentIntentId" | "refundId" | "disputeId"
  >
>;

/** Write the operator-flag record and report the dead-letter outcome (still a 200 to Stripe). */
async function deadLetter(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  reason: string,
  extra: DeadLetterExtra = {},
): Promise<string> {
  ctx.deadLettered = true;
  await deps.records.addDeadLetter({
    id: deadLetterId(ctx.event.id, reason),
    eventId: ctx.event.id,
    eventType: ctx.event.type,
    reason,
    ...extra,
    operatorFlag: true,
    createdAt: deps.now?.() ?? Date.now(),
  });
  return "dead_letter";
}

/** A BalanceTransaction object from an id string or an expanded value, else null. */
async function balanceTransactionObject(
  deps: StripeWebhookDeps,
  value: unknown,
): Promise<Obj | null> {
  const expanded = obj(value);
  if (expanded) return expanded;
  const txnId = str(value);
  if (!txnId || !deps.client) return null;
  return obj(await deps.client.retrieveBalanceTransaction(txnId));
}

/** Settled EUR cents from a BalanceTransaction value (id string, or expanded object), else null. Negative refund/debit amounts count by magnitude. */
async function balanceTransactionEurCents(
  deps: StripeWebhookDeps,
  value: unknown,
): Promise<number | null> {
  const txn = await balanceTransactionObject(deps, value);
  if (!txn) return null;
  const amount = int(txn.amount);
  if (amount === null || str(txn.currency)?.toLowerCase() !== "eur") return null;
  return Math.abs(amount);
}

/**
 * Convert a presentment-currency amount on a charge to settled
 * EUR cents via the charge BalanceTransaction's Stripe-reported
 * `exchange_rate` (documented: charge-currency amount times
 * exchange_rate equals the settled amount), else null. This is
 * Stripe's own rate for this charge, never a guessed FX rate;
 * used for a dispute whose payload carries no balance
 * transactions yet (`charge.dispute.created` usually has none),
 * where the freeze is provisional and the final clawback still
 * prefers the dispute's own BalanceTransaction when it lands.
 */
async function eurCentsViaChargeExchangeRate(
  deps: StripeWebhookDeps,
  chargeId: string | null,
  presentmentCents: number | null,
): Promise<number | null> {
  if (!chargeId || presentmentCents === null || presentmentCents < 0 || !deps.client) return null;
  const charge = obj(await deps.client.retrieveCharge(chargeId));
  if (!charge) return null;
  const txn = await balanceTransactionObject(deps, charge.balance_transaction);
  if (!txn || str(txn.currency)?.toLowerCase() !== "eur") return null;
  const rate = txn.exchange_rate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(presentmentCents * rate);
}

/** Settled EUR cents for a charge via its BalanceTransaction, else null. */
async function settledEurCentsForCharge(
  deps: StripeWebhookDeps,
  chargeId: string,
): Promise<number | null> {
  const client = deps.client;
  if (!client) return null;
  const charge = obj(await client.retrieveCharge(chargeId));
  if (!charge) return null;
  return balanceTransactionEurCents(deps, charge.balance_transaction);
}

/** The charge id behind a session: expanded `payment_intent.latest_charge`, else one PaymentIntent retrieval. */
async function chargeIdForSession(
  deps: StripeWebhookDeps,
  session: Obj,
): Promise<string | null> {
  const paymentIntent = obj(session.payment_intent);
  const expanded = paymentIntent ? idOf(paymentIntent.latest_charge) : null;
  if (expanded) return expanded;
  const paymentIntentId = idOf(session.payment_intent);
  if (!paymentIntentId || !deps.client) return null;
  const retrieved = obj(await deps.client.retrievePaymentIntent(paymentIntentId));
  return retrieved ? idOf(retrieved.latest_charge) : null;
}

/** Settled EUR cents for a session whose snapshot currency is not EUR (Adaptive Pricing presentment). */
async function settledEurCentsForSession(
  deps: StripeWebhookDeps,
  session: Obj,
): Promise<number | null> {
  const paymentIntent = obj(session.payment_intent);
  const expandedCharge = paymentIntent ? obj(paymentIntent.latest_charge) : null;
  if (expandedCharge) {
    const cents = await balanceTransactionEurCents(deps, expandedCharge.balance_transaction);
    if (cents !== null) return cents;
  }
  const chargeId = await chargeIdForSession(deps, session);
  return chargeId ? settledEurCentsForCharge(deps, chargeId) : null;
}

function sessionMapping(session: Obj): StripeIntentMapping {
  const paymentIntent = obj(session.payment_intent);
  return {
    ...(str(session.id) ? { sessionId: str(session.id) as string } : {}),
    ...(idOf(session.payment_intent)
      ? { paymentIntentId: idOf(session.payment_intent) as string }
      : {}),
    ...(paymentIntent && idOf(paymentIntent.latest_charge)
      ? { chargeId: idOf(paymentIntent.latest_charge) as string }
      : {}),
  };
}

/** The intent id a session carries: metadata first (what PIN-149 sets), then client_reference_id. Nothing else may name it. */
function sessionIntentId(session: Obj): string | null {
  return str(obj(session.metadata)?.checkout_intent_id) ?? str(session.client_reference_id);
}

/** Persist a session mapping; false (after a dead letter) on a conflicting remap. Store failures still propagate for Stripe retry. */
async function persistSessionMapping(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  intent: CheckoutIntent,
  mapping: StripeIntentMapping,
  grantedAt?: number,
): Promise<boolean> {
  if (!mapping.sessionId && !mapping.paymentIntentId && !mapping.chargeId && grantedAt === undefined) {
    return true;
  }
  try {
    await deps.intents.recordStripeMapping(intent.id, mapping, ctx.at, grantedAt);
    return true;
  } catch (error) {
    if (error instanceof RangeError) {
      await deadLetter(deps, ctx, "mapping_conflict", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: mapping.sessionId,
        chargeId: mapping.chargeId,
        paymentIntentId: mapping.paymentIntentId,
      });
      return false;
    }
    throw error;
  }
}

/**
 * The one fulfil path for `checkout.session.completed` and
 * `checkout.session.async_payment_succeeded`. Grants only a
 * `paid` session whose amount/currency + pack cross-check
 * against the intent the session itself names, whatever the
 * intent's status or age, while its ledger purchase is still
 * pending and the board exists.
 */
async function fulfilSession(deps: StripeWebhookDeps, ctx: HandlerContext): Promise<string> {
  let session = ctx.event.object;
  // Documented fulfilment shape: retrieve the session when the
  // snapshot lacks the fields the grant decision needs.
  if (!str(session.payment_status) || int(session.amount_total) === null || !str(session.currency)) {
    const sessionId = str(session.id);
    if (sessionId && deps.client) {
      const retrieved = obj(await deps.client.retrieveCheckoutSession(sessionId));
      if (retrieved) session = { ...session, ...retrieved };
    }
  }
  const intentId = sessionIntentId(session);
  if (!intentId) {
    return deadLetter(deps, ctx, "unknown_intent", { stripeObjectId: str(session.id) ?? undefined });
  }
  const intent = await deps.intents.get(intentId);
  if (!intent) {
    return deadLetter(deps, ctx, "unknown_intent", {
      intentId,
      stripeObjectId: str(session.id) ?? undefined,
    });
  }

  const mapping = sessionMapping(session);
  if (str(session.payment_status) !== "paid") {
    // Async method still collecting: remember the ids, grant nothing.
    await persistSessionMapping(deps, ctx, intent, mapping);
    return "ignored_unpaid";
  }
  if (!mapping.chargeId) {
    const chargeId = await chargeIdForSession(deps, session);
    if (chargeId) mapping.chargeId = chargeId;
  }

  const account = await deps.ledger.getAccount(intent.boardId);
  const purchase = account?.purchases[intent.purchaseId];
  if (!purchase) {
    return deadLetter(deps, ctx, "unknown_purchase", {
      intentId: intent.id,
      boardId: intent.boardId,
      stripeObjectId: str(session.id) ?? undefined,
    });
  }
  if (purchase.grantedCredits > 0) {
    // The other event (completed / async success) landed first.
    await persistSessionMapping(deps, ctx, intent, mapping, intent.grantedAt ?? ctx.at);
    await deps.intents.close(intent.id, ctx.at);
    return "duplicate_grant";
  }
  if (deps.boards && !(await deps.boards.getBoard(intent.boardId))) {
    return deadLetter(deps, ctx, "dead_board", {
      intentId: intent.id,
      boardId: intent.boardId,
      stripeObjectId: str(session.id) ?? undefined,
      chargeId: mapping.chargeId,
      paymentIntentId: mapping.paymentIntentId,
    });
  }

  const pack = await packFor(deps, intent);
  const metadata = obj(session.metadata);
  const metadataPack = str(metadata?.pack_lookup_key);
  const metadataCredits = str(metadata?.credits);
  if (
    !pack ||
    pack.credits !== intent.credits ||
    (metadataPack !== null && metadataPack !== intent.packLookupKey) ||
    (metadataCredits !== null && metadataCredits !== String(intent.credits))
  ) {
    return deadLetter(deps, ctx, "pack_mismatch", {
      intentId: intent.id,
      boardId: intent.boardId,
      stripeObjectId: str(session.id) ?? undefined,
    });
  }

  // Amount cross-check before the closed-purchase check, so a
  // mismatched amount dead-letters as itself even on a dead intent.
  const amountTotal = int(session.amount_total);
  if (str(session.currency)?.toLowerCase() === "eur" && amountTotal !== null) {
    if (amountTotal !== pack.eurCents) {
      return deadLetter(deps, ctx, "amount_mismatch", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: str(session.id) ?? undefined,
      });
    }
  } else {
    const settled = await settledEurCentsForSession(deps, session);
    if (settled === null) {
      return deadLetter(deps, ctx, "amount_unverifiable", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: str(session.id) ?? undefined,
      });
    }
    if (settled !== pack.eurCents) {
      return deadLetter(deps, ctx, "amount_mismatch", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: str(session.id) ?? undefined,
      });
    }
  }

  // PIN-178: the intent TTL never refuses a paid session. Lazy
  // expiry (cap check) only freed the board's cap slot; the ledger
  // purchase stays pending until a terminal outcome closes it -
  // Stripe's `expired` / `async_payment_failed`, or a session that
  // was never created. Only then is the intent dead.
  if (purchase.state === "closed") {
    return deadLetter(deps, ctx, "dead_intent", {
      intentId: intent.id,
      boardId: intent.boardId,
      stripeObjectId: str(session.id) ?? undefined,
      chargeId: mapping.chargeId,
      paymentIntentId: mapping.paymentIntentId,
    });
  }

  if (!(await persistSessionMapping(deps, ctx, intent, mapping, ctx.at))) {
    return "dead_letter";
  }
  try {
    await deps.ledger.grantPurchase(intent.boardId, {
      eventId: ctx.event.id,
      purchaseId: intent.purchaseId,
      at: ctx.at,
    });
  } catch (error) {
    if (error instanceof RangeError) {
      return deadLetter(deps, ctx, "ledger_refused", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: str(session.id) ?? undefined,
      });
    }
    throw error;
  }
  await deps.intents.close(intent.id, ctx.at);
  return "granted";
}

/** `checkout.session.async_payment_failed` / `checkout.session.expired`: close the intent + purchase, never grant. */
async function closeSession(deps: StripeWebhookDeps, ctx: HandlerContext): Promise<string> {
  const session = ctx.event.object;
  const intentId = sessionIntentId(session);
  if (!intentId) {
    return deadLetter(deps, ctx, "unknown_intent", { stripeObjectId: str(session.id) ?? undefined });
  }
  const intent = await deps.intents.get(intentId);
  if (!intent) {
    return deadLetter(deps, ctx, "unknown_intent", {
      intentId,
      stripeObjectId: str(session.id) ?? undefined,
    });
  }
  const account = await deps.ledger.getAccount(intent.boardId);
  const purchase = account?.purchases[intent.purchaseId];
  if (!purchase) {
    return deadLetter(deps, ctx, "unknown_purchase", {
      intentId: intent.id,
      boardId: intent.boardId,
      stripeObjectId: str(session.id) ?? undefined,
    });
  }
  if (purchase.grantedCredits > 0) return "ignored_already_granted";

  await persistSessionMapping(deps, ctx, intent, sessionMapping(session));
  if (ctx.event.type === "checkout.session.expired") {
    await deps.intents.expire(intent.id, ctx.at);
    const after = await deps.intents.get(intent.id);
    if (after?.status === "pending") await deps.intents.close(intent.id, ctx.at);
  } else {
    await deps.intents.close(intent.id, ctx.at);
  }
  try {
    await deps.ledger.closePurchase(intent.boardId, { purchaseId: intent.purchaseId });
  } catch (error) {
    if (error instanceof RangeError) {
      // e.g. a partially pre-clawed purchase that must grant to
      // net out (PIN-147): a human settles it, Stripe still 200s.
      return deadLetter(deps, ctx, "ledger_refused", {
        intentId: intent.id,
        boardId: intent.boardId,
        stripeObjectId: str(session.id) ?? undefined,
      });
    }
    throw error;
  }
  return "closed";
}

interface ResolvedPurchase {
  intent: CheckoutIntent;
  account: BoardCreditAccount;
  purchase: CreditPurchase;
  pack: PackTerms;
}

/** Resolve a refund/dispute's charge/payment_intent to intent + purchase + pack, dead-lettering each miss. */
async function resolveStripePurchase(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  lookup: { chargeId?: string; paymentIntentId?: string },
  ids: DeadLetterExtra,
): Promise<ResolvedPurchase | string> {
  let intent = await deps.intents.findByStripeIds(lookup);
  if (!intent && lookup.paymentIntentId && deps.client) {
    // PIN-153 live race: a fast dispute/refund can be delivered
    // before (or concurrently with) fulfilment persisting the
    // session->intent mapping, so the local lookup misses even
    // though the purchase is ours. Stripe still knows: the
    // Checkout Session behind this PaymentIntent names the
    // intent. Resolve through it and backfill the mapping so
    // later events resolve locally. Pre-grant ledger semantics
    // (deferred freeze / pre-clawback, PIN-147) then apply.
    const found = obj(
      await deps.client.findCheckoutSessionByPaymentIntent(lookup.paymentIntentId),
    );
    const foundIntentId = found ? sessionIntentId(found) : null;
    if (found && foundIntentId) {
      intent = await deps.intents.get(foundIntentId);
      if (intent) {
        const mapping = sessionMapping(found);
        if (!mapping.chargeId && lookup.chargeId) mapping.chargeId = lookup.chargeId;
        if (!mapping.paymentIntentId) mapping.paymentIntentId = lookup.paymentIntentId;
        if (!(await persistSessionMapping(deps, ctx, intent, mapping))) {
          return "dead_letter";
        }
      }
    }
  }
  if (!intent) return deadLetter(deps, ctx, "unknown_mapping", ids);
  const account = await deps.ledger.getAccount(intent.boardId);
  const purchase = account?.purchases[intent.purchaseId];
  if (!account || !purchase) {
    return deadLetter(deps, ctx, "unknown_purchase", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  const pack = await packFor(deps, intent);
  if (!pack || pack.credits !== intent.credits) {
    return deadLetter(deps, ctx, "pack_mismatch", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  return { intent, account, purchase, pack };
}

/**
 * `refund.created` / `refund.updated` (and `refund.failed` as a
 * no-op): claw back only a `succeeded` refund, by its own
 * per-refund delta, through the cumulative formula. A pending
 * refund does nothing yet - its `refund.updated` settles it.
 */
async function handleRefund(deps: StripeWebhookDeps, ctx: HandlerContext): Promise<string> {
  const refund = ctx.event.object;
  const refundId = str(refund.id);
  const chargeId = idOf(refund.charge) ?? undefined;
  const paymentIntentId = idOf(refund.payment_intent) ?? undefined;
  const ids: DeadLetterExtra = {
    refundId: refundId ?? undefined,
    chargeId,
    paymentIntentId,
    stripeObjectId: refundId ?? undefined,
  };
  if (!refundId) return deadLetter(deps, ctx, "malformed_refund", ids);
  if (ctx.event.type === "refund.failed" || str(refund.status) !== "succeeded") {
    return "refund_ignored_status";
  }

  const resolved = await resolveStripePurchase(deps, ctx, { chargeId, paymentIntentId }, ids);
  if (typeof resolved === "string") return resolved;
  const { intent, pack } = resolved;

  const settledCents =
    str(refund.currency)?.toLowerCase() === "eur"
      ? int(refund.amount)
      : await balanceTransactionEurCents(deps, refund.balance_transaction);
  if (settledCents === null || settledCents < 0) {
    return deadLetter(deps, ctx, "fx_unverifiable", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }

  // Count + price the delta atomically against the stored
  // cumulative, never this handler's snapshot: two concurrent
  // refunds must not both price themselves as the first
  // increment. A repeat returns the original delta, and the
  // ledger clawback below dedupes by refund id, so a crash
  // between the count and the claw converges on retry.
  const counted = await deps.intents.countRefund(
    intent.id,
    refundId,
    settledCents,
    pack.eurCents,
    pack.credits,
  );
  if (!counted.intent) {
    return deadLetter(deps, ctx, "unknown_purchase", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  let delta = counted.deltaMakes;
  const freshAccount = await deps.ledger.getAccount(intent.boardId);
  const freshPurchase = freshAccount?.purchases[intent.purchaseId];
  if (freshPurchase) {
    const clawableLeft = freshPurchase.credits - freshPurchase.clawedCredits;
    if (delta > clawableLeft) delta = clawableLeft;
  }
  if (delta < 0) delta = 0;

  if (delta > 0) {
    try {
      await deps.ledger.clawback(intent.boardId, {
        eventId: ctx.event.id,
        purchaseId: intent.purchaseId,
        amount: delta,
        refundId,
        at: ctx.at,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return deadLetter(deps, ctx, "ledger_refused", {
          ...ids,
          intentId: intent.id,
          boardId: intent.boardId,
        });
      }
      throw error;
    }
  }
  if (!counted.applied) return "duplicate_refund";
  return delta > 0 ? "refund_clawed" : "refund_recorded_zero_makes";
}

/** Settled EUR cents for a dispute: its own EUR amount, else the first BalanceTransaction it carries that reads as EUR, else the disputed presentment amount converted at the charge's Stripe-reported exchange rate (a fresh dispute usually carries no balance transactions yet, and its credits must freeze now, not at funds_withdrawn). */
async function disputeSettledEurCents(
  deps: StripeWebhookDeps,
  dispute: Obj,
): Promise<number | null> {
  if (str(dispute.currency)?.toLowerCase() === "eur") return int(dispute.amount);
  const txns = Array.isArray(dispute.balance_transactions) ? dispute.balance_transactions : [];
  for (const txn of txns) {
    const cents = await balanceTransactionEurCents(deps, txn);
    if (cents !== null) return cents;
  }
  return eurCentsViaChargeExchangeRate(deps, idOf(dispute.charge), int(dispute.amount));
}

async function freezeDispute(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  resolved: ResolvedPurchase,
  disputeId: string,
  ids: DeadLetterExtra,
): Promise<string> {
  const { intent, account, purchase, pack } = resolved;
  // `created` and `funds_withdrawn` both land here (PIN-178): the
  // second one finds the hold (live or deferred) or the dispute
  // already resolved, and must not dead-letter for lack of
  // available makes the first freeze just took.
  if (
    account.frozenByDispute[disputeId] !== undefined ||
    purchase.deferredFreezes[disputeId] !== undefined ||
    purchase.resolvedDisputeIds.includes(disputeId)
  ) {
    return "duplicate_freeze";
  }
  const cents = await disputeSettledEurCents(deps, ctx.event.object);
  if (cents === null || cents < 0) {
    return deadLetter(deps, ctx, "fx_unverifiable", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  const wanted = makesFreezeForCents(cents, pack);
  // Granted: freeze only what the pool still holds (the caller
  // freezes what remains, PIN-147). Pre-grant: record the full
  // capped freeze as deferred; the grant caps it for real.
  const amount = purchase.grantedCredits > 0 ? Math.min(wanted, availableCredits(account)) : wanted;
  if (amount <= 0) {
    return deadLetter(deps, ctx, "freeze_no_available", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  try {
    const result = await deps.ledger.freeze(intent.boardId, {
      eventId: ctx.event.id,
      purchaseId: intent.purchaseId,
      disputeId,
      amount,
      at: ctx.at,
    });
    return result.applied ? "frozen" : "duplicate_freeze";
  } catch (error) {
    if (error instanceof RangeError) {
      return deadLetter(deps, ctx, "ledger_refused", {
        ...ids,
        intentId: intent.id,
        boardId: intent.boardId,
      });
    }
    throw error;
  }
}

async function restoreDispute(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  resolved: ResolvedPurchase,
  disputeId: string,
  ids: DeadLetterExtra,
): Promise<string> {
  const { intent } = resolved;
  if (intent.finalDisputeClawbacks && disputeId in intent.finalDisputeClawbacks) {
    // Funds came back after the makes were finally clawed:
    // the ledger cannot un-claw, so flag it for a human.
    return deadLetter(deps, ctx, "reinstated_after_final_clawback", {
      ...ids,
      intentId: intent.id,
      boardId: intent.boardId,
    });
  }
  try {
    const result = await deps.ledger.restore(intent.boardId, {
      eventId: ctx.event.id,
      purchaseId: intent.purchaseId,
      disputeId,
      at: ctx.at,
    });
    return result.applied ? "restored" : "duplicate_restore";
  } catch (error) {
    if (error instanceof RangeError) {
      return deadLetter(deps, ctx, "ledger_refused", {
        ...ids,
        intentId: intent.id,
        boardId: intent.boardId,
      });
    }
    throw error;
  }
}

/**
 * Release the freeze's ceil excess over the final floor
 * amount, whichever terminal dispute event is current and
 * whichever landed first. Re-reads the account, so it is a
 * no-op once the hold is gone. Returns a dead-letter outcome
 * on a ledger refusal, else whether anything was restored.
 */
async function restoreFreezeExcess(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  intent: CheckoutIntent,
  disputeId: string,
  ids: DeadLetterExtra,
): Promise<{ restored: boolean } | string> {
  const account = await deps.ledger.getAccount(intent.boardId);
  const purchase = account?.purchases[intent.purchaseId];
  if (!account || !purchase) return { restored: false };
  const leftover =
    (account.frozenByDispute[disputeId] ?? 0) + (purchase.deferredFreezes[disputeId] ?? 0);
  if (leftover <= 0) return { restored: false };
  try {
    const result = await deps.ledger.restore(intent.boardId, {
      eventId: `${ctx.event.id}:excess-restore`,
      purchaseId: intent.purchaseId,
      disputeId,
      at: ctx.at,
    });
    return { restored: result.applied };
  } catch (error) {
    if (error instanceof RangeError) {
      return deadLetter(deps, ctx, "ledger_refused", {
        ...ids,
        intentId: intent.id,
        boardId: intent.boardId,
      });
    }
    throw error;
  }
}

async function finalClawbackDispute(
  deps: StripeWebhookDeps,
  ctx: HandlerContext,
  resolved: ResolvedPurchase,
  disputeId: string,
  ids: DeadLetterExtra,
): Promise<string> {
  const { intent, pack } = resolved;
  // Claim the final clawback atomically BEFORE touching the
  // ledger: only `closed lost` makes a new claim (PIN-178), and
  // whichever delivery records it owns the one claw; a
  // concurrent loser does not claw at all. A handler that finds
  // a pre-existing claim (a re-delivered `lost`, or a
  // `funds_withdrawn` landing after it) still ensures the ledger
  // claw landed (a crash between claim and claw retries into the
  // entry check below), then releases the freeze's ceil excess.
  const preExistingMakes = intent.finalDisputeClawbacks?.[disputeId];
  let makes: number;
  let claimedNow = false;
  if (preExistingMakes !== undefined) {
    makes = preExistingMakes;
  } else {
    const cents = await disputeSettledEurCents(deps, ctx.event.object);
    if (cents === null || cents < 0) {
      return deadLetter(deps, ctx, "fx_unverifiable", {
        ...ids,
        intentId: intent.id,
        boardId: intent.boardId,
      });
    }
    makes = makesFloorForCents(cents, pack);
    const claim = await deps.intents.recordFinalDisputeClawback(intent.id, disputeId, makes);
    if (!claim.applied) return "duplicate_final_clawback";
    claimedNow = true;
  }

  if (makes > 0) {
    const fresh = await deps.ledger.getAccount(intent.boardId);
    const freshPurchase = fresh?.purchases[intent.purchaseId];
    if (!fresh || !freshPurchase) {
      return deadLetter(deps, ctx, "unknown_purchase", {
        ...ids,
        intentId: intent.id,
        boardId: intent.boardId,
      });
    }
    const alreadyClawed = fresh.entries.some(
      (entry) => entry.type === "clawback" && entry.disputeId === disputeId,
    );
    if (!alreadyClawed) {
      const amount = Math.min(makes, freshPurchase.credits - freshPurchase.clawedCredits);
      if (amount > 0) {
        try {
          await deps.ledger.clawback(intent.boardId, {
            eventId: ctx.event.id,
            purchaseId: intent.purchaseId,
            amount,
            disputeId,
            at: ctx.at,
          });
        } catch (error) {
          if (error instanceof RangeError) {
            return deadLetter(deps, ctx, "ledger_refused", {
              ...ids,
              intentId: intent.id,
              boardId: intent.boardId,
            });
          }
          throw error;
        }
      }
    }
  }

  const excess = await restoreFreezeExcess(deps, ctx, intent, disputeId, ids);
  if (typeof excess === "string") return excess;
  if (claimedNow) return "dispute_final_clawed";
  return excess.restored ? "final_clawback_duplicate_excess_restored" : "duplicate_final_clawback";
}

/** All four `charge.dispute.*` events through one resolution path. */
async function handleDispute(deps: StripeWebhookDeps, ctx: HandlerContext): Promise<string> {
  const dispute = ctx.event.object;
  const disputeId = str(dispute.id);
  const chargeId = idOf(dispute.charge) ?? undefined;
  const paymentIntentId = idOf(dispute.payment_intent) ?? undefined;
  const ids: DeadLetterExtra = {
    disputeId: disputeId ?? undefined,
    chargeId,
    paymentIntentId,
    stripeObjectId: disputeId ?? undefined,
  };
  if (!disputeId) return deadLetter(deps, ctx, "malformed_dispute", ids);

  const resolved = await resolveStripePurchase(deps, ctx, { chargeId, paymentIntentId }, ids);
  if (typeof resolved === "string") return resolved;

  switch (ctx.event.type) {
    case "charge.dispute.created":
      return freezeDispute(deps, ctx, resolved, disputeId, ids);
    case "charge.dispute.funds_reinstated":
      return restoreDispute(deps, ctx, resolved, disputeId, ids);
    case "charge.dispute.funds_withdrawn":
      // Freeze only (PIN-178): card disputes withdraw within a
      // second of `created`, long before the outcome is known.
      // After a `lost` claim it just completes that one claw.
      if (resolved.intent.finalDisputeClawbacks?.[disputeId] !== undefined) {
        return finalClawbackDispute(deps, ctx, resolved, disputeId, ids);
      }
      return freezeDispute(deps, ctx, resolved, disputeId, ids);
    case "charge.dispute.closed": {
      const status = str(dispute.status);
      if (status === "won" || status === "warning_closed") {
        return restoreDispute(deps, ctx, resolved, disputeId, ids);
      }
      if (status === "lost") {
        return finalClawbackDispute(deps, ctx, resolved, disputeId, ids);
      }
      return "dispute_closed_ignored_status";
    }
    default:
      return "unhandled";
  }
}

/**
 * Handle one webhook delivery: fail closed on config, verify
 * the signature over the raw body, short-circuit a replayed
 * event id, dispatch, and only then write the processed
 * record - so any unexpected failure above it (store, API)
 * propagates, the route answers non-2xx, and Stripe retries
 * into the ledger's own idempotency. A delivery that wrote a
 * dead letter still answers 200 but gets no processed record,
 * so a Dashboard Resend re-runs the handler (PIN-178).
 */
export async function handleStripeWebhook(
  rawBody: string,
  signature: string | null,
  deps: StripeWebhookDeps,
): Promise<StripeWebhookResult> {
  if (deps.plusMode !== "stripe" || !deps.webhookSecret || !deps.client) {
    throw new StripeWebhookConfigError();
  }
  if (!signature) {
    throw new StripeWebhookSignatureError("Missing Stripe-Signature header.");
  }
  let rawEvent: unknown;
  try {
    rawEvent = deps.client.constructEvent(rawBody, signature, deps.webhookSecret);
  } catch {
    // The SDK error echoes payload fragments; never surface it.
    throw new StripeWebhookSignatureError();
  }
  const event = parseEvent(rawEvent);
  if (!event) throw new StripeWebhookSignatureError("Malformed Stripe event.");

  const processed = await deps.records.getProcessed(event.id);
  if (processed) return { eventId: event.id, outcome: "duplicate", duplicate: true };

  const now = deps.now?.() ?? Date.now();
  const ctx: HandlerContext = { event, at: event.createdAt ?? now, deadLettered: false };
  const outcome = await dispatch(deps, ctx);
  if (!ctx.deadLettered) {
    await deps.records.markProcessed({
      eventId: event.id,
      eventType: event.type,
      outcome,
      processedAt: deps.now?.() ?? Date.now(),
    });
  }
  return { eventId: event.id, outcome, duplicate: false };
}

async function dispatch(deps: StripeWebhookDeps, ctx: HandlerContext): Promise<string> {
  switch (ctx.event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      return fulfilSession(deps, ctx);
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      return closeSession(deps, ctx);
    case "refund.created":
    case "refund.updated":
    case "refund.failed":
      return handleRefund(deps, ctx);
    case "charge.dispute.created":
    case "charge.dispute.funds_withdrawn":
    case "charge.dispute.funds_reinstated":
    case "charge.dispute.closed":
      return handleDispute(deps, ctx);
    default:
      return "unhandled";
  }
}
