/**
 * Billing reconciliation report (PIN-153). Pure: joins three
 * read-only fact sets the operator script
 * (`npm run billing:reconcile`) collects - paid Stripe Checkout
 * Sessions, ledger purchases + checkout intents from Firestore,
 * and the PIN-150 dead letters - and reports the anomalies a
 * human must act on. Board ids are slugs (capability secrets)
 * and are NEVER returned raw: callers inject `boardHash`, the
 * usage-costs pattern, so this module stays crypto-free.
 *
 * Identity chain (PIN-148/149/150): one purchase per intent and
 * `purchaseId === intentId`; the Stripe session names the intent
 * by `metadata.checkout_intent_id` / `client_reference_id`, and
 * the intent persists its Stripe session/payment-intent ids at
 * grant time, so a grant can match a payment by intent id OR by
 * either mapped Stripe id.
 */

/** One Checkout Session Stripe reports as paid (payment_status "paid"). */
export interface PaidStripeSessionFact {
  sessionId: string;
  paymentIntentId?: string;
  /** metadata.checkout_intent_id / client_reference_id, when present. */
  intentId?: string;
}

/** One ledger purchase, flattened across boards. `granted` = the grant landed (grantedCredits > 0). */
export interface LedgerPurchaseFact {
  boardId: string;
  purchaseId: string;
  granted: boolean;
}

/** One checkout intent (only the fields reconciliation reads). */
export interface CheckoutIntentFact {
  intentId: string;
  boardId: string;
  status: string;
  expiresAt: number;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
}

/** One PIN-150 dead letter (only the fields reconciliation reads). */
export interface DeadLetterFact {
  reason: string;
  boardId?: string;
}

export interface PaidNoGrantRow {
  sessionId: string;
  paymentIntentId?: string;
  intentId?: string;
  /** Hashed board id; "unknown" when no intent names the board. */
  board: string;
}

export interface GrantNoPaymentRow {
  /** Hashed board id (never the raw slug). */
  board: string;
  purchaseId: string;
}

export interface PendingPastTtlRow {
  /** Hashed board id (never the raw slug). */
  board: string;
  intentId: string;
  expiresAt: number;
}

export interface DeadLettersByReasonRow {
  reason: string;
  count: number;
}

export interface BillingReconciliationReport {
  paidNoGrant: PaidNoGrantRow[];
  grantNoPayment: GrantNoPaymentRow[];
  deadLettersByReason: DeadLettersByReasonRow[];
  deadLetterTotal: number;
  pendingPastTtl: PendingPastTtlRow[];
  /** Every anomaly a human must look at: the rows above + each dead letter. */
  anomalyCount: number;
  clean: boolean;
}

/** Recent refunds/disputes visibility (PIN-243). Informational only: a refund is not an anomaly. */
export interface RefundDisputeVisibility {
  refundsLast30Days: number;
  disputesLast30Days: number;
  openDisputes: number;
}

/**
 * Machine-readable reconciliation summary (PIN-243), the shape the
 * operator script prints as its `RECONCILIATION_JSON:` line / `--json`
 * payload and the scheduled workflow keys its alert on.
 * `needsAttention` is the alert condition: paid money with no grant
 * (`paidNoGrantCount > 0`) or any dead letter (`deadLetterTotal > 0`).
 */
export interface ReconciliationSummary {
  paidNoGrantCount: number;
  grantNoPaymentCount: number;
  deadLetterTotal: number;
  pendingPastTtlCount: number;
  anomalyCount: number;
  needsAttention: boolean;
  clean: boolean;
  refundsLast30Days?: number;
  disputesLast30Days?: number;
  openDisputes?: number;
}

export function summarizeBillingReconciliation(
  report: BillingReconciliationReport,
  visibility?: RefundDisputeVisibility,
): ReconciliationSummary {
  return {
    paidNoGrantCount: report.paidNoGrant.length,
    grantNoPaymentCount: report.grantNoPayment.length,
    deadLetterTotal: report.deadLetterTotal,
    pendingPastTtlCount: report.pendingPastTtl.length,
    anomalyCount: report.anomalyCount,
    needsAttention: report.paidNoGrant.length > 0 || report.deadLetterTotal > 0,
    clean: report.clean,
    ...(visibility
      ? {
          refundsLast30Days: visibility.refundsLast30Days,
          disputesLast30Days: visibility.disputesLast30Days,
          openDisputes: visibility.openDisputes,
        }
      : {}),
  };
}

