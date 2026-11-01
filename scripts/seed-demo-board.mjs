#!/usr/bin/env node
/**
 * PIN-73 demo-board seeder (manual/operator, never in CI).
 *
 * Seeds ONE judge demo board through the PUBLIC boards API only
 * (no Firestore/Storage access), so it works identically against
 * a local server and a hosted backend:
 *
 *   SEED_BASE_URL=https://dev.example.com npm run seed:demo
 *   npm run seed:demo                      # default http://localhost:3000
 *   npm run seed:demo -- --no-scene        # skip the ready scene
 *
 * Plan (mirrors src/domain/demo-seed.ts — keep the two in sync):
 * create board with the deterministic demo title marker, join 2
 * demo participants, each uploads one PIN-50 synthetic fixture
 * photo, confirm all candidate pins, then make 1 scene mixing
 * both participants' pins (a free collage when the target runs
 * AI_MOCK=1; ONE live scene when the target is live — see cost
 * note printed to stderr).
 *
 * Reset semantics: there is no delete API, so every run creates a
 * NEW board with the same title marker and (on a deterministic
 * target) the same counts. "Reset" = run again and repoint
 * DEMO_BOARD_SLUG / the Linear evidence note to the new slug.
 *
 * The board slug is a capability secret: it is printed EXACTLY
 * ONCE, as the only stdout line (`DEMO_BOARD_SLUG=...`), for the
 * operator to capture into Linear/env. All progress goes to
 * stderr and never contains the slug. NEVER commit the slug.
 *
 * Fresh-visitor timing (docs/11 s6: first scene < 90s target):
 *
 *   npm run seed:demo -- --time-first-scene <slug>
 *
 * Joins the board as a brand-new visitor, picks pinned pins,
 * requests a scene and waits for it to be ready. Prints one
 * stdout line `FIRST_SCENE_SECONDS=...` (wall clock: first board
 * load -> join -> scene ready). This makes one real scene on the
 * target board.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.SEED_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const POLL_MS = Number(process.env.SEED_POLL_MS || 2000);
const TIMEOUT_MS = Number(process.env.SEED_TIMEOUT_MS || 240_000);

// Mirrors src/domain/demo-seed.ts (PIN-73) — keep in sync.
const DEMO_BOARD_TITLE = "Pinneds demo board (seeded, synthetic)";
const DEMO_BOARD_THEME_ID = "cat";
const DEMO_PARTICIPANTS = [
  { displayName: "Demo Mia", photoPath: "eval/fixtures/studio/photos/desk-mug-duck.jpg" },
  { displayName: "Demo Sam", photoPath: "eval/fixtures/studio/photos/shelf-clock-books.jpg" },
];
const DEMO_SCENE_PROMPT = "These things having a tiny tea party on a sunny windowsill";
const DEMO_TIMING_VISITOR_NAME = "Demo Visitor";
const DEMO_TIMING_PROMPT = "These things on a picnic blanket in a sunny park";
const SCENE_PIN_CAP = 3; // <= Policy.pinsPerScene.max default (4)

const log = (...args) => console.error("[seed]", ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, { method = "GET", cookie, json, form } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
  });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error body; status is reported by caller */
  }
  return { res, body };
}

function fail(step, status, body) {
  throw new Error(`${step} failed: HTTP ${status} ${body?.error ?? ""}`.trim());
}

function cookieFrom(res) {
  const set =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : [res.headers.get("set-cookie")].filter(Boolean);
  if (!set.length) throw new Error("join did not return a session cookie");
  return set[0].split(";")[0];
}

/** One per owner first, then fill — mirrors pickSceneElementIds. */
function pickSceneElementIds(elements, max) {
  const picked = [];
  const owners = new Set();
  for (const el of elements) {
    if (picked.length >= max) break;
    if (!owners.has(el.ownerId ?? "")) {
      owners.add(el.ownerId ?? "");
      picked.push(el.id);
    }
  }
  for (const el of elements) {
    if (picked.length >= max) break;
    if (!picked.includes(el.id)) picked.push(el.id);
  }
  return picked;
}

async function pollUntil(label, fn) {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const out = await fn();
    if (out.done) return out.value;
    if (Date.now() > deadline) throw new Error(`${label} timed out after ${TIMEOUT_MS}ms`);
    await sleep(POLL_MS);
  }
}

async function joinBoard(slug, displayName) {
  const { res, body } = await api(`/api/boards/${slug}/participants`, {
    method: "POST",
    json: { displayName },
  });
  if (!res.ok) fail(`join ${displayName}`, res.status, body);
  return { cookie: cookieFrom(res), participant: body.participant };
}

async function uploadAndPin(slug, cookie, photoPath) {
  const abs = join(REPO_ROOT, photoPath);
  if (!existsSync(abs)) throw new Error(`fixture photo missing: ${photoPath}`);
  const bytes = readFileSync(abs);
  const form = new FormData();
  form.append("photo", new Blob([bytes], { type: "image/jpeg" }), photoPath.split("/").pop());
  const up = await api(`/api/boards/${slug}/photos`, { method: "POST", cookie, form });
  if (!up.res.ok) fail("photo upload", up.res.status, up.body);
  const jobId = up.body.job?.id;
  if (!jobId) throw new Error("photo upload returned no job id");

  const view = await pollUntil("decompose job", async () => {
    const { res, body } = await api(`/api/boards/${slug}/jobs/${jobId}`, { cookie });
    if (!res.ok) fail("job poll", res.status, body);
    const status = body.job?.status;
    if (status === "ready") return { done: true, value: body };
    if (status === "failed" || status === "refused") {
      throw new Error(`decompose job ended ${status}`);
    }
    return { done: false };
  });

  const pinIds = (view.pins ?? []).map((p) => p.id);
  if (!pinIds.length) throw new Error("decompose produced no candidate pins");
  const conf = await api(`/api/boards/${slug}/pins/confirm`, {
    method: "POST",
    cookie,
    json: { jobId, pinIds },
  });
  if (!conf.res.ok) fail("confirm pins", conf.res.status, conf.body);
  log(`pinned ${pinIds.length} pins from ${photoPath.split("/").pop()}`);
  return (view.elements ?? []).map((e) => e.id);
}

