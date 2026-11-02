#!/usr/bin/env node
/**
 * PIN-239 report reference -> board (operator-run, read-only; never
 * CI). A "Report this board" mail carries only the board's opaque
 * reference: the first 16 hex of sha256("pinned-report-v1:" + slug).
 * This lists the doc ids of `boards` (the ids are the slugs),
 * recomputes each reference and prints the matching slug, with
 * whether the board is live or already deleted, to this terminal
 * only. It never writes, and never sends the slug anywhere else.
 *
 *   node scripts/find-report-ref.mjs --project moriacrew-pinned-prod --ref 0123456789abcdef
 *
 * Exit 0 = found, 1 = no board in that project has the reference
 * (try the other project), 2 = usage. --project is required: never
 * ADC's, gcloud's or the env's default project (PIN-233). Firestore
 * auth is Application Default Credentials
 * (`gcloud auth application-default login`). Mirrors boardReportRef
 * in src/domain/tokens.ts — keep in sync (a test pins the mirror).
 * Runbook: docs/20-abuse-runbook.md.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Domain separator and length of the reference (src/domain/tokens.ts). */
export const REPORT_REF_PREFIX = "pinned-report-v1:";
export const REPORT_REF_HEX = 16;

// Mirror of boardReportRef in src/domain/tokens.ts — keep in sync.
export function boardReportRef(slug) {
  return createHash("sha256")
    .update(`${REPORT_REF_PREFIX}${slug}`, "utf8")
    .digest("hex")
    .slice(0, REPORT_REF_HEX);
}

const USAGE = "usage: node scripts/find-report-ref.mjs --project <firebase-project-id> --ref <reference>";
const REF_PATTERN = new RegExp(`^[0-9a-f]{${REPORT_REF_HEX}}$`);

/** `--project` and `--ref` from argv, or the usage error (exit 2). */
export function parseFindArgs(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    const found = i >= 0 ? argv[i + 1] : undefined;
    return found && !found.startsWith("--") ? found.trim() : undefined;
  };
  const project = value("--project");
  const ref = value("--ref")?.toLowerCase();
  if (!project) {
    return { ok: false, error: `--project is required (never the ADC or gcloud default).\n${USAGE}` };
  }
  if (!ref || !REF_PATTERN.test(ref)) {
    return { ok: false, error: `--ref must be the ${REPORT_REF_HEX}-character hex reference from the report.\n${USAGE}` };
  }
  return { ok: true, project, ref };
}

/** The slugs whose reference is `ref`. */
export function matchReportRef(slugs, ref) {
  return slugs.filter((slug) => boardReportRef(slug) === ref);
}

async function main() {
  const parsed = parseFindArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    process.exit(2);
  }
  const { Firestore } = await import("@google-cloud/firestore");
  const db = new Firestore({ projectId: parsed.project });
  try {
    const boards = db.collection("boards");
    const docs = await boards.listDocuments();
    const matches = matchReportRef(
      docs.map((doc) => doc.id),
      parsed.ref,
    );
    if (matches.length === 0) {
      console.error(`No board in ${parsed.project} has reference ${parsed.ref} (${docs.length} checked).`);
      process.exitCode = 1;
      return;
    }
    for (const slug of matches) {
      const snap = await boards.doc(slug).get();
      const state = !snap.exists ? "no-board-doc" : snap.get("deletedAt") === undefined ? "live" : "deleted";
      console.log(`${slug} ${state}`);
    }
    console.error("Terminal only: keep this slug out of mail, chat, tickets, Linear and git.");
  } finally {
    await db.terminate();
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    // The error's name and message only: never the slug list.
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Lookup failed.");
    process.exit(1);
  });
}
