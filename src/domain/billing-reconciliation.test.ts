import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  billingReconciliationExitCode,
  buildBillingReconciliationReport,
  summarizeBillingReconciliation,
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

  it("PIN-243 summary: paid-no-grant or any dead letter needs attention and exits 1", () => {
    const clean = buildBillingReconciliationReport(input(), boardHash);
    expect(summarizeBillingReconciliation(clean)).toMatchObject({
      paidNoGrantCount: 0,
      deadLetterTotal: 0,
      needsAttention: false,
      clean: true,
    });
    expect(billingReconciliationExitCode(clean)).toBe(0);

    const paidNoGrant = buildBillingReconciliationReport(
      input({ paidSessions: [{ sessionId: "cs_x" }] }),
      boardHash,
    );
    expect(summarizeBillingReconciliation(paidNoGrant).needsAttention).toBe(true);
    expect(billingReconciliationExitCode(paidNoGrant)).toBe(1);

    const deadLetters = buildBillingReconciliationReport(
      input({ deadLetters: [{ reason: "unknown_intent" }] }),
      boardHash,
    );
    expect(summarizeBillingReconciliation(deadLetters).needsAttention).toBe(true);
    expect(billingReconciliationExitCode(deadLetters)).toBe(1);

    // Refunds/disputes visibility rides along but never flips clean/needsAttention.
    const withVisibility = summarizeBillingReconciliation(clean, {
      refundsLast30Days: 2,
      disputesLast30Days: 1,
      openDisputes: 1,
    });
    expect(withVisibility).toMatchObject({
      refundsLast30Days: 2,
      disputesLast30Days: 1,
      openDisputes: 1,
      needsAttention: false,
      clean: true,
    });
  });

  it("PIN-243 summary carries counts and booleans only - no id, hash or timestamp", () => {
    // Every row kind populated with distinctive ids, so a leak would show.
    const report = buildBillingReconciliationReport(
      input({
        paidSessions: [
          { sessionId: "cs_LEAK_1", paymentIntentId: "pi_LEAK_1", intentId: "ci_LEAK_1" },
        ],
        purchases: [{ boardId: "slug_LEAK_2", purchaseId: "ci_LEAK_2", granted: true }],
        intents: [
          { intentId: "ci_LEAK_1", boardId: "slug_LEAK_1", status: "pending", expiresAt: NOW - 777 },
        ],
        deadLetters: [{ reason: "reason_LEAK", boardId: "slug_LEAK_3" }],
      }),
      boardHash,
    );
    expect(report.anomalyCount).toBe(4);
    const summary = summarizeBillingReconciliation(report, {
      refundsLast30Days: 1,
      disputesLast30Days: 0,
      openDisputes: 0,
    });
    expect(Object.keys(summary).sort()).toEqual(
      [
        "anomalyCount",
        "clean",
        "deadLetterTotal",
        "disputesLast30Days",
        "grantNoPaymentCount",
        "needsAttention",
        "openDisputes",
        "paidNoGrantCount",
        "pendingPastTtlCount",
        "refundsLast30Days",
      ].sort(),
    );
    for (const value of Object.values(summary)) {
      expect(["number", "boolean"]).toContain(typeof value);
    }
    const printed = JSON.stringify(summary);
    for (const leak of ["LEAK", "cs_", "pi_", "ci_", "slug", "board:", String(NOW - 777)]) {
      expect(printed).not.toContain(leak);
    }
  });

  it("PIN-243 scheduled workflow: environments, keyless WIF, summary-only output", () => {
    const workflow = readFileSync(
      path.resolve(__dirname, "../../.github/workflows/billing-reconciliation.yml"),
      "utf8",
    ).replace(/\r\n/g, "\n");
    expect(workflow).toContain("cron:");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("enabled=false");
    // Environment-scoped inputs: one secret, two variables, no key JSON.
    expect(workflow).toContain("secrets.PINNED_RECONCILE_STRIPE_READ_KEY");
    expect(workflow).toContain("vars.PINNED_RECONCILE_WIF_PROVIDER");
    expect(workflow).toContain("vars.PINNED_RECONCILE_SERVICE_ACCOUNT");
    expect(workflow).not.toContain("GCP_CREDENTIALS");
    expect(workflow).not.toContain("credentials_json");
    expect(workflow).toContain("workload_identity_provider: ${{ vars.PINNED_RECONCILE_WIF_PROVIDER }}");
    expect(workflow).toContain("service_account: ${{ vars.PINNED_RECONCILE_SERVICE_ACCOUNT }}");
    expect(workflow).toMatch(/permissions:\n\s+contents: read\n\s+id-token: write/);
    // Only "prod" selects reconcile-prod; anything else is reconcile-dev.
    expect(workflow).toContain(
      "environment: ${{ (inputs.environment || vars.PINNED_RECONCILE_ENV) == 'prod' && 'reconcile-prod' || 'reconcile-dev' }}",
    );
    expect(workflow).toContain('assertion.repository == "MoriaCrew/Pinned"');
    expect(workflow).toContain('assertion.ref == "refs/heads/main"');
    expect(workflow).toContain("roles/datastore.viewer");
    // Every script run is --summary-only (public log), never --json.
    const runs = workflow.split("\n").filter((l) => l.trim().startsWith("node scripts/billing-reconciliation.mjs"));
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toContain("--summary-only");
      expect(run).not.toContain("--json");
    }
    // Dependencies install without lifecycle scripts, before any credential exists.
    const install = workflow.indexOf("npm ci --ignore-scripts");
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(workflow.indexOf("uses: google-github-actions/auth@"));
    // Every action is pinned to a full commit SHA with its version noted.
    const uses = workflow.split("\n").filter((l) => /^\s*(- )?uses:/.test(l));
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const line of uses) {
      expect(line).toMatch(/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
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
    // PIN-243 mirror: machine-readable summary + automation exit + visibility.
    expect(script).toContain("summarizeBillingReconciliation");
    expect(script).toContain("billingReconciliationExitCode");
    expect(script).toContain("RECONCILIATION_JSON:");
    expect(script).toContain("--json");
    expect(script).toContain("--summary-only");
    // The summary-only payload is exactly {stripe, project, summary}.
    expect(script).toContain("JSON.stringify({ stripe: gate.mode, project: projectId, summary })");
    // The script's summary mirror emits the same keys as the domain one.
    for (const key of [
      "paidNoGrantCount",
      "grantNoPaymentCount",
      "deadLetterTotal",
      "pendingPastTtlCount",
      "anomalyCount",
      "needsAttention",
      "refundsLast30Days",
      "disputesLast30Days",
      "openDisputes",
    ]) {
      expect(script).toContain(`${key}:`);
    }
    expect(script).toContain("listRefundDisputeVisibility");
    expect(script).toContain("/refunds");
    expect(script).toContain("/disputes");
  });
});
