/**
 * Report & hold operator CLI (PIN-272, docs/20). Runs the app's own
 * server code against a named project through scripts/ops-run.mjs:
 *
 *   npm run report:ops -- --project <firebase-project-id> [--bucket <name>] <command>
 *
 *   pending [--limit <n>]           open reports of every board, oldest first (the twice-a-day check)
 *   list --ref <reference>          every report carrying the reference, newest first
 *   show --id <reportId>            one report in full (message included: operator terminal only)
 *   dismiss --id <reportId> [--note "..."]   false alarm: restore what the report hid
 *   takedown --id <reportId> [--note "..."]  confirmed: remove the reported thing for everyone
 *   release-holds --id <reportId>   close-out: release the Storage holds this report set (minus what another report still holds)
 *   sweep [--batch <n>]             timed takedown of due reports (the daily backstop)
 *
 * --project is required and never read from ADC, gcloud or the env
 * (PIN-233). Auth is Application Default Credentials; the bucket
 * defaults to <project>.firebasestorage.app (docs/DEPLOY.md §6.2).
 * Output names reports by id and reference, never a board slug or link;
 * `show` prints the reporter's words, so run it in a private terminal.
 * Exit 0 done, 1 error, 2 usage.
 */
import { Firestore } from "@google-cloud/firestore";
import type { ReportRecord } from "../src/domain/board-report";
import { resolvePolicy } from "../src/policy/policy";
import { GcsDerivativeStore } from "../src/server/derivative-store";
import { FirestoreBoardRepository } from "../src/server/firestore-board-repository";
import { FirestoreReportStore } from "../src/server/firestore-report-store";
import { FirestoreUserRepository } from "../src/server/firestore-user-repository";
import {
  dismissReport,
  releaseReportHolds,
  sweepDueReports,
  takedownReport,
  type ReportDecideDeps,
} from "../src/server/report-decide";

const USAGE =
  "usage: npm run report:ops -- --project <id> [--bucket <name>] (pending [--limit <n>] | list --ref <reference> | show --id <id> | dismiss --id <id> [--note <text>] | takedown --id <id> [--note <text>] | release-holds --id <id> | sweep [--batch <n>])";
const COMMANDS = ["pending", "list", "show", "dismiss", "takedown", "release-holds", "sweep"] as const;
const PENDING_DEFAULT_LIMIT = 50;
type Command = (typeof COMMANDS)[number];

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(USAGE);
  process.exit(2);
}

const argv = process.argv.slice(2);
function option(name: string): string | undefined {
  const i = argv.indexOf(name);
  const value = i >= 0 ? argv[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}
const command = argv.find((a) => (COMMANDS as readonly string[]).includes(a)) as Command | undefined;
const project = option("--project");
if (!command) usage("A command is required.");
if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project)) usage("--project must name the Firebase project (never a default).");
const bucket = option("--bucket") ?? `${project}.firebasestorage.app`;

/** Terminal line for one report: ids, reference, enums, times and counts; never the board. */
function describe(record: ReportRecord, withMessage = false): string {
  const at = (ms?: number) => (ms === undefined ? "-" : new Date(ms).toISOString());
  const lines = [
    `report ${record.id}  ref ${record.reference}  ${record.status}`,
    `  ${record.scope}${record.targetId ? ` ${record.targetId}` : ""}  reason ${record.reason}  severity ${record.severity}  by ${record.reporterKind}`,
    `  created ${at(record.createdAt)}  deleteAt ${at(record.deleteAt)}  decided ${at(record.decidedAt)}${record.note ? `  note: ${record.note}` : ""}`,
    `  held: ${record.held.elementIds.length} element(s), ${record.held.sceneIds.length} scene(s), review ${record.held.boardReview}, storage hold ${record.held.storageHold}`,
  ];
  if (withMessage) {
    lines.push(`  email: ${record.reporterEmail ?? "-"}`);
    lines.push(`  message: ${record.message ?? "-"}`);
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const db = new Firestore({ projectId: project });
  const deps: ReportDecideDeps = {
    boards: new FirestoreBoardRepository(db),
    users: new FirestoreUserRepository(db),
    store: new GcsDerivativeStore(bucket, project),
    reports: new FirestoreReportStore(db),
  };
  try {
    switch (command) {
      case "pending": {
        const limitOption = option("--limit");
        const limit = limitOption === undefined ? PENDING_DEFAULT_LIMIT : Number(limitOption);
        if (!Number.isInteger(limit) || limit < 0) usage("--limit must be a whole number.");
        const records = await deps.reports.listOpen(limit);
        console.log(`${records.length} open report(s) in ${project}${records.length === limit ? " (capped)" : ""}.`);
        for (const record of records) console.log(describe(record));
        return 0;
      }
      case "list": {
        const ref = option("--ref")?.toLowerCase();
        if (!ref || !/^[0-9a-f]{16}$/.test(ref)) usage("--ref must be the 16-character reference from the alert or receipt.");
        const records = await deps.reports.listByReference(ref);
        if (records.length === 0) console.log(`No report carries reference ${ref} in ${project}.`);
        for (const record of records) console.log(describe(record));
        return 0;
      }
      case "show": {
        const id = option("--id");
        if (!id) usage("--id is required.");
        const record = await deps.reports.get(id);
        if (!record) {
          console.error(`No report ${id} in ${project}.`);
          return 1;
        }
        console.log(describe(record, true));
        return 0;
      }
      case "dismiss": {
        const id = option("--id");
        if (!id) usage("--id is required.");
        const outcome = await dismissReport(id, deps, option("--note"));
        if (!outcome) {
          console.error(`Report ${id} is missing or already decided.`);
          return 1;
        }
        console.log(describe(outcome.record));
        console.log(`released: ${JSON.stringify(outcome.released)}`);
        return 0;
      }
      case "takedown": {
        const id = option("--id");
        if (!id) usage("--id is required.");
        const result = await takedownReport(id, deps, option("--note"));
        if (!result) {
          console.error(`Report ${id} is missing or already decided.`);
          return 1;
        }
        console.log(describe(result.record));
        console.log(`outcome: ${result.outcome}`);
        if (result.record.reason === "illegal") {
          console.log("Storage holds stay (evidence). docs/20 §7: report to the hotline, keep the operator note; release with `release-holds` only at close-out.");
        }
        return 0;
      }
      case "release-holds": {
        const id = option("--id");
        if (!id) usage("--id is required.");
        const record = await deps.reports.get(id);
        if (!record) {
          console.error(`No report ${id} in ${project}.`);
          return 1;
        }
        const released = await releaseReportHolds(record, deps);
        console.log(
          `released ${released.released} object hold(s) of this report, kept ${released.kept} (another report still holds them), ${released.failed} failed (ref ${record.reference}).`,
        );
        return released.failed === 0 ? 0 : 1;
      }
      case "sweep": {
        const batchOption = option("--batch");
        const batch = batchOption === undefined ? resolvePolicy(null).report.sweepBatch : Number(batchOption);
        if (!Number.isInteger(batch) || batch < 0) usage("--batch must be a whole number.");
        const summary = await sweepDueReports(deps, Date.now(), batch);
        console.log(`REPORT_SWEEP ${JSON.stringify({ project, ...summary })}`);
        return 0;
      }
    }
    return 2;
  } finally {
    await db.terminate();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // Name and message only: never a slug list (safe-log's rule, by hand here).
    const text = error instanceof Error ? `${error.name}: ${error.message}` : "Operation failed.";
    console.error(text.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g, "<slug>"));
    process.exit(1);
  },
);
