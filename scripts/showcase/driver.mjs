/**
 * Drive one showcase set through the local app (PIN-173, docs/17 step 4).
 *
 * Uses only the public boards API, like scripts/seed-demo-board.mjs:
 * create board -> join each friend -> upload the photo -> poll the
 * decompose job -> confirm the pins -> make each scene from the picked
 * things -> download every cut-out, flattened picture and scene.
 *
 * A board slug is the board's access key: it stays in memory. Every log
 * line and error goes through a redactor that knows the slug and the
 * session cookies, and run.json never holds either.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BudgetError, resolveScenePicks } from "./spec.mjs";

/** Mirrors DEFAULT_META_MODELS in src/config.ts (PIN-59); a test keeps the two in step. */
export const DEFAULT_MODELS = Object.freeze({ spark: "muse-spark-1.3", sam: "sam-3.1", image: "muse-image-1.0" });

const LOCAL_BASE_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const MIME = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };
const EXT = { "image/png": ".png", "image/webp": ".webp", "image/jpeg": ".jpg" };
const ENDED = new Set(["ready", "failed", "refused"]);

/**
 * The app's base URL. Only localhost is allowed, because a run uploads photos and starts
 * model jobs; `allowRemote` is the explicit flag for any other http(s) origin.
 */
export function assertLocalBase(url, { allowRemote = false } = {}) {
  const base = String(url).replace(/\/+$/, "");
  if (LOCAL_BASE_RE.test(base)) return base;
  if (allowRemote && /^https?:\/\/[^/\s@?#]+$/.test(base)) return base;
  throw new Error("the base URL must be http://localhost, http://127.0.0.1 or http://[::1] (pass --allow-remote-base only on purpose)");
}

/** A function that replaces every known secret in a string. The list can grow while the run goes on. */
export function makeRedactor(secrets) {
  return (text) => secrets.reduce((out, secret) => (secret ? out.split(secret).join("[redacted]") : out), String(text));
}

/** `name=value` pairs from Set-Cookie headers, ready for a Cookie header. */
export const cookieHeader = (setCookies) => setCookies.map((c) => c.split(";")[0]).join("; ");

export const slugify = (text, fallback = "thing") =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;

/** The newest template version in the prompts folder for a name, e.g. "elements.v1". */
export function latestPromptVersion(fileNames, name) {
  const versions = fileNames
    .map((file) => file.match(new RegExp(`^${name}\\.v(\\d+)\\.md$`))?.[1])
    .filter(Boolean)
    .map(Number);
  return versions.length ? `${name}.v${Math.max(...versions)}` : null;
}

export const modelsFromEnv = (env) => ({
  spark: env.META_MODEL_SPARK || DEFAULT_MODELS.spark,
  sam: env.META_MODEL_SAM || DEFAULT_MODELS.sam,
  image: env.META_MODEL_IMAGE || DEFAULT_MODELS.image,
});

/** What the server says about itself (/api/health): whether models are mocked. */
export async function readHealth(base, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${base}/api/health`);
  } catch {
    throw new Error("cannot reach the app: start it with `node scripts/showcase-build.mjs serve`");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok !== true || typeof body.aiMock !== "boolean") throw new Error(`the app's health check failed (HTTP ${res.status})`);
  return { aiMock: body.aiMock };
}

/**
 * Run one set. `ctx`: { base, photosDir, outDir, budget, sceneTries, mock, log,
 * models, promptVersions, fetchImpl, sleep, pollMs, timeoutMs }.
 * Always writes <outDir>/run.json and returns { run, failures }; the caller exits non-zero on failures.
 */
export async function runSet(spec, ctx) {
  const { base, photosDir, outDir, budget, log } = ctx;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pollMs = ctx.pollMs ?? 1500;
  const timeoutMs = ctx.timeoutMs ?? 300_000;
  const sceneTries = ctx.sceneTries ?? 3;
  const secrets = [];
  const redact = makeRedactor(secrets);
  const say = (text) => log(redact(`[${spec.id}] ${text}`));
  const failures = [];
  const fail = (text) => {
    failures.push(redact(text));
    say(`FAILED ${text}`);
  };

  const missingPhotos = spec.friends.filter((f) => !existsSync(path.join(photosDir, f.photo)));
  if (missingPhotos.length) throw new Error(`photos not found in the photos folder: ${missingPhotos.map((f) => f.photo).join(", ")}`);
  mkdirSync(path.join(outDir, "photos"), { recursive: true });

  const t0 = Date.now();
  const run = {
    schema: 1,
    set: spec.id,
    title: spec.title,
    startedAt: new Date(t0).toISOString(),
    mock: Boolean(ctx.mock),
    models: ctx.models,
    promptVersions: { ...ctx.promptVersions },
    jobs: 0,
    friends: [],
    scenes: [],
    failures,
  };

  async function api(route, { method = "GET", cookie, json, form } = {}) {
    const res = await fetchImpl(`${base}${route}`, {
      method,
      headers: { origin: base, ...(cookie ? { cookie } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      body: form ?? (json !== undefined ? JSON.stringify(json) : undefined),
    });
    const text = await res.text();
    let body = {};
    try {
      body = JSON.parse(text);
    } catch {
      /* a non-JSON body: the status is enough */
    }
    return { res, body };
  }
  const httpError = (step, r) => new Error(redact(`${step}: HTTP ${r.res.status} ${typeof r.body?.error === "string" ? r.body.error : ""}`.trim()));

  async function pollUntil(label, step) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = await step();
      if (out.done) return out.value;
      if (Date.now() > deadline) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(pollMs);
    }
  }

  async function download(route, stem, cookie) {
    const res = await fetchImpl(`${base}${route}`, { headers: cookie ? { cookie } : {} });
    if (!res.ok) throw new Error(`download ${path.basename(stem)}: HTTP ${res.status}`);
    const ext = EXT[(res.headers.get("content-type") || "").split(";")[0].trim()];
    if (!ext) throw new Error(`download ${path.basename(stem)}: not an image`);
    writeFileSync(`${stem}${ext}`, Buffer.from(await res.arrayBuffer()));
    return path.basename(`${stem}${ext}`);
  }

  try {
    const created = await api("/api/boards", { method: "POST", json: { title: spec.title, themeId: spec.themeId || "paper" } });
    if (!created.res.ok) throw httpError("create board (10 per hour per server; restart it to reset)", created);
    const slug = created.body.board?.slug;
    if (!slug) throw new Error("create board: no board in the answer");
    secrets.push(slug);
    say("board created (slug withheld)");

    const cookies = {};
    const elements = []; // { id, friend, label, description, maskBox, faceFlag, files }

    for (const friend of spec.friends) {
      const joined = await api(`/api/boards/${slug}/participants`, { method: "POST", json: { displayName: friend.name } });
      if (!joined.res.ok) throw httpError(`join ${friend.name}`, joined);
      const cookie = cookieHeader(joined.res.headers.getSetCookie?.() ?? []);
      cookies[friend.name] = cookie;
      secrets.push(...cookie.split("; ").map((pair) => pair.slice(pair.indexOf("=") + 1)).filter((v) => v.length >= 8));

      const photoPath = path.join(photosDir, friend.photo);
      const photoExt = path.extname(friend.photo).toLowerCase();
      const photoFile = `photos/${slugify(friend.name)}${photoExt}`;
      copyFileSync(photoPath, path.join(outDir, photoFile));
      const record = { name: friend.name, photo: friend.photo, photoFile, status: "pending", attempts: [], faceNote: null, elements: [] };
      run.friends.push(record);

      // One retry: a photo failed once while two sets decomposed at once and worked on the second go (PIN-171).
      let view = null;
      for (let attempt = 1; attempt <= 2 && !view; attempt += 1) {
        budget.spend(`the photo of ${friend.name}`);
        run.jobs += 1;
        const form = new FormData();
        form.append("photo", new Blob([readFileSync(photoPath)], { type: MIME[photoExt] }), path.basename(friend.photo));
        const tStart = Date.now();
        const up = await api(`/api/boards/${slug}/photos`, { method: "POST", cookie, form });
        if (!up.res.ok) throw httpError(`upload ${friend.name}`, up);
        const jobId = up.body.job?.id;
        const polled = await pollUntil(`the photo of ${friend.name}`, async () => {
          const p = await api(`/api/boards/${slug}/jobs/${jobId}`, { cookie });
          if (!p.res.ok) throw httpError("job poll", p);
          return ENDED.has(p.body.job?.status) ? { done: true, value: p.body } : { done: false };
        });
        const usable = polled.job.status === "ready" && (polled.elements?.length ?? 0) > 0 && (polled.pins?.length ?? 0) > 0;
        record.attempts.push({
          status: polled.job.status,
          usable,
          errorCode: polled.job.errorCode ?? null,
          ms: Date.now() - tStart,
        });
        say(`${friend.name}: attempt ${attempt} ${polled.job.status}${polled.job.errorCode ? ` (${polled.job.errorCode})` : ""}${usable ? "" : " - no usable pin"}`);
        if (usable) view = polled;
        else if (polled.job.status === "refused") break; // a refusal is the answer; do not retry
      }
      record.status = view ? "ready" : record.attempts.at(-1)?.status === "refused" ? "refused" : "failed";
      if (!view) {
        fail(`${friend.name}: no usable pin from ${record.photo} (${record.attempts.map((a) => a.errorCode ?? a.status).join(", ")})`);
        continue;
      }
      record.faceNote = view.job.faceNote ?? null;

      // Keep the full candidate list: the scene picks come from it.
      const confirmed = await api(`/api/boards/${slug}/pins/confirm`, {
        method: "POST",
        cookie,
        json: { jobId: view.job.id, pinIds: view.pins.map((p) => p.id) },
      });
      if (!confirmed.res.ok) throw httpError(`confirm ${friend.name}`, confirmed);

      let n = 0;
      for (const e of view.elements) {
        const stem = path.join(outDir, `${slugify(friend.name)}-${n}-${slugify(e.label)}`);
        n += 1;
        const files = {
          cutout: await download(`/api/boards/${slug}/elements/${e.id}/image?kind=cutout`, `${stem}-cutout`, cookie),
          flat: await download(`/api/boards/${slug}/elements/${e.id}/image?kind=flattened`, `${stem}-flat`, cookie),
        };
        elements.push({ id: e.id, friend: friend.name, label: e.label, description: e.description, maskBox: e.maskBox, faceFlag: e.faceFlag, files });
        record.elements.push({ label: e.label, description: e.description, maskBox: e.maskBox, faceFlag: e.faceFlag, files });
      }
      say(`${friend.name}: ${record.elements.map((e) => e.label + (e.faceFlag ? " [face]" : "")).join(", ")}`);
    }

    for (const scene of spec.scenes) {
      const { ids, picked, missing } = resolveScenePicks(scene, elements);
      const entry = { id: scene.id, prompt: scene.prompt, picked, attempts: [], status: "skipped", kind: null, file: null };
      run.scenes.push(entry);
      if (missing.length) {
        // Never run it: Muse Image would draw the missing thing from the prompt text alone.
        fail(`scene ${scene.id}: no pin for ${missing.map((m) => `${m.friend} /${m.match}/`).join(", ")}`);
        continue;
      }
      const cookie = cookies[scene.as ?? spec.friends[0].name];
      let result = null;
      let refused = false; // the server said no outright: a limit or a bad request, not worth a retry
      for (let attempt = 1; attempt <= sceneTries && !result && !refused; attempt += 1) {
        budget.spend(`scene ${scene.id}`);
        run.jobs += 1;
        const tStart = Date.now();
        const posted = await api(`/api/boards/${slug}/scenes`, { method: "POST", cookie, json: { elementIds: ids, prompt: scene.prompt } });
        if (!posted.res.ok) {
          entry.attempts.push({ status: `http-${posted.res.status}`, ms: Date.now() - tStart });
          fail(`scene ${scene.id}: ${httpError("request", posted).message}`);
          refused = posted.res.status < 500;
          continue;
        }
        let card = posted.body.scene;
        if (card && !ENDED.has(card.status)) {
          card = await pollUntil(`scene ${scene.id}`, async () => {
            const p = await api(`/api/boards/${slug}/scenes/${card.id}`, { cookie });
            const s = p.body.scene;
            return s && ENDED.has(s.status) ? { done: true, value: s } : { done: false };
          });
        }
        const accepted = card?.status === "ready" && (card.kind === "ai" || ctx.mock);
        entry.attempts.push({
          status: card?.status ?? "unknown",
          kind: card?.kind ?? null,
          refusalReason: card?.refusalReason ?? null,
          errorCode: posted.body.job?.errorCode ?? null,
          ms: Date.now() - tStart,
        });
        say(`scene ${scene.id}: attempt ${attempt} ${card?.status} (${card?.kind})`);
        if (accepted) result = card;
      }
      const last = entry.attempts.at(-1);
      if (!result) {
        entry.status = last?.status ?? "skipped";
        entry.kind = last?.kind ?? null;
        if (!String(last?.status).startsWith("http-")) {
          const why = last?.status === "ready" ? `came back as ${last.kind}, not an AI scene` : `${last?.status}${last?.refusalReason ? ` (${last.refusalReason})` : ""}`;
          fail(`scene ${scene.id}: ${why} after ${entry.attempts.length} tries`);
        }
        continue;
      }
      entry.status = result.status;
      entry.kind = result.kind;
      entry.promptVersion = result.promptVersion ?? null;
      entry.width = result.width ?? null;
      entry.height = result.height ?? null;
      if (result.promptVersion) run.promptVersions.scene = result.promptVersion;
      entry.file = await download(`/api/boards/${slug}/scenes/${result.id}/image`, path.join(outDir, `scene-${slugify(scene.id)}`), cookie);
    }
  } catch (error) {
    fail(error instanceof BudgetError ? error.message : `stopped: ${error.message}`);
  } finally {
    run.totalMs = Date.now() - t0;
    writeFileSync(path.join(outDir, "run.json"), `${JSON.stringify(run, null, 1)}\n`);
  }
  return { run, failures };
}

/** Prompt template file names, for `latestPromptVersion`. */
export const listPromptFiles = (promptsDir) => (existsSync(promptsDir) ? readdirSync(promptsDir) : []);
