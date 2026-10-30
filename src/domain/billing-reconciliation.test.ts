import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBillingReconciliationReport,
  type BillingReconciliationInput,
} from "./billing-reconciliation";

/**
 * PIN-153: the pure reconciliation report behind
 * `npm run billing:reconcile`, fed fakes only - no Stripe, no
 * Firestore, no network. All ids are obviously fake.
 */
const boardHash = (boardId: string): string => `board:HASHED(${boardId})`;
const NOW = 1_800_000_000_000;

function input(overrides: Partial<BillingReconciliationInput> = {}): BillingReconciliationInput {
  return {
    paidSessions: [],
    purchases: [],
    intents: [],
    deadLetters: [],
    now: NOW,
    ...overrides,
  };
}

describe("buildBillingReconciliationReport (PIN-153)", () => {
  it("a fully matched payment + grant is clean", () => {
    const report = buildBillingReconciliationReport(
      input({
        paidSessions: [
          { sessionId: "cs_1", paymentIntentId: "pi_1", intentId: "intent_1" },
        ],
        purchases: [{ boardId: "slug_a", purchaseId: "intent_1", granted: true }],
        intents: [
          {
            intentId: "intent_1",
            boardId: "slug_a",
            status: "closed",
            expiresAt: NOW - 1,
            stripeSessionId: "cs_1",
            stripePaymentIntentId: "pi_1",
          },
        ],
      }),
      boardHash,
    );
    expect(report.clean).toBe(true);
    expect(report.anomalyCount).toBe(0);
    expect(report.paidNoGrant).toEqual([]);
    expect(report.grantNoPayment).toEqual([]);
    expect(report.pendingPastTtl).toEqual([]);
  });

  it("a paid session with no ledger grant is paid-no-grant, board hashed", () => {
    const report = buildBillingReconciliationReport(
      input({
        paidSessions: [
          { sessionId: "cs_2", paymentIntentId: "pi_2", intentId: "intent_2" },
        ],
        purchases: [{ boardId: "slug_b", purchaseId: "intent_2", granted: false }],
        intents: [
          {
            intentId: "intent_2",
            boardId: "slug_b",
            status: "closed",
            expiresAt: NOW - 1,
          },
        ],
      }),
      boardHash,
    );
    expect(report.paidNoGrant).toEqual([
      {
        sessionId: "cs_2",
        paymentIntentId: "pi_2",
        intentId: "intent_2",
        board: "board:HASHED(slug_b)",
      },
    ]);
    expect(report.grantNoPayment).toEqual([]);
    expect(report.clean).toBe(false);
    expect(JSON.stringify(report)).not.toContain('"slug_b"');
  });

  it("a paid session naming no intent is paid-no-grant on an unknown board", () => {
    const report = buildBillingReconciliationReport(
      input({ paidSessions: [{ sessionId: "cs_orphan" }] }),
      boardHash,
    );
    expect(report.paidNoGrant).toEqual([{ sessionId: "cs_orphan", board: "unknown" }]);
  });

  it("a grant with no paid Stripe session is grant-no-payment", () => {
    const report = buildBillingReconciliationReport(
      input({
        purchases: [{ boardId: "slug_c", purchaseId: "intent_3", granted: true }],
        intents: [
          {
            intentId: "intent_3",
            boardId: "slug_c",
            status: "closed",
            expiresAt: NOW - 1,
          },
        ],
      }),
      boardHash,
    );
    expect(report.grantNoPayment).toEqual([
      { board: "board:HASHED(slug_c)", purchaseId: "intent_3" },
    ]);
  });

  it("a grant matches a payment through the intent's mapped Stripe ids alone", () => {
    const report = buildBillingReconciliationReport(
      input({
        paidSessions: [{ sessionId: "cs_4", paymentIntentId: "pi_4" }],
        purchases: [{ boardId: "slug_d", purchaseId: "intent_4", granted: true }],
        intents: [
          {
            intentId: "intent_4",
            boardId: "slug_d",
            status: "closed",
            expiresAt: NOW - 1,
            stripePaymentIntentId: "pi_4",
          },
        ],
      }),
      boardHash,
    );
    expect(report.grantNoPayment).toEqual([]);
  });

  it("dead letters group by reason and every one is an anomaly", () => {
    const report = buildBillingReconciliationReport(
      input({
        deadLetters: [
          { reason: "fx_unverifiable" },
          { reason: "reinstated_after_final_clawback" },
          { reason: "fx_unverifiable" },
          { reason: "unknown_intent" },
        ],
      }),
      boardHash,
    );
    expect(report.deadLettersByReason).toEqual([
      { reason: "fx_unverifiable", count: 2 },
      { reason: "reinstated_after_final_clawback", count: 1 },
      { reason: "unknown_intent", count: 1 },
    ]);
    expect(report.deadLetterTotal).toBe(4);
    expect(report.anomalyCount).toBe(4);
    expect(report.clean).toBe(false);
  });

  it("pending intents past their TTL are flagged; live and closed ones are not", () => {
    const report = buildBillingReconciliationReport(
      input({
        intents: [
          { intentId: "stale", boardId: "slug_e", status: "pending", expiresAt: NOW },
          { intentId: "live", boardId: "slug_e", status: "pending", expiresAt: NOW + 1 },
          { intentId: "done", boardId: "slug_e", status: "closed", expiresAt: NOW - 5 },
          { intentId: "gone", boardId: "slug_e", status: "expired", expiresAt: NOW - 5 },
        ],
      }),
      boardHash,
    );
    expect(report.pendingPastTtl).toEqual([
      { board: "board:HASHED(slug_e)", intentId: "stale", expiresAt: NOW },
    ]);
  });

  it("duplicate session rows count once", () => {
    const report = buildBillingReconciliationReport(
      input({
        paidSessions: [
          { sessionId: "cs_dup", intentId: "intent_dup" },
          { sessionId: "cs_dup", intentId: "intent_dup" },
        ],
      }),
      boardHash,
    );
    expect(report.paidNoGrant).toHaveLength(1);
    expect(report.anomalyCount).toBe(1);
  });

  it("the operator script carries the same report builder (mirror)", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/billing-reconciliation.mjs"),
      "utf8",
    );
    expect(script).toContain("buildBillingReconciliationReport");
    expect(script).toContain("board:");
    expect(script).toContain("checkoutIntents");
    expect(script).toContain("billingDeadLetters");
    expect(script).toContain("creditAccounts");
  });
});
