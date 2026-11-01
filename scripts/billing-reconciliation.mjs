#!/usr/bin/env node
/**
 * PIN-153 billing reconciliation (operator-run, read-only; never
 * CI). Joins paid Stripe Checkout Sessions (read-only listing
 * with the runtime key) against Firestore ledger purchases,
 * checkout intents and PIN-150 dead letters, and reports:
 * paid-no-grant, grant-no-payment, dead-letters by reason, and
 * pending intents past their TTL. Exit 1 when any anomaly
 * exists, 0 when clean, 2 on usage/config errors. Board slugs
 * are capability secrets: output shows a short sha256 hash,
 * never the raw slug.
 *
 *   node --env-file=.env.local scripts/billing-reconciliation.mjs \
 *     --env-var STRIPE_PINNED_DEV_AGENT_KEY --project moriacrew-pinned-dev
 *
 * The secret is read from the env var NAMED by --env-var
 * (default STRIPE_SECRET_KEY) and is never printed. A live key
 * needs --live --i-understand-live and --project
 * moriacrew-pinned-prod (PIN-210, scripts/stripe/operator-mode.mjs);
 * a sandbox run reads moriacrew-pinned-dev unless --project names
 * another non-prod project, and never prod (PIN-233). The project is
 * never left to ADC's or gcloud's default; Firestore auth is
 * Application Default Credentials. Mirrors buildBillingReconciliationReport in
 * src/domain/billing-reconciliation.ts — keep in sync (a test
 * pins the mirror). Runbook: docs/15 (PIN-153 section).
 */
import { createHash } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";
import {
  LIVE_CONFIRM_FLAG,
  LIVE_FLAG,
  reconciliationProject,
  resolveStripeMode,
} from "./stripe/operator-mode.mjs";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function boardHash(boardId) {
  return `board:${createHash("sha256").update(boardId).digest("hex").slice(0, 12)}`;
}

// Mirror of buildBillingReconciliationReport in
// src/domain/billing-reconciliation.ts — keep in sync.
function buildBillingReconciliationReport(input, hash) {
  const intentsById = new Map();
  for (const intent of input.intents) intentsById.set(intent.intentId, intent);
  const grantedPurchaseIds = new Set();
  for (const purchase of input.purchases) {
    if (purchase.granted) grantedPurchaseIds.add(purchase.purchaseId);
  }
  const sessionsById = new Map();
  for (const session of input.paidSessions) {
    if (!sessionsById.has(session.sessionId)) sessionsById.set(session.sessionId, session);
  }
  const paidSessions = [...sessionsById.values()];
  const paidIntentIds = new Set();
  const paidSessionIds = new Set();
  const paidPaymentIntentIds = new Set();
  for (const session of paidSessions) {
    paidSessionIds.add(session.sessionId);
    if (session.intentId) paidIntentIds.add(session.intentId);
    if (session.paymentIntentId) paidPaymentIntentIds.add(session.paymentIntentId);
  }
  const paidNoGrant = paidSessions
    .filter((s) => !s.intentId || !grantedPurchaseIds.has(s.intentId))
    .map((s) => {
      const intent = s.intentId ? intentsById.get(s.intentId) : undefined;
      return {
        sessionId: s.sessionId,
        ...(s.paymentIntentId ? { paymentIntentId: s.paymentIntentId } : {}),
        ...(s.intentId ? { intentId: s.intentId } : {}),
        board: intent ? hash(intent.boardId) : "unknown",
      };
    })
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const grantNoPayment = input.purchases
    .filter((p) => {
      if (!p.granted) return false;
      if (paidIntentIds.has(p.purchaseId)) return false;
      const intent = intentsById.get(p.purchaseId);
      if (intent?.stripeSessionId && paidSessionIds.has(intent.stripeSessionId)) return false;
      if (intent?.stripePaymentIntentId && paidPaymentIntentIds.has(intent.stripePaymentIntentId)) return false;
      return true;
    })
    .map((p) => ({ board: hash(p.boardId), purchaseId: p.purchaseId }))
    .sort((a, b) => a.board.localeCompare(b.board) || a.purchaseId.localeCompare(b.purchaseId));
  const byReason = new Map();
  for (const deadLetter of input.deadLetters) {
    const reason = deadLetter.reason || "unspecified";
    byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
  }
  const deadLettersByReason = [...byReason.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  const pendingPastTtl = input.intents
    .filter((i) => i.status === "pending" && i.expiresAt <= input.now)
    .map((i) => ({ board: hash(i.boardId), intentId: i.intentId, expiresAt: i.expiresAt }))
    .sort((a, b) => a.expiresAt - b.expiresAt || a.intentId.localeCompare(b.intentId));
  const anomalyCount =
    paidNoGrant.length + grantNoPayment.length + input.deadLetters.length + pendingPastTtl.length;
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

// --- Stripe read-only listing over plain fetch (seed-script pattern). ---
const API_BASE = "https://api.stripe.com/v1";
let apiKey = "";

async function stripeGet(path, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}?${query}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new Error(
      `Stripe GET ${path} failed: HTTP ${res.status} ${err.code ?? ""} ${err.message ?? ""}`.trim(),
    );
  }
  return json;
}

