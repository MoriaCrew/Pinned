#!/usr/bin/env node
/**
 * PIN-153 billing reconciliation (read-only; PIN-243: also run by
 * the scheduled workflow .github/workflows/billing-reconciliation.yml).
 * Joins paid Stripe Checkout Sessions (read-only listing
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
 *
 * Output modes (PIN-243):
 *   (default)       operator terminal: one line per anomaly row, then a
 *                   RECONCILIATION_JSON:{stripe,project,summary,report} line.
 *   --json          row lines on stderr; stdout is only the full payload
 *                   {stripe,project,summary,report}. Operator terminal only.
 *   --summary-only  for public logs (CI): stdout is only {stripe,project,summary}
 *                   (counts and booleans), stderr only the aggregate,
 *                   SUMMARY and refunds-disputes lines, and an error prints
 *                   no Stripe message. No session, payment-intent or
 *                   checkout-intent id, board hash or timestamp is printed:
 *                   a checkout-intent id resolves to a board link through
 *                   /billing/return. Wins over --json.
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
const SUMMARY_ONLY = args.includes("--summary-only");
const JSON_MODE = SUMMARY_ONLY || args.includes("--json");

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

// Mirror of summarizeBillingReconciliation + billingReconciliationExitCode
// in src/domain/billing-reconciliation.ts — keep in sync (PIN-243).
function summarizeBillingReconciliation(report, visibility) {
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
function billingReconciliationExitCode(report) {
  return report.clean ? 0 : 1;
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
    // Stripe's message can echo a masked key or an object id: only the
    // status and the error code reach a --summary-only (public) log.
    const publicMessage = `Stripe GET ${path} failed: HTTP ${res.status} ${err.code ?? ""}`.trim();
    const error = new Error(`${publicMessage} ${err.message ?? ""}`.trim());
    error.publicMessage = publicMessage;
    throw error;
  }
  return json;
}

/** The one error line a --summary-only run may print: never a provider message. */
function publicErrorLine(error) {
  if (typeof error?.publicMessage === "string") return error.publicMessage;
  const raw = error?.code === undefined ? "" : String(error.code);
  const code = /^[A-Za-z0-9_.-]{1,40}$/.test(raw) ? ` code=${raw}` : "";
  const name = /^[A-Za-z]{1,40}$/.test(String(error?.name)) ? error.name : "Error";
  return `billing reconciliation failed (${name}${code}); rerun it in an operator terminal without --summary-only for the detail (docs/15 PIN-243).`;
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

// PIN-243 refunds/disputes visibility (informational, never an anomaly).
// The restricted read key may lack Refunds/Disputes read (docs/15 read-key
// table); a 403 degrades to `undefined` + the Dashboard check, never a failure.
async function listRefundDisputeVisibility(nowMs) {
  const sinceSec = Math.floor((nowMs - 30 * 24 * 60 * 60 * 1000) / 1000);
  try {
    const [refunds, disputes] = await Promise.all([
      stripeGet("/refunds", { limit: "100", "created[gte]": String(sinceSec) }),
      stripeGet("/disputes", { limit: "100", "created[gte]": String(sinceSec) }),
    ]);
    const disputeRows = disputes.data ?? [];
    // Stripe closes a dispute as won, lost, charge_refunded (the charge was
    // refunded before a decision) or warning_closed (an inquiry that ended);
    // everything else (needs_response, under_review and their warning_*
    // forms) still wants attention.
    const closed = new Set(["won", "lost", "charge_refunded", "warning_closed"]);
    return {
      refundsLast30Days: (refunds.data ?? []).length,
      disputesLast30Days: disputeRows.length,
      openDisputes: disputeRows.filter((d) => !closed.has(d.status)).length,
    };
  } catch {
    return undefined;
  }
}

async function main() {
  const envName = arg("--env-var") ?? "STRIPE_SECRET_KEY";
  if (!envName || envName.startsWith("--")) {
    console.error(
      "usage: billing-reconciliation.mjs --env-var <ENV_VAR_NAME> [--project <id>] [--json | --summary-only]",
    );
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
    // Human mode prints every line on stdout; --json and --summary-only keep
    // stdout for the one JSON document. Row lines carry ids, so
    // --summary-only drops them (`row` is a no-op there).
    const line = JSON_MODE ? (text) => console.error(text) : (text) => console.log(text);
    const row = SUMMARY_ONLY ? () => {} : line;
    const visibility = await listRefundDisputeVisibility(Date.now());
    const report = buildBillingReconciliationReport(
      { paidSessions, purchases, intents, deadLetters, now: Date.now() },
      boardHash,
    );
    line(
      `billing reconciliation stripe=${gate.mode} project=${projectId} keyEnv=${envName} ` +
        `paidSessions=${paidSessions.length} purchases=${purchases.length} intents=${intents.length}`,
    );
    for (const r of report.paidNoGrant) {
      row(
        `paid-no-grant session=${r.sessionId} paymentIntent=${r.paymentIntentId ?? "-"} intent=${r.intentId ?? "-"} ${r.board}`,
      );
    }
    for (const r of report.grantNoPayment) {
      row(`grant-no-payment purchase=${r.purchaseId} ${r.board}`);
    }
    for (const r of report.deadLettersByReason) {
      row(`dead-letters reason=${r.reason} count=${r.count}`);
    }
    for (const r of report.pendingPastTtl) {
      row(`pending-past-ttl intent=${r.intentId} expiresAt=${r.expiresAt} ${r.board}`);
    }
    line(
      `SUMMARY paidNoGrant=${report.paidNoGrant.length} grantNoPayment=${report.grantNoPayment.length} ` +
        `deadLetters=${report.deadLetterTotal} pendingPastTtl=${report.pendingPastTtl.length} ` +
        `anomalies=${report.anomalyCount} clean=${report.clean}`,
    );
    const summary = summarizeBillingReconciliation(report, visibility);
    line(
      visibility
        ? `refunds-disputes last30d refunds=${summary.refundsLast30Days} disputes=${summary.disputesLast30Days} openDisputes=${summary.openDisputes}`
        : `refunds-disputes unavailable (read key lacks Refunds/Disputes read; check Stripe Dashboard Payments, docs/15 PIN-243)`,
    );
    // PIN-243 machine-readable summary for automation. `--summary-only`
    // prints {stripe, project, summary} - counts and booleans, never an id -
    // as the only stdout document (public CI logs); `--json` prints the full
    // payload with the report; human mode adds one parseable line.
    const payload = SUMMARY_ONLY
      ? JSON.stringify({ stripe: gate.mode, project: projectId, summary })
      : JSON.stringify({ stripe: gate.mode, project: projectId, summary, report });
    process.stdout.write(JSON_MODE ? `${payload}\n` : `RECONCILIATION_JSON:${payload}\n`);
    process.exitCode = billingReconciliationExitCode(report);
  } finally {
    await db.terminate();
  }
}

main().catch((error) => {
  if (SUMMARY_ONLY) console.error(publicErrorLine(error));
  else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
