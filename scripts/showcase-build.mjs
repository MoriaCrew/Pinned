#!/usr/bin/env node
/**
 * PIN-173 showcase set builder (manual/operator, never in CI).
 *
 * Makes the landing's showcase sets (docs/17-showcase-sets.md) with the
 * product's own code paths: source photos from Muse Image, then the local
 * app turns them into cut-outs and scenes over its public boards API, then
 * sharp builds the small WebP files with the AI-generated marker.
 *
 *   node scripts/showcase-build.mjs plan   <spec> [set...]        check the spec; no network
 *   node scripts/showcase-build.mjs photos <items.json> [--live]  Muse Image source photos (PAID with --live)
 *   node scripts/showcase-build.mjs serve  [--live --env-file F]  start the local app (mock unless --live)
 *   node scripts/showcase-build.mjs run    <spec> [set...]        drive the local app, one set at a time
 *   node scripts/showcase-build.mjs sheet  <set>...               rebuild a set's contact sheet
 *   node scripts/showcase-build.mjs web    <web-spec>             build public/landing/sets/<set>/ files
 *
 * Every path comes from an option or an environment variable; nothing
 * about this machine lives in the repo:
 *   --work-dir    SHOWCASE_WORK_DIR    work folder, outside git or gitignored (default .showcase-work)
 *   --photos-dir  SHOWCASE_PHOTOS_DIR  source photos (default <work>/photos)
 *   --base-url    SHOWCASE_BASE_URL    the app (default http://localhost:3000; localhost only)
 *   --env-file    SHOWCASE_ENV_FILE    the operator's env file, read only by live commands
 *   --out-dir                          where `web` writes (default public/landing/sets)
 *
 * Board slugs, cookies and keys are never printed, logged or written.
 * `run` fails loudly (exit 1) on a refused or collage scene on a live app,
 * a photo with no usable pin, or a run over --max-jobs, and still writes
 * run.json and the contact sheet so the evidence is kept.
 */
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { assertLocalBase, latestPromptVersion, listPromptFiles, modelsFromEnv, readHealth, runSet } from "./showcase/driver.mjs";
import { DEFAULT_IMAGE_CAP, generatePhotos, validatePhotoItems } from "./showcase/photos.mjs";
import { REPO_ROOT, serveEnv, startServer } from "./showcase/serve.mjs";
import { writeSheet } from "./showcase/sheet.mjs";
import { JobBudget, listSetIds, parseSpec, planJobs } from "./showcase/spec.mjs";
import { buildWeb, validateWebSpec } from "./showcase/web.mjs";

const USAGE = readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].split("\n").filter((l) => l.startsWith(" *")).map((l) => l.slice(3)).join("\n");

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "work-dir": { type: "string" },
    "photos-dir": { type: "string" },
    "base-url": { type: "string" },
    "env-file": { type: "string" },
    "out-dir": { type: "string" },
    port: { type: "string" },
    live: { type: "boolean", default: false },
    "allow-remote-base": { type: "boolean", default: false },
    "max-jobs": { type: "string", default: "24" },
    "scene-tries": { type: "string", default: "3" },
    "image-cap": { type: "string", default: String(DEFAULT_IMAGE_CAP) },
    baseline: { type: "string", default: "0" },
    quality: { type: "string" },
    force: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});
const [command, ...args] = positionals;

const log = (text) => console.error(`[showcase] ${text}`);
const die = (text, code = 2) => {
  console.error(`[showcase] ${text}`);
  process.exit(code);
};
const int = (name, text, min = 1) => {
  const n = Number(text);
  if (!Number.isInteger(n) || n < min) die(`--${name} must be a whole number of at least ${min}`);
  return n;
};

const workDir = path.resolve(opt["work-dir"] ?? process.env.SHOWCASE_WORK_DIR ?? ".showcase-work");
const photosDir = path.resolve(opt["photos-dir"] ?? process.env.SHOWCASE_PHOTOS_DIR ?? path.join(workDir, "photos"));
const outRoot = path.join(workDir, "out");
const envFile = opt["env-file"] ?? process.env.SHOWCASE_ENV_FILE;

function loadEnvFile() {
  if (!envFile) die("a live command needs the operator's env file: pass --env-file or set SHOWCASE_ENV_FILE");
  if (typeof process.loadEnvFile !== "function") die("this Node cannot load an env file; use Node 20.12 or newer");
  process.loadEnvFile(path.resolve(envFile));
}

/** The specs to use: the named sets, or every set in the file. All are checked before anything starts. */
function loadSpecs(specPath, ids) {
  if (!specPath) die("name the spec file");
  const text = readFileSync(path.resolve(specPath), "utf8");
  try {
    return (ids.length ? ids : listSetIds(text)).map((id) => parseSpec(text, id));
  } catch (error) {
    return die(error.message);
  }
}

async function plan() {
  const specs = loadSpecs(args[0], args.slice(1));
  const sceneTries = int("scene-tries", opt["scene-tries"]);
  const jobs = planJobs(specs, { sceneTries });
  let missing = 0;
  for (const spec of specs) {
    log(`${spec.id}: ${spec.friends.length} photos, ${spec.scenes.length} scenes`);
    for (const friend of spec.friends) {
      if (!existsSync(path.join(photosDir, friend.photo))) {
        missing += 1;
        log(`  missing photo ${friend.photo}`);
      }
    }
  }
  log(`jobs: ${jobs.min} at least, ${jobs.max} at most (cap ${opt["max-jobs"]}); photos folder ${missing ? `is missing ${missing}` : "is complete"}`);
  process.exit(missing || jobs.min > int("max-jobs", opt["max-jobs"]) ? 1 : 0);
}