async function makeScene(slug, cookie, elementIds, prompt) {
  const { res, body } = await api(`/api/boards/${slug}/scenes`, {
    method: "POST",
    cookie,
    json: { elementIds, prompt },
  });
  if (!res.ok) fail("scene request", res.status, body);
  let scene = body.scene;
  if (scene && scene.status !== "ready" && scene.status !== "failed" && scene.status !== "refused") {
    scene = await pollUntil("scene", async () => {
      const poll = await api(`/api/boards/${slug}/scenes/${scene.id}`);
      if (!poll.res.ok) fail("scene poll", poll.res.status, poll.body);
      const s = poll.body.scene ?? poll.body;
      return s.status === "ready" || s.status === "failed" || s.status === "refused"
        ? { done: true, value: s }
        : { done: false };
    });
  }
  return scene;
}

async function boardCounts(slug) {
  const { res, body } = await api(`/api/boards/${slug}`);
  if (!res.ok) fail("board view", res.status, body);
  return {
    participants: body.participants?.length ?? 0,
    pinnedPins: (body.pins ?? []).filter((p) => p.status === "pinned").length,
    elements: body.elements?.length ?? 0,
    readyScenes: (body.scenes ?? []).filter((s) => s.status === "ready").length,
    view: body,
  };
}

async function seed(withScene) {
  log(`target ${BASE}`);
  const health = await api("/api/health");
  if (!health.res.ok) fail("health check", health.res.status, health.body);
  log("health ok");

  const created = await api("/api/boards", {
    method: "POST",
    json: { title: DEMO_BOARD_TITLE, themeId: DEMO_BOARD_THEME_ID },
  });
  if (!created.res.ok) fail("create board", created.res.status, created.body);
  const slug = created.body.board?.slug;
  if (!slug) throw new Error("create board returned no slug");
  log("board created (slug withheld from logs)");

  let firstCookie = null;
  const allElementIds = [];
  for (const plan of DEMO_PARTICIPANTS) {
    const { cookie } = await joinBoard(slug, plan.displayName);
    firstCookie ??= cookie;
    log(`joined ${plan.displayName}`);
    allElementIds.push(...(await uploadAndPin(slug, cookie, plan.photoPath)));
  }

  if (withScene) {
    log(
      "making 1 demo scene (free collage on AI_MOCK targets; ONE live scene, est. ~$0.02, on live targets)",
    );
    const { view } = await boardCounts(slug);
    const ids = pickSceneElementIds(view.elements ?? [], SCENE_PIN_CAP);
    if (!ids.length) throw new Error("no pinned elements available for the demo scene");
    const scene = await makeScene(slug, firstCookie, ids, DEMO_SCENE_PROMPT);
    log(`scene status=${scene?.status} kind=${scene?.kind ?? "ai"}`);
    if (scene?.status !== "ready") throw new Error(`demo scene not ready: ${scene?.status}`);
  } else {
    log("scene step skipped (--no-scene / SEED_SCENE=0)");
  }

  const counts = await boardCounts(slug);
  log(
    `counts participants=${counts.participants} pinnedPins=${counts.pinnedPins} ` +
      `elements=${counts.elements} readyScenes=${counts.readyScenes}`,
  );
  log("record the slug below in Linear / DEMO_BOARD_SLUG — never commit it");
  // The ONLY stdout line, and the only place the slug is printed.
  console.log(`DEMO_BOARD_SLUG=${slug}`);
}

async function timeFirstScene(slug) {
  log(`target ${BASE}; timing fresh-visitor first scene (makes 1 real scene)`);
  const started = Date.now();
  const first = await boardCounts(slug); // fresh board load, no session
  const { cookie } = await joinBoard(slug, DEMO_TIMING_VISITOR_NAME);
  const ids = pickSceneElementIds(first.view.elements ?? [], SCENE_PIN_CAP);
  if (!ids.length) throw new Error("board has no pinned elements to make a scene from");
  const sceneStarted = Date.now();
  const scene = await makeScene(slug, cookie, ids, DEMO_TIMING_PROMPT);
  const totalS = (Date.now() - started) / 1000;
  const sceneS = (Date.now() - sceneStarted) / 1000;
  log(`scene status=${scene?.status} kind=${scene?.kind ?? "ai"} sceneWait=${sceneS.toFixed(1)}s`);
  if (scene?.status !== "ready") {
    console.log(`FIRST_SCENE_SECONDS=${totalS.toFixed(1)} status=${scene?.status}`);
    process.exit(1);
  }
  console.log(`FIRST_SCENE_SECONDS=${totalS.toFixed(1)}`);
}

const args = process.argv.slice(2);
const timeIdx = args.indexOf("--time-first-scene");
const withScene = !args.includes("--no-scene") && process.env.SEED_SCENE !== "0";

try {
  if (timeIdx >= 0) {
    const slug = args[timeIdx + 1];
    if (!slug) throw new Error("--time-first-scene needs a board slug argument");
    await timeFirstScene(slug);
  } else {
    await seed(withScene);
  }
} catch (error) {
  console.error("[seed] FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
