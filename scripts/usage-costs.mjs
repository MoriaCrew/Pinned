#!/usr/bin/env node
/**
 * PIN-137 AI cost report (operator-run, service-account; never CI).
 *
 * Reads aiCallLogs for a UTC day range from Firestore and prints
 * per-board / per-participant / per-operation ESTIMATED costs
 * (list-price estimates only — the provider dashboard is
 * authoritative). Board slugs are capability secrets: output
 * shows a short sha256 hash, never the raw slug.
 *
 *   npm run usage:costs -- --from 2026-10-01 --to 2026-10-31
 *   npm run usage:costs -- --days 7
 *
 * Auth: Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS
 * or `gcloud auth application-default login`); project from
 * GCLOUD_PROJECT / FIREBASE_PROJECT_ID, else the dev project in
 * .firebaserc. Mirrors src/domain/usage-costs.ts — keep in sync.
 *
 * Firestore TTL note (PIN-137): rows carry expireAt (epoch ms,
 * Policy.aiCallLogRetentionDays) + expireAtTs (Timestamp mirror).
 * Enable the TTL policy on aiCallLogs.expireAtTs in the Firebase
 * console / gcloud — code cannot create it. Until then rows are
 * kept; that is expected, not faked here.
 */
import { createHash } from "node:crypto";
import { Firestore } from "@google-cloud/firestore";

const args = process.argv.slice(2);
function arg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = new Date().toISOString().slice(0, 10);
let fromDay = arg("--from");
let toDay = arg("--to") ?? today;
const days = Number(arg("--days") ?? NaN);
if (!fromDay && Number.isInteger(days) && days > 0) {
  const from = new Date(Date.parse(`${toDay}T00:00:00Z`) - (days - 1) * 86_400_000);
  fromDay = from.toISOString().slice(0, 10);
}
if (!fromDay || !DAY.test(fromDay) || !DAY.test(toDay) || fromDay > toDay) {
  console.error("usage: npm run usage:costs -- --from YYYY-MM-DD [--to YYYY-MM-DD]  (or --days N)");
  process.exit(2);
}

function boardHash(boardId) {
  return `board:${createHash("sha256").update(boardId).digest("hex").slice(0, 12)}`;
}
// Mirrors src/domain/usage-costs.ts summarizeUsageCosts — keep in sync.
function summarize(logs) {
  const byKey = new Map();
  let totalCalls = 0, totalDenied = 0, totalMicro = 0;
  for (const log of logs) {
    if (log.dayBucket < fromDay || log.dayBucket > toDay) continue;
    const boardId = log.boardId ?? log.gameId;
    const board = boardId ? boardHash(boardId) : "unknown";
    const participantId = log.participantId ?? "unknown";
    const key = `${board} ${participantId} ${log.operation}`;
    const row = byKey.get(key) ?? { board, participantId, operation: log.operation, calls: 0, denied: 0, reservedMicroUsd: 0, costMicroUsdEst: 0 };
    const denied = String(log.outcome ?? "").startsWith("denied_");
    const micro = log.costMicroUsdEst ?? Math.max(0, Math.round((log.costEstimateUsd ?? 0) * 1_000_000));
    row.calls += 1;
    if (denied) row.denied += 1;
    row.reservedMicroUsd += log.reservedMicroUsd ?? 0;
    row.costMicroUsdEst += micro;
    byKey.set(key, row);
    totalCalls += 1;
    if (denied) totalDenied += 1;
    totalMicro += micro;
  }
  const rows = [...byKey.values()].sort((a, b) => b.costMicroUsdEst - a.costMicroUsdEst || a.board.localeCompare(b.board));
  return { rows, totalCalls, totalDenied, totalMicro };
}

const projectId = process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID || undefined;
const db = new Firestore(projectId ? { projectId } : {});
try {
  const snap = await db.collection("aiCallLogs")
    .where("dayBucket", ">=", fromDay)
    .where("dayBucket", "<=", toDay)
    .get();
  const { rows, totalCalls, totalDenied, totalMicro } = summarize(snap.docs.map((d) => d.data()));
  console.log(`AI costs ${fromDay}..${toDay} — all figures are ESTIMATES (list prices); provider dashboard is authoritative.`);
  for (const r of rows) {
    console.log(`${r.board} participant=${r.participantId} op=${r.operation} calls=${r.calls} denied=${r.denied} reservedMicroUsd=${r.reservedMicroUsd} cost=$${(r.costMicroUsdEst / 1_000_000).toFixed(4)} (estimate)`);
  }
  console.log(`TOTAL: calls=${totalCalls} denied=${totalDenied} cost=$${(totalMicro / 1_000_000).toFixed(4)} (estimate)`);
} finally {
  await db.terminate();
}