async function listPaidSessions() {
  const paid = [];
  let startingAfter;
  for (let page = 0; page < 50; page += 1) {
    const result = await stripeGet("/checkout/sessions", {
      limit: "100",
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const session of result.data ?? []) {
      if (session.payment_status !== "paid") continue;
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      const intentId =
        session.metadata?.checkout_intent_id ?? session.client_reference_id ?? undefined;
      paid.push({
        sessionId: session.id,
        ...(paymentIntentId ? { paymentIntentId } : {}),
        ...(intentId ? { intentId } : {}),
      });
    }
    if (!result.has_more || !result.data?.length) return paid;
    startingAfter = result.data[result.data.length - 1].id;
  }
  throw new Error("Checkout session listing exceeded the 50-page safety cap.");
}

async function main() {
  const envName = arg("--env-var") ?? "STRIPE_SECRET_KEY";
  if (!envName || envName.startsWith("--")) {
    console.error("usage: billing-reconciliation.mjs --env-var <ENV_VAR_NAME> [--project <id>]");
    process.exit(2);
  }
  apiKey = process.env[envName] ?? "";
  if (!apiKey) {
    console.error(`Env var ${envName} is not set; refusing to run.`);
    process.exit(2);
  }
  const gate = resolveStripeMode({
    key: apiKey,
    envName,
    live: args.includes(LIVE_FLAG),
    confirmed: args.includes(LIVE_CONFIRM_FLAG),
  });
  if (!gate.ok) {
    console.error(gate.error);
    process.exit(2);
  }
  // Never ADC's, gcloud's or the env's default project (PIN-233): live
  // names prod explicitly, sandbox defaults to dev and never reads prod.
  const target = reconciliationProject(gate.mode, arg("--project"));
  if (!target.ok) {
    console.error(target.error);
    process.exit(2);
  }
  const projectId = target.project;
  const db = new Firestore({ projectId });
  try {
    const [paidSessions, intentsSnap, deadLettersSnap, accountsSnap] = await Promise.all([
      listPaidSessions(),
      db.collection("checkoutIntents").get(),
      db.collection("billingDeadLetters").get(),
      db.collection("creditAccounts").get(),
    ]);
    const intents = intentsSnap.docs.map((doc) => {
      const data = doc.data();
      return {
        intentId: data.id ?? doc.id,
        boardId: data.boardId ?? "unknown",
        status: data.status ?? "unknown",
        expiresAt: typeof data.expiresAt === "number" ? data.expiresAt : 0,
        ...(data.stripeSessionId ? { stripeSessionId: data.stripeSessionId } : {}),
        ...(data.stripePaymentIntentId
          ? { stripePaymentIntentId: data.stripePaymentIntentId }
          : {}),
      };
    });
    const deadLetters = deadLettersSnap.docs.map((doc) => {
      const data = doc.data();
      return { reason: data.reason ?? "", ...(data.boardId ? { boardId: data.boardId } : {}) };
    });
    const purchases = [];
    for (const accountDoc of accountsSnap.docs) {
      const purchasesSnap = await accountDoc.ref.collection("purchases").get();
      for (const purchaseDoc of purchasesSnap.docs) {
        const data = purchaseDoc.data();
        purchases.push({
          boardId: accountDoc.id,
          purchaseId: data.purchaseId ?? purchaseDoc.id,
          granted: (data.grantedCredits ?? 0) > 0,
        });
      }
    }
    const report = buildBillingReconciliationReport(
      { paidSessions, purchases, intents, deadLetters, now: Date.now() },
      boardHash,
    );
    console.log(
      `billing reconciliation stripe=${gate.mode} project=${projectId} keyEnv=${envName} ` +
        `paidSessions=${paidSessions.length} purchases=${purchases.length} intents=${intents.length}`,
    );
    for (const row of report.paidNoGrant) {
      console.log(
        `paid-no-grant session=${row.sessionId} paymentIntent=${row.paymentIntentId ?? "-"} intent=${row.intentId ?? "-"} ${row.board}`,
      );
    }
    for (const row of report.grantNoPayment) {
      console.log(`grant-no-payment purchase=${row.purchaseId} ${row.board}`);
    }
    for (const row of report.deadLettersByReason) {
      console.log(`dead-letters reason=${row.reason} count=${row.count}`);
    }
    for (const row of report.pendingPastTtl) {
      console.log(`pending-past-ttl intent=${row.intentId} expiresAt=${row.expiresAt} ${row.board}`);
    }
    console.log(
      `SUMMARY paidNoGrant=${report.paidNoGrant.length} grantNoPayment=${report.grantNoPayment.length} ` +
        `deadLetters=${report.deadLetterTotal} pendingPastTtl=${report.pendingPastTtl.length} ` +
        `anomalies=${report.anomalyCount} clean=${report.clean}`,
    );
    process.exitCode = report.clean ? 0 : 1;
  } finally {
    await db.terminate();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