/**
 * Automation exit code (PIN-243): 1 whenever the report is not clean.
 * That is a superset of the alert condition — paid-no-grant and
 * `deadLetterTotal > 0` always exit non-zero, as do grant-no-payment
 * and pending-past-TTL (the pre-PIN-243 operator contract).
 */
export function billingReconciliationExitCode(report: BillingReconciliationReport): 0 | 1 {
  return report.clean ? 0 : 1;
}

export interface BillingReconciliationInput {
  paidSessions: readonly PaidStripeSessionFact[];
  purchases: readonly LedgerPurchaseFact[];
  intents: readonly CheckoutIntentFact[];
  deadLetters: readonly DeadLetterFact[];
  now: number;
}

export function buildBillingReconciliationReport(
  input: BillingReconciliationInput,
  boardHash: (boardId: string) => string,
): BillingReconciliationReport {
  const intentsById = new Map<string, CheckoutIntentFact>();
  for (const intent of input.intents) intentsById.set(intent.intentId, intent);

  const grantedPurchaseIds = new Set<string>();
  for (const purchase of input.purchases) {
    if (purchase.granted) grantedPurchaseIds.add(purchase.purchaseId);
  }

  // Dedupe sessions by id (a paginated listing must never double-count).
  const sessionsById = new Map<string, PaidStripeSessionFact>();
  for (const session of input.paidSessions) {
    if (!sessionsById.has(session.sessionId)) sessionsById.set(session.sessionId, session);
  }
  const paidSessions = [...sessionsById.values()];
  const paidIntentIds = new Set<string>();
  const paidSessionIds = new Set<string>();
  const paidPaymentIntentIds = new Set<string>();
  for (const session of paidSessions) {
    paidSessionIds.add(session.sessionId);
    if (session.intentId) paidIntentIds.add(session.intentId);
    if (session.paymentIntentId) paidPaymentIntentIds.add(session.paymentIntentId);
  }

  const paidNoGrant: PaidNoGrantRow[] = paidSessions
    .filter((session) => !session.intentId || !grantedPurchaseIds.has(session.intentId))
    .map((session) => {
      const intent = session.intentId ? intentsById.get(session.intentId) : undefined;
      return {
        sessionId: session.sessionId,
        ...(session.paymentIntentId ? { paymentIntentId: session.paymentIntentId } : {}),
        ...(session.intentId ? { intentId: session.intentId } : {}),
        board: intent ? boardHash(intent.boardId) : "unknown",
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));

  const grantNoPayment: GrantNoPaymentRow[] = input.purchases
    .filter((purchase) => {
      if (!purchase.granted) return false;
      if (paidIntentIds.has(purchase.purchaseId)) return false;
      const intent = intentsById.get(purchase.purchaseId);
      if (intent?.stripeSessionId && paidSessionIds.has(intent.stripeSessionId)) return false;
      if (
        intent?.stripePaymentIntentId &&
        paidPaymentIntentIds.has(intent.stripePaymentIntentId)
      ) {
        return false;
      }
      return true;
    })
    .map((purchase) => ({
      board: boardHash(purchase.boardId),
      purchaseId: purchase.purchaseId,
    }))
    .sort(
      (a, b) => a.board.localeCompare(b.board) || a.purchaseId.localeCompare(b.purchaseId),
    );

  const byReason = new Map<string, number>();
  for (const deadLetter of input.deadLetters) {
    const reason = deadLetter.reason || "unspecified";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const deadLettersByReason: DeadLettersByReasonRow[] = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));

  const pendingPastTtl: PendingPastTtlRow[] = input.intents
    .filter((intent) => intent.status === "pending" && intent.expiresAt <= input.now)
    .map((intent) => ({
      board: boardHash(intent.boardId),
      intentId: intent.intentId,
      expiresAt: intent.expiresAt,
    }))
    .sort((a, b) => a.expiresAt - b.expiresAt || a.intentId.localeCompare(b.intentId));

  const anomalyCount =
    paidNoGrant.length +
    grantNoPayment.length +
    input.deadLetters.length +
    pendingPastTtl.length;

  return {
    paidNoGrant,
    grantNoPayment,
    deadLettersByReason,
    deadLetterTotal: input.deadLetters.length,
    pendingPastTtl,
    anomalyCount,
    clean: anomalyCount === 0,
  };
}