async function photos() {
  if (!args[0]) die("name the items file");
  const items = JSON.parse(readFileSync(path.resolve(args[0]), "utf8"));
  const problems = validatePhotoItems(items);
  if (problems.length) die(`invalid items file:\n- ${problems.join("\n- ")}`);
  const cap = int("image-cap", opt["image-cap"]);
  const stateFile = path.join(workDir, "photos-state.json");
  if (!opt.live) {
    log(`${items.length} photos planned against an image cap of ${cap}. Nothing was generated: add --live to make them (paid calls).`);
    return;
  }
  loadEnvFile();
  const result = await generatePhotos(items, {
    photosDir,
    stateFile,
    cap,
    baseline: int("baseline", opt.baseline, 0),
    force: opt.force,
    baseUrl: process.env.META_API_BASE_URL,
    key: process.env.META_API_KEY,
    model: process.env.META_MODEL_IMAGE,
    log,
  });
  log(`made ${result.made.length}, skipped ${result.skipped.length}, failed ${result.failed.length}`);
  process.exit(result.failed.length ? 1 : 0);
}

async function serve() {
  const port = int("port", opt.port ?? "3000");
  if (opt.live) {
    loadEnvFile();
    log("LIVE app: model calls are paid. Daily stop: $10 and 2000 calls. Listening on localhost only.");
  } else {
    log("MOCK app (AI_MOCK=1): free, scenes are collages. Add --live --env-file for real models.");
  }
  process.exit(await startServer(serveEnv(process.env, { live: opt.live, port }), { port }));
}

/** Keep an earlier run of the set: move its folder aside instead of overwriting or deleting it. */
function freshOutDir(id) {
  const dir = path.join(outRoot, id);
  if (existsSync(dir)) renameSync(dir, `${dir}-${new Date().toISOString().replace(/[-:]|\.\d+Z$/g, "")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function run() {
  const specs = loadSpecs(args[0], args.slice(1));
  const maxJobs = int("max-jobs", opt["max-jobs"]);
  const sceneTries = int("scene-tries", opt["scene-tries"]);
  const jobs = planJobs(specs, { sceneTries });
  if (jobs.min > maxJobs) die(`these sets need at least ${jobs.min} model jobs; --max-jobs is ${maxJobs}`);
  let base;
  try {
    base = assertLocalBase(opt["base-url"] ?? process.env.SHOWCASE_BASE_URL ?? "http://localhost:3000", { allowRemote: opt["allow-remote-base"] });
  } catch (error) {
    return die(error.message);
  }
  if (envFile) loadEnvFile(); // only to record the model ids the app was started with
  const { aiMock } = await readHealth(base).catch((error) => die(error.message));
  if (!aiMock && !opt.live) die("the app is LIVE, so this run makes paid model calls: pass --live to go ahead");
  log(`${aiMock ? "mock" : "LIVE"} app at ${base}; up to ${jobs.max} model jobs (cap ${maxJobs})`);

  const promptFiles = listPromptFiles(path.join(REPO_ROOT, "prompts"));
  const budget = new JobBudget(maxJobs);
  let failed = 0;
  for (const spec of specs) {
    const outDir = freshOutDir(spec.id);
    let outcome;
    try {
      outcome = await runSet(spec, {
        base,
        photosDir,
        outDir,
        budget,
        sceneTries,
        mock: aiMock,
        log,
        models: modelsFromEnv(process.env),
        promptVersions: { elements: latestPromptVersion(promptFiles, "elements"), scene: latestPromptVersion(promptFiles, "scene") },
      });
    } catch (error) {
      die(`${spec.id}: ${error.message}`, 1);
    }
    writeSheet(outcome.run, outDir);
    log(`${spec.id}: ${outcome.failures.length ? `${outcome.failures.length} FAILURES` : "ok"}, ${outcome.run.jobs} jobs; contact-sheet.html and run.json in ${path.relative(process.cwd(), outDir) || "."}`);
    failed += outcome.failures.length;
    if (outcome.failures.length) break; // stop at the first set that fails: do not spend on the next
  }
  process.exit(failed ? 1 : 0);
}

async function sheet() {
  if (!args.length) die("name the set(s)");
  for (const id of args) {
    const dir = path.join(outRoot, id);
    if (!existsSync(path.join(dir, "run.json"))) die(`no run record for "${id}" in the work folder`);
    log(`wrote ${path.relative(process.cwd(), writeSheet(JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")), dir))}`);
  }
}

async function web() {
  if (!args[0]) die("name the web spec");
  const spec = JSON.parse(readFileSync(path.resolve(args[0]), "utf8"));
  const errors = validateWebSpec(spec);
  if (errors.length) die(`invalid web spec:\n- ${errors.join("\n- ")}`);
  const dir = path.join(outRoot, spec.set);
  if (!existsSync(path.join(dir, "run.json"))) die(`no run record for "${spec.set}" in the work folder`);
  const destDir = path.resolve(opt["out-dir"] ?? path.join("public", "landing", "sets"), spec.set);
  const quality = opt.quality === undefined ? undefined : int("quality", opt.quality, 40);
  const { written, folderBytes, problems } = await buildWeb(spec, JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")), { outDir: dir, destDir, quality });
  log(`${written.length} files, ${(folderBytes / 1024).toFixed(1)} KB in ${path.relative(process.cwd(), destDir)}`);
  for (const problem of problems) log(`PROBLEM ${problem}`);
  process.exit(problems.length ? 1 : 0);
}

const COMMANDS = { plan, photos, serve, run, sheet, web };
if (opt.help || !COMMANDS[command]) {
  console.error(USAGE);
  process.exit(opt.help ? 0 : 2);
}
await COMMANDS[command]();
