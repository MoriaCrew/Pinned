#!/usr/bin/env node
/**
 * PIN-74 usage report (manual/operator, never in CI).
 *
 * Prints boards/people/pins/scenes totals for the hackathon
 * video from the PUBLIC boards API only (no Firestore access),
 * using each board's repository counters. There is no board
 * list by design — slugs are capability secrets — so name the
 * boards to count:
 *
 *   npm run usage:report -- <slug> [<slug> ...]
 *   USAGE_BOARD_SLUGS=slug1,slug2 npm run usage:report
 *   USAGE_BASE_URL=https://dev.example.com npm run usage:report -- <slug>
 *
 * Default base http://localhost:3000 (USAGE_BASE_URL, else
 * SEED_BASE_URL). Output shows each board's TITLE + counts and
 * one totals line; slugs are never printed. A board that 404s
 * or returns malformed counters is reported on stderr and the
 * exit code is 1 (totals then exclude it — never invented).
 * Mirrors src/domain/usage-report.ts — keep the two in sync.
 */

const BASE = (process.env.USAGE_BASE_URL || process.env.SEED_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const slugs = [
  ...process.argv.slice(2).filter((a) => !a.startsWith("--")),
  ...(process.env.USAGE_BOARD_SLUGS || "").split(",").map((s) => s.trim()).filter(Boolean),
];

if (slugs.length === 0) {
  console.error("usage: npm run usage:report -- <slug> [<slug> ...]  (or set USAGE_BOARD_SLUGS)");
  process.exit(2);
}

// Mirrors src/domain/usage-report.ts (PIN-74) — keep in sync.
function counter(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function usageFromBoardView(view) {
  if (typeof view !== "object" || view === null) return null;
  const board = view.board;
  if (typeof board !== "object" || board === null) return null;
  const { title, counters } = board;
  if (typeof title !== "string" || typeof counters !== "object" || counters === null) return null;
  const participants = counter(counters.participantCount);
  const elements = counter(counters.elementCount);
  const pins = counter(counters.pinCount);
  const scenes = counter(counters.sceneCount);
  if (participants === null || elements === null || pins === null || scenes === null) return null;
  return { title, participants, elements, pins, scenes };
}

const boards = [];
let failed = false;
for (const slug of slugs) {
  try {
    const response = await fetch(`${BASE}/api/boards/${encodeURIComponent(slug)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const usage = usageFromBoardView(await response.json());
    if (!usage) throw new Error("malformed board view");
    boards.push(usage);
  } catch (error) {
    failed = true;
    console.error(`SKIP one board: ${error.message} (excluded from totals)`);
  }
}

for (const b of boards) {
  console.log(`${b.title}: people=${b.participants} elements=${b.elements} pins=${b.pins} scenes=${b.scenes}`);
}
const totals = boards.reduce(
  (acc, b) => ({
    boards: acc.boards + 1,
    people: acc.people + b.participants,
    elements: acc.elements + b.elements,
    pins: acc.pins + b.pins,
    scenes: acc.scenes + b.scenes,
  }),
  { boards: 0, people: 0, elements: 0, pins: 0, scenes: 0 },
);
console.log(`TOTAL: boards=${totals.boards} people=${totals.people} elements=${totals.elements} pins=${totals.pins} scenes=${totals.scenes}`);
process.exit(failed ? 1 : 0);
