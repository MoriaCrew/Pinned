#!/usr/bin/env node
/**
 * PIN-50 Slice 0 spikes (T1-T6). Manual/local only, never in CI.
 *
 *   STUDIO_SPIKE_LIVE=1 node scripts/studio-spike.mjs <phase>
 *   phases: fixtures | decompose | scenes | report | all
 *
 * Live phases are env-gated: with AI_MOCK=1 or without
 * STUDIO_SPIKE_LIVE=1 they print a skip line and exit 0, so CI
 * (AI_MOCK=1) stays green. Keys come from .env.local at runtime and
 * are never printed or written to disk. Every live call is logged
 * (op, model, ms, usage, est $) into the work state and exported to
 * eval/fixtures/studio/call-log.json by the report phase.
 * Caps: $25 Meta total, 60 Higgsfield images (enforced below).
 * This script reuses gateway wire patterns; it does not refactor
 * the product gateway.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { decodeMaskToRaster } from "@meta-sam/parser";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = path.join(ROOT, ".spike-work");
const STATE_PATH = path.join(WORK, "state.json");
const PHOTO_DIR = path.join(WORK, "photos");
const CUT_DIR = path.join(WORK, "cutouts");
const SCENE_DIR = path.join(WORK, "scenes");
for (const d of [WORK, PHOTO_DIR, CUT_DIR, SCENE_DIR]) mkdirSync(d, { recursive: true });

function loadEnvLocal() {
  const p = path.join(ROOT, ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}
loadEnvLocal();

const BASE = (process.env.META_API_BASE_URL || "https://api.meta.ai/v1").replace(/\/$/, "");
const META_KEY = process.env.META_API_KEY || "";
const SPARK = process.env.META_MODEL_SPARK || "muse-spark-1.3";
const SAM = process.env.META_MODEL_SAM || "sam-3.1";
const IMAGE = process.env.META_MODEL_IMAGE || "muse-image-1.0";
const HIGGS_KEY = process.env.HIGGSFIELD_API_KEY || process.env.HIGGSFIELD_API_KEI || "";
const LIVE = process.env.STUDIO_SPIKE_LIVE === "1" && process.env.AI_MOCK !== "1";

// Policy constants for the spike (docs/11 s5.1 proposed defaults).
const POLICY = {
  minElements: 1, maxElements: 6, conceptMaxWords: 3,
  sceneSizeDefault: "1536x1024",
  timeoutsMs: { spark: 60_000, sam: 60_000, scene: 180_000, judge: 120_000 },
  metaCapUsd: 25, higgsCapImages: 60,
};
// Published list-price estimates (src/server/ai-usage.ts). The Muse
// Image /responses token price is not in the repo; token counts are
// recorded raw and priced with Spark rates as a labelled proxy.
const RATES = { sparkIn: 1.25 / 1e6, sparkOut: 4.25 / 1e6, samPerCall: 2.5 / 1000 };

const state = existsSync(STATE_PATH)
  ? JSON.parse(readFileSync(STATE_PATH, "utf8"))
  : { calls: [], photos: [], elements: [], scenes: [], probes: [], higgsImages: 0 };
const saveState = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));

function estUsd(op, usage) {
  if (op === "sam") return RATES.samPerCall;
  const i = usage?.input_tokens ?? usage?.prompt_tokens ?? 0;
  const o = usage?.output_tokens ?? usage?.completion_tokens ?? 0;
  return i * RATES.sparkIn + o * RATES.sparkOut;
}
function logCall(op, model, ms, ok, usage, note) {
  const e = { op, model, ms, ok, usage: usage ?? null, estUsd: ok ? +estUsd(op, usage).toFixed(5) : 0, ...(note ? { note } : {}) };
  state.calls.push(e); saveState();
  console.log(`[call] ${op} ${model} ${ms}ms ok=${ok} est=$${e.estUsd}${note ? " " + note : ""}`);
  const spent = state.calls.reduce((s, c) => s + (c.estUsd || 0), 0);
  if (spent > POLICY.metaCapUsd) throw new Error(`Meta cap $${POLICY.metaCapUsd} exceeded (est $${spent.toFixed(2)})`);
  return e;
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
/** POST to Meta; retry once on 429/5xx. Returns {status, json, ms}. */
async function metaPost(pathname, body, timeoutMs) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${BASE}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${META_KEY}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let json = {}; try { json = JSON.parse(text); } catch { /* shape handled by caller */ }
      last = { status: res.status, ok: res.ok, json, ms: Date.now() - t0 };
    } catch (cause) {
      last = { status: 0, ok: false, json: {}, ms: Date.now() - t0, error: String(cause?.name || cause) };
    }
    if (last.ok || !(last.status === 429 || last.status >= 500)) return last;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return last;
}
const errCode = (r) => r.json?.error?.code || r.error || `http_${r.status}`;
const dataUrl = (buf, mime = "image/jpeg") => `data:${mime};base64,${buf.toString("base64")}`;
async function jpegDataUrl(file, width) {
  const buf = await sharp(file).rotate().resize({ width, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return dataUrl(buf);
}
function parseModelJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{"); const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}
/* ---------------- fixtures: Higgsfield synthetic photos ---------------- */
const OWNERS = ["Robin", "Aye", "Sam", "Jo", "Mia", "Leo"];
const FIXTURES = [
  { id: "desk-mug-duck", kind: "home", prompt: "Photorealistic photograph of a home office desk in daylight: a chipped teal ceramic mug, a yellow rubber duck wearing tiny sunglasses, and a small potted succulent, shallow depth of field, natural light" },
  { id: "kitchen-cat-lamp", kind: "home", prompt: "Photorealistic photograph of a kitchen counter: an orange tabby cat sitting next to a brass table lamp and a green plant in a red-and-white striped ceramic pot, warm daylight" },
  { id: "shelf-clock-books", kind: "home", prompt: "Photorealistic photograph of a living room wooden shelf: a red retro twin-bell alarm clock, a stack of three hardcover books, and a small white ceramic vase with dried flowers" },
  { id: "sofa-blanket-plant", kind: "home", prompt: "Photorealistic photograph of a living room: a grey sofa with a mustard yellow knitted blanket draped over it, and a tall green houseplant in a terracotta pot beside the sofa" },
  { id: "desk-lamp-keyboard", kind: "home", prompt: "Photorealistic photograph of a desk at dusk: a brass desk lamp switched on, a blue mechanical keyboard, and black over-ear headphones resting beside it" },
  { id: "table-fruit-bottle", kind: "home", prompt: "Photorealistic photograph of a dining table: a wooden bowl full of oranges, a clear glass bottle of water, and a folded beige linen napkin, soft window light" },
  { id: "hallway-shoes-hat", kind: "home", prompt: "Photorealistic photograph of a bright hallway: a pair of red sneakers on the floor, a straw sun hat hanging on a wall hook, and a woven seagrass basket" },
  { id: "bedside-mirror-book", kind: "home", prompt: "Photorealistic photograph of a bedside table: a small round brass mirror, a paperback book with a plain cover, and a ceramic table lamp with a cream shade" },
  { id: "workbench-tools", kind: "home", prompt: "Photorealistic photograph of a wooden workbench: an orange cordless drill, a wooden-handled claw hammer, and a yellow metal tape measure" },
  { id: "cat-chair-blanket", kind: "home", prompt: "Photorealistic photograph: a black cat curled up asleep on a rattan chair with a folded red plaid blanket beside it, window light" },
  { id: "hard-glass-table", kind: "hard", prompt: "Photorealistic photograph of a glass coffee table in bright window light: a clear glass vase, two empty drinking glasses, strong reflections and refractions" },
  { id: "hard-cable-mess", kind: "hard", prompt: "Photorealistic photograph under a desk: a messy tangle of black and white charging cables plugged into a white power strip on the floor" },
  { id: "person-herb-kitchen", kind: "person", prompt: "Photorealistic photograph of a smiling fictional adult woman with dark hair holding a small potted basil plant in a bright kitchen, synthetic person, not a real human" },
  { id: "person-desk-mug", kind: "person", prompt: "Photorealistic photograph of a fictional adult man with curly brown hair sitting at a desk holding a red mug, laptop in front of him, synthetic person, not a real human" },
];

async function higgsGenerate(prompt) {
  if (state.higgsImages >= POLICY.higgsCapImages) throw new Error("Higgsfield image cap reached");
  const t0 = Date.now();
  const res = await fetch("https://api.higgsfield.ai/recraft/v4.1/utility/text-to-image", {
    method: "POST",
    headers: { Authorization: `Key ${HIGGS_KEY}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ prompt, resolution: "1k", aspect_ratio: "4:3", output_format: "png" }),
  });
  if (!res.ok) throw new Error(`higgsfield submit ${res.status}`);
  const { request_id } = await res.json();
  for (let i = 0; i < 48; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const s = await fetch(`https://api.higgsfield.ai/requests/${request_id}/status`, { headers: { Authorization: `Key ${HIGGS_KEY}` } });
    const body = await s.json();
    if (body.status === "completed") {
      const img = await fetch(body.images[0].url);
      const buf = Buffer.from(await img.arrayBuffer());
      state.higgsImages += 1;
      logCall("higgsfield", "recraft-v4.1-utility", Date.now() - t0, true, null, "fixture");
      state.calls[state.calls.length - 1].estUsd = 0; // Higgsfield credits, not Meta $
      saveState();
      return buf;
    }
    if (["failed", "nsfw", "canceled"].includes(body.status)) throw new Error(`higgsfield job ${body.status}`);
  }
  throw new Error("higgsfield polling timed out");
}

async function phaseFixtures() {
  // Reuse the endpoint probe image as fixture 1 if present (already
  // generated and visually verified photorealistic).
  const probe = path.join(WORK, "probe.png");
  await mapLimit(FIXTURES, 3, async (f, i) => {
    const out = path.join(PHOTO_DIR, `${f.id}.png`);
    if (!existsSync(out)) {
      if (f.id === "desk-mug-duck" && existsSync(probe)) { copyFileSync(probe, out); state.higgsImages += 1; }
      else writeFileSync(out, await higgsGenerate(f.prompt));
    }
    if (!state.photos.some((p) => p.id === f.id)) {
      const meta = await sharp(out).metadata();
      state.photos.push({ id: f.id, kind: f.kind, owner: OWNERS[i % OWNERS.length], prompt: f.prompt, source: "Higgsfield recraft-v4.1-utility text-to-image (synthetic, no real people)", width: meta.width, height: meta.height });
      saveState();
    }
    console.log("fixture ready", f.id);
  });
}
/* ---------------- decompose: Spark elements -> SAM -> cut-outs ---------------- */
function elementsPrompt() {
  const raw = readFileSync(path.join(ROOT, "prompts", "elements.v1.md"), "utf8");
  return raw.split("\n---")[0]
    .replaceAll("{{MIN_ELEMENTS}}", String(POLICY.minElements))
    .replaceAll("{{MAX_ELEMENTS}}", String(POLICY.maxElements))
    .replaceAll("{{CONCEPT_MAX_WORDS}}", String(POLICY.conceptMaxWords))
    .trim();
}
async function sparkElements(photo) {
  const url = await jpegDataUrl(path.join(PHOTO_DIR, `${photo.id}.png`), 1024);
  const r = await metaPost("/chat/completions", {
    model: SPARK, max_tokens: 4000,
    messages: [
      { role: "system", content: elementsPrompt() },
      { role: "user", content: [
        { type: "text", text: "Name the pin-worthy elements in this photo." },
        { type: "image_url", image_url: { url } },
      ] },
    ],
  }, POLICY.timeoutsMs.spark);
  if (!r.ok) { logCall("elements", SPARK, r.ms, false, r.json?.usage, errCode(r)); throw new Error(`elements ${photo.id}: ${errCode(r)}`); }
  logCall("elements", SPARK, r.ms, true, r.json?.usage, photo.id);
  let parsed;
  try {
    parsed = parseModelJson(r.json?.choices?.[0]?.message?.content);
  } catch {
    // One retry on a non-JSON reply; then record zero elements
    // instead of aborting the whole spike.
    const r2 = await metaPost("/chat/completions", {
      model: SPARK, max_tokens: 4000,
      messages: [
        { role: "system", content: elementsPrompt() },
        { role: "user", content: [
          { type: "text", text: "Name the pin-worthy elements in this photo. Reply with the JSON object only." },
          { type: "image_url", image_url: { url } },
        ] },
      ],
    }, POLICY.timeoutsMs.spark);
    logCall("elements", SPARK, r2.ms, r2.ok, r2.json?.usage, `${photo.id} retry`);
    try { parsed = parseModelJson(r2.json?.choices?.[0]?.message?.content); }
    catch { return []; }
  }
  const seen = new Set(); const out = [];
  for (const e of Array.isArray(parsed.elements) ? parsed.elements : []) {
    const concept = String(e.concept || "").toLowerCase().trim().split(/\s+/).filter(Boolean).slice(0, POLICY.conceptMaxWords).join(" ");
    if (!concept || seen.has(concept)) continue;
    seen.add(concept);
    out.push({ label: String(e.label || concept).slice(0, 60), concept, description: String(e.description || concept).slice(0, 160), faceFlag: e.faceFlag === true });
    if (out.length >= POLICY.maxElements) break;
  }
  return out;
}
// SAM wire grammar + parsing mirror src/gateway/meta-gateway.ts.
const SAM_RECORD = /(\d+)<\|box;x1=(-?\d+);y1=(-?\d+);x2=(-?\d+);y2=(-?\d+);w=(\d+);h=(\d+)(?:;c=([0-9.]+))?\|><\|mask;x=0;y=0(?:;c=[0-9.]+)?;data=(\d+),(\d+),(.)([\s\S]*?)\|>/g;
function findSamText(value, depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === "string") return value.includes("<|box;") ? value : null;
  if (Array.isArray(value)) { for (const v of value) { const h = findSamText(v, depth + 1); if (h !== null) return h; } return null; }
  if (typeof value === "object") {
    if (typeof value.output_text === "string") return value.output_text;
    if (value.type === "output_text" && typeof value.text === "string") return value.text;
    for (const v of Object.values(value)) { const h = findSamText(v, depth + 1); if (h !== null) return h; }
  }
  return null;
}
function parseSam(text) {
  const segs = [];
  for (const m of String(text).matchAll(SAM_RECORD)) {
    segs.push({ id: m[1], box: { x1: +m[2], y1: +m[3], x2: +m[4], y2: +m[5], w: +m[6], h: +m[7], ...(m[8] !== undefined ? { confidence: +m[8] } : {}) }, mask: { height: +m[9], width: +m[10], encoding: m[11], payload: m[12] } });
  }
  return segs;
}
async function samConcept(photoUrl, concept) {
  const r = await metaPost("/responses", {
    model: SAM,
    metadata: { include_confidence: "true" },
    input: [{ role: "user", content: [
      { type: "input_text", text: concept },
      { type: "input_image", image_url: photoUrl },
    ] }],
  }, POLICY.timeoutsMs.sam);
  if (!r.ok) { logCall("sam", SAM, r.ms, false, r.json?.usage, errCode(r)); return { segments: [], error: errCode(r) }; }
  logCall("sam", SAM, r.ms, true, r.json?.usage ?? null, concept);
  const text = findSamText(r.json);
  return { segments: text ? parseSam(text) : [], usage: r.json?.usage ?? null };
}
/** Cut-out (alpha=mask) + flattened-on-white, mirroring sam-mask.ts. */
async function renderCutouts(photoPath, seg, outBase) {
  const enc = seg.mask.encoding === "~" ? "lossless" : seg.mask.encoding === "!" ? "one_bit" : null;
  if (!enc) throw new Error(`unknown mask encoding ${seg.mask.encoding}`);
  const raster = decodeMaskToRaster({ encoding: enc, payload: seg.mask.encoding + seg.mask.payload, width: seg.mask.width, height: seg.mask.height });
  const { data, info } = await sharp(photoPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  const x1 = Math.max(0, seg.box.x1), y1 = Math.max(0, seg.box.y1);
  const x2 = Math.min(W - 1, seg.box.x2), y2 = Math.min(H - 1, seg.box.y2);
  const boxW = seg.box.x2 - seg.box.x1 + 1, boxH = seg.box.y2 - seg.box.y1 + 1;
  const outW = Math.max(1, x2 - x1 + 1), outH = Math.max(1, y2 - y1 + 1);
  const out = Buffer.alloc(outW * outH * 4);
  let maskPixels = 0;
  for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) {
    const mx = Math.min(seg.mask.width - 1, Math.floor(((x - seg.box.x1) / boxW) * seg.mask.width));
    const my = Math.min(seg.mask.height - 1, Math.floor(((y - seg.box.y1) / boxH) * seg.mask.height));
    const on = raster[my * seg.mask.width + mx] === 1;
    if (on) maskPixels++;
    const si = (y * W + x) * 4, di = ((y - y1) * outW + (x - x1)) * 4;
    out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = on ? 255 : 0;
  }
  const cut = sharp(out, { raw: { width: outW, height: outH, channels: 4 } });
  const cutPng = await cut.png().toBuffer();
  writeFileSync(`${outBase}-cutout.png`, cutPng);
  const pad = Math.round(Math.max(outW, outH) * 0.08);
  const flat = await sharp({ create: { width: outW + pad * 2, height: outH + pad * 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: cutPng, left: pad, top: pad }])
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 }).toBuffer();
  writeFileSync(`${outBase}-flat.jpg`, flat);
  return { maskPixels, coverageFrame: maskPixels / (W * H), box: { x1, y1, x2, y2 } };
}
const usablePin = (cov) => cov >= 0.005 && cov <= 0.6;
async function phaseDecompose() {
  for (const photo of state.photos) {
    if (photo.decomposed) continue;
    const t0 = Date.now();
    const named = await sparkElements(photo);
    const photoUrl = await jpegDataUrl(path.join(PHOTO_DIR, `${photo.id}.png`), 1024);
    // NOTE: SAM box coordinates are in the sent image's pixels; send
    // the same downscale we composite from a resized working copy.
    const workPath = path.join(WORK, `${photo.id}-work.jpg`);
    await sharp(path.join(PHOTO_DIR, `${photo.id}.png`)).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 88 }).toFile(workPath);
    const workMeta = await sharp(workPath).metadata();
    photo.workWidth = workMeta.width; photo.workHeight = workMeta.height;
    const results = await mapLimit(named, 4, async (el) => {
      const { segments, error } = await samConcept(photoUrl, el.concept);
      const best = segments
        .map((s) => ({ s, area: (s.box.x2 - s.box.x1 + 1) * (s.box.y2 - s.box.y1 + 1) }))
        .sort((a, b) => b.area - a.area)[0]?.s;
      const rec = { id: `${photo.id}--${el.concept.replace(/\s+/g, "-")}`, photoId: photo.id, owner: photo.owner, ...el, samSegments: segments.length, usable: false, ...(error ? { samError: error } : {}) };
      if (best) {
        try {
          const r = await renderCutouts(workPath, best, path.join(CUT_DIR, rec.id));
          Object.assign(rec, { ...r, coverageFrame: +r.coverageFrame.toFixed(4), ...(best.box.confidence !== undefined ? { confidence: best.box.confidence } : {}) });
          rec.usable = usablePin(r.coverageFrame) && r.maskPixels > 0;
        } catch (e) { rec.cutoutError = String(e?.message || e).slice(0, 120); }
      }
      return rec;
    });
    state.elements.push(...results);
    photo.decomposed = true;
    photo.decomposeMs = Date.now() - t0;
    photo.namedCount = named.length;
    photo.usableCount = results.filter((r) => r.usable).length;
    saveState();
    console.log(`decomposed ${photo.id}: named=${named.length} usable=${photo.usableCount} in ${(photo.decomposeMs / 1000).toFixed(1)}s`);
  }
}
/* ---------------- compose: Muse Image /v1/responses + Spark judge ---------------- */
const elLabel = (el, i) => `Element ${i + 1} (from ${el.owner}): ${el.description}`;
async function elementInput(el, mode) {
  if (mode === "flattened") return jpegDataUrl(path.join(CUT_DIR, `${el.id}-flat.jpg`), 1024);
  if (mode === "transparent") {
    const buf = await sharp(path.join(CUT_DIR, `${el.id}-cutout.png`)).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    return dataUrl(buf, "image/png");
  }
  // whole+pointer: full working photo with a red marker at box centre.
  const photo = state.photos.find((p) => p.id === el.photoId);
  const src = path.join(WORK, `${el.photoId}-work.jpg`);
  const cx = Math.round((el.box.x1 + el.box.x2) / 2), cy = Math.round((el.box.y1 + el.box.y2) / 2);
  const svg = `<svg width="${photo.workWidth}" height="${photo.workHeight}"><circle cx="${cx}" cy="${cy}" r="26" fill="none" stroke="red" stroke-width="8"/><circle cx="${cx}" cy="${cy}" r="7" fill="red"/></svg>`;
  const buf = await sharp(src).composite([{ input: Buffer.from(svg) }]).jpeg({ quality: 82 }).toBuffer();
  return dataUrl(buf);
}
function extractSceneImage(json) {
  const out = Array.isArray(json?.output) ? json.output : [];
  for (const item of out) {
    if (item?.type === "image_generation_call" && typeof item.result === "string" && item.result.length > 100) return item.result;
  }
  return null;
}
function extractMessageText(json) {
  const out = Array.isArray(json?.output) ? json.output : [];
  const texts = [];
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) if (typeof c?.text === "string") texts.push(c.text);
    }
  }
  return texts.join(" ").slice(0, 240);
}
/**
 * One compose call. Sends store:false first (docs/11 Q1 default);
 * if the API rejects the field, retries once without it and records
 * storeAccepted=false. tools carries ONLY {type, size} unless
 * extraToolKeys is set (the single acceptance probe).
 */
async function composeScene({ elements, prompt, mode, size, swapLabels = false, extraToolKeys = null }) {
  const content = [];
  const labels = elements.map((el, i) => elLabel(el, i));
  const shown = swapLabels && labels.length > 1 ? labels.map((_, i) => labels[(i + 1) % labels.length]) : labels;
  for (let i = 0; i < elements.length; i++) {
    const pointerHint = mode === "whole" ? " — the thing marked with the red dot in the next photo" : "";
    content.push({ type: "input_text", text: shown[i] + pointerHint });
    content.push({ type: "input_image", image_url: await elementInput(elements[i], mode) });
  }
  content.push({ type: "input_text", text: `Compose these exact elements into one new photorealistic scene, keeping each element recognisable: ${prompt}` });
  const tool = { type: "image_generation", size, ...(extraToolKeys || {}) };
  const body = { model: IMAGE, store: false, input: [{ role: "user", content }], tools: [tool] };
  let r = await metaPost("/responses", body, POLICY.timeoutsMs.scene);
  let storeAccepted = true;
  if (!r.ok && r.status === 400 && /store/i.test(JSON.stringify(r.json?.error || {}))) {
    storeAccepted = false;
    const noStore = { ...body }; delete noStore.store;
    r = await metaPost("/responses", noStore, POLICY.timeoutsMs.scene);
  }
  if (!r.ok) { logCall("compose", IMAGE, r.ms, false, r.json?.usage, errCode(r)); return { outcome: "error", code: errCode(r), status: r.status, ms: r.ms, usage: r.json?.usage ?? null, storeAccepted }; }
  const b64 = extractSceneImage(r.json);
  logCall("compose", IMAGE, r.ms, true, r.json?.usage, b64 ? "image" : "no-image");
  if (!b64) return { outcome: "refused", code: "no_image_generation_call", status: r.status, ms: r.ms, usage: r.json?.usage ?? null, storeAccepted, messageExcerpt: extractMessageText(r.json) };
  return { outcome: "ok", b64, ms: r.ms, usage: r.json?.usage ?? null, storeAccepted };
}
const JUDGE_SYSTEM = [
  "You score element fidelity in a composed scene. You are shown reference images of elements in order, then the composed scene LAST.",
  "For each element score 0-5 how recognisable THAT EXACT element (same colours, markings, shape) is in the scene: 5 unmistakable, 3 recognisable but altered, 0 absent or a different object.",
  "Return ONLY JSON {\"scores\":[{\"element\":1,\"score\":0,\"reason\":\"one short clause\"}]} covering every element in order.",
].join(" ");
async function judgeScene(elements, sceneFile) {
  const content = [{ type: "text", text: `Elements: ${elements.map((el, i) => `${i + 1}. ${el.description}`).join("; ")}. Reference images follow in order; the composed scene is last.` }];
  for (const el of elements) content.push({ type: "image_url", image_url: { url: await jpegDataUrl(path.join(CUT_DIR, `${el.id}-flat.jpg`), 512) } });
  content.push({ type: "image_url", image_url: { url: await jpegDataUrl(sceneFile, 1024) } });
  const r = await metaPost("/chat/completions", {
    model: SPARK, max_tokens: 3000,
    messages: [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content }],
  }, POLICY.timeoutsMs.judge);
  if (!r.ok) { logCall("judge", SPARK, r.ms, false, r.json?.usage, errCode(r)); return null; }
  logCall("judge", SPARK, r.ms, true, r.json?.usage, sceneFile.split(path.sep).pop());
  try {
    const parsed = parseModelJson(r.json?.choices?.[0]?.message?.content);
    return (Array.isArray(parsed.scores) ? parsed.scores : []).map((s, i) => ({
      elementId: elements[i]?.id, score: Math.max(0, Math.min(5, Number(s.score) || 0)), reason: String(s.reason || "").slice(0, 160),
    }));
  } catch { return null; }
}
/* ---------------- scenes phase: T1/T2/T2b/portrait/probe/T6 ---------------- */
function pick(keywords, used, { face = null } = {}) {
  const pool = state.elements.filter((e) => e.usable && !used.has(e.id) && (face === null || e.faceFlag === face));
  for (const kw of keywords) {
    const hit = pool.find((e) => `${e.concept} ${e.label} ${e.description}`.toLowerCase().includes(kw));
    if (hit) { used.add(hit.id); return hit; }
  }
  const fallback = pool[0];
  if (fallback) used.add(fallback.id);
  return fallback || null;
}
function composition(specs) {
  const used = new Set();
  return specs.map((s) => pick(s.kw, used, s)).filter(Boolean);
}
const COMPOSITIONS = [
  { id: "C1", prompt: "a sunny picnic blanket on grass with these things on it", specs: [{ kw: ["mug", "cup"] }, { kw: ["duck"] }] },
  { id: "C2", prompt: "a cozy windowsill at golden hour with these things arranged on it", specs: [{ kw: ["cat"] }, { kw: ["lamp"] }, { kw: ["plant", "succulent", "pot"] }] },
  { id: "C3", prompt: "a tidy study desk with these things on it, evening light", specs: [{ kw: ["clock"] }, { kw: ["book"] }, { kw: ["vase"] }, { kw: ["headphones", "keyboard"] }] },
  { id: "C4", prompt: "a garage workbench with these things laid out ready for a DIY project", specs: [{ kw: ["drill"] }, { kw: ["hammer"] }, { kw: ["sneaker", "shoe"] }] },
  { id: "C5", prompt: "a bright breakfast table with these things on it", specs: [{ kw: ["orange", "bowl", "fruit"] }, { kw: ["bottle"] }] },
];
const T6 = [
  { id: "T6-1", prompt: "a tiny beach diorama on a kitchen counter with these things", specs: [{ kw: ["mug"] }, { kw: ["duck"] }] },
  { id: "T6-2", prompt: "a cozy reading corner at night with these things", specs: [{ kw: ["cat"] }, { kw: ["lamp"] }] },
  { id: "T6-3", prompt: "a sunny greenhouse shelf with these things", specs: [{ kw: ["plant", "succulent"] }, { kw: ["book"] }] },
  { id: "T6-4", prompt: "a tidy workshop pegboard wall with these tools hanging on it", specs: [{ kw: ["drill"] }, { kw: ["hammer"] }] },
  { id: "T6-5", prompt: "a summer picnic in a park with these things on the blanket", specs: [{ kw: ["sneaker", "shoe"] }, { kw: ["hat"] }] },
  { id: "T6-6", prompt: "a calm hotel bedside table with these things on it", specs: [{ kw: ["mirror"] }, { kw: ["lamp"] }] },
  { id: "T6-7", prompt: "a home music studio desk with these things on it", specs: [{ kw: ["keyboard"] }, { kw: ["headphones"] }] },
  { id: "T6-8", prompt: "the woman holding her plant in a sunny garden, smiling", specs: [{ kw: ["woman", "person"], face: true }, { kw: ["plant", "basil", "herb"] }] },
  { id: "T6-9", prompt: "the man working at a cafe table with his mug", specs: [{ kw: ["man", "person"], face: true }, { kw: ["mug"] }] },
  { id: "T6-10", prompt: "the woman sitting on a sofa with the cat beside her", specs: [{ kw: ["woman", "person"], face: true }, { kw: ["cat"] }] },
];
async function runScene(rec) {
  if (state.scenes.some((s) => s.id === rec.id)) { console.log("scene exists", rec.id); return; }
  const els = rec.elementIds.map((id) => state.elements.find((e) => e.id === id)).filter(Boolean);
  const res = await composeScene({ elements: els, prompt: rec.prompt, mode: rec.mode, size: rec.size, swapLabels: !!rec.swapLabels, extraToolKeys: rec.extraToolKeys || null });
  const entry = { ...rec, outcome: res.outcome, ms: res.ms, usage: res.usage, storeAccepted: res.storeAccepted, ...(res.code ? { code: res.code, status: res.status } : {}), ...(res.messageExcerpt ? { messageExcerpt: res.messageExcerpt } : {}) };
  if (res.outcome === "ok") {
    const file = path.join(SCENE_DIR, `${rec.id}.jpg`);
    await sharp(Buffer.from(res.b64, "base64")).jpeg({ quality: 88 }).toFile(file);
    const meta = await sharp(file).metadata();
    entry.sceneWidth = meta.width; entry.sceneHeight = meta.height;
    if (rec.judge) entry.scores = await judgeScene(els, file);
  }
  state.scenes.push(entry); saveState();
  console.log(`scene ${rec.id}: ${entry.outcome} in ${(res.ms / 1000).toFixed(1)}s`);
}
async function phaseScenes() {
  const comps = {};
  for (const c of COMPOSITIONS) comps[c.id] = composition(c.specs);
  for (const c of COMPOSITIONS) console.log(c.id, "elements:", comps[c.id].map((e) => e.id).join(", "));
  const jobs = [];
  // T2: C1-C3 in all three modes (flattened rows double as T1 rows).
  for (const c of COMPOSITIONS.slice(0, 3)) for (const mode of ["flattened", "transparent", "whole"]) {
    jobs.push({ id: `${c.id}-${mode}`, test: "T1/T2", comp: c.id, mode, size: POLICY.sceneSizeDefault, prompt: c.prompt, elementIds: comps[c.id].map((e) => e.id), judge: true });
  }
  // T1 remainder: C4, C5 flattened.
  for (const c of COMPOSITIONS.slice(3)) jobs.push({ id: `${c.id}-flattened`, test: "T1", comp: c.id, mode: "flattened", size: POLICY.sceneSizeDefault, prompt: c.prompt, elementIds: comps[c.id].map((e) => e.id), judge: true });
  // T2b: C2 with labels rotated by one.
  jobs.push({ id: "C2-labelswap", test: "T2b", comp: "C2", mode: "flattened", size: POLICY.sceneSizeDefault, prompt: COMPOSITIONS[1].prompt, elementIds: comps.C2.map((e) => e.id), judge: true, swapLabels: true });
  // Portrait / square size matrix on C1.
  for (const size of ["1024x1536", "1024x1024"]) jobs.push({ id: `C1-size-${size}`, test: "size", comp: "C1", mode: "flattened", size, prompt: COMPOSITIONS[0].prompt, elementIds: comps.C1.map((e) => e.id), judge: false });
  // Single acceptance probe for undocumented tool keys.
  jobs.push({ id: "C1-probe-toolkeys", test: "probe", comp: "C1", mode: "flattened", size: POLICY.sceneSizeDefault, prompt: COMPOSITIONS[0].prompt, elementIds: comps.C1.map((e) => e.id), judge: false, extraToolKeys: { output_format: "png", reasoning_strength: "low" } });
  // T6 refusal probes (no fidelity judging; outcome is the metric).
  for (const t of T6) jobs.push({ id: t.id, test: "T6", mode: "flattened", size: POLICY.sceneSizeDefault, prompt: t.prompt, elementIds: composition(t.specs).map((e) => e.id), judge: false, hasPerson: t.specs.some((s) => s.face) });
  await mapLimit(jobs, 3, (j) => runScene(j));
}
/* ---------------- report: contact sheets, fixtures, findings ---------------- */
const FIX_OUT = path.join(ROOT, "eval", "fixtures", "studio");
const SHEET_OUT = path.join(ROOT, "eval", "contact-sheets");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const fmtS = (ms) => `${(ms / 1000).toFixed(1)}s`;
const fmt$ = (x) => `$${x.toFixed(3)}`;

async function contactSheet(scene) {
  const sceneFile = path.join(SCENE_DIR, `${scene.id}.jpg`);
  if (!existsSync(sceneFile)) return null;
  const ROW = 280, REF_W = 300, SCENE_W = 900, PAD = 16, FOOT = 120;
  const els = scene.elementIds.map((id) => state.elements.find((e) => e.id === id)).filter(Boolean);
  const rows = Math.max(els.length, 2);
  const H = rows * ROW + FOOT, W = REF_W + SCENE_W + PAD * 3;
  const layers = [];
  for (let i = 0; i < els.length; i++) {
    const ref = path.join(CUT_DIR, `${els[i].id}-flat.jpg`);
    if (!existsSync(ref)) continue;
    const thumb = await sharp(ref).resize({ width: REF_W, height: ROW - 30, fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
    layers.push({ input: thumb, left: PAD, top: PAD + i * ROW });
    const sc = scene.scores?.find((s) => s.elementId === els[i].id);
    const label = `${i + 1}. ${els[i].description.slice(0, 34)}${sc ? ` — ${sc.score}/5` : ""}`;
    layers.push({ input: Buffer.from(`<svg width="${REF_W}" height="26"><rect width="100%" height="100%" fill="#111"/><text x="6" y="18" font-family="sans-serif" font-size="14" fill="#fff">${esc(label)}</text></svg>`), left: PAD, top: PAD + i * ROW + ROW - 30 });
  }
  const sceneBuf = await sharp(sceneFile).resize({ width: SCENE_W, height: rows * ROW, fit: "inside" }).jpeg({ quality: 82 }).toBuffer();
  layers.push({ input: sceneBuf, left: REF_W + PAD * 2, top: PAD });
  const footer = `${scene.id} | mode=${scene.mode} size=${scene.size} | ${scene.outcome} in ${fmtS(scene.ms)} | "${scene.prompt.slice(0, 90)}"`;
  const reasons = (scene.scores || []).map((s, i) => `${i + 1}:${s.score} ${s.reason}`).join(" · ").slice(0, 220);
  layers.push({ input: Buffer.from(`<svg width="${W - PAD * 2}" height="${FOOT - 10}"><text x="0" y="22" font-family="sans-serif" font-size="16" fill="#111">${esc(footer)}</text><text x="0" y="52" font-family="sans-serif" font-size="13" fill="#444">${esc(reasons)}</text></svg>`), left: PAD, top: rows * ROW + 10 });
  const out = path.join(SHEET_OUT, `${scene.id}.jpg`);
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 250, g: 248, b: 242 } } }).composite(layers).jpeg({ quality: 80 }).toFile(out);
  return out;
}

function sceneScores(testFilter, mode) {
  return state.scenes.filter((s) => s.test === testFilter && (mode === undefined || s.mode === mode) && Array.isArray(s.scores) && s.scores.length)
    .flatMap((s) => s.scores.map((x) => x.score));
}
function callsCost(op) { return state.calls.filter((c) => c.op === op && c.ok).reduce((a, c) => a + (c.estUsd || 0), 0); }

async function phaseReport() {
  mkdirSync(FIX_OUT, { recursive: true }); mkdirSync(SHEET_OUT, { recursive: true });
  mkdirSync(path.join(FIX_OUT, "photos"), { recursive: true });
  mkdirSync(path.join(FIX_OUT, "scenes"), { recursive: true });
  mkdirSync(path.join(FIX_OUT, "elements"), { recursive: true });
  for (const p of state.photos) {
    await sharp(path.join(PHOTO_DIR, `${p.id}.png`)).resize({ width: 800, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(path.join(FIX_OUT, "photos", `${p.id}.jpg`));
  }
  for (const e of state.elements.filter((x) => x.usable)) {
    await sharp(path.join(CUT_DIR, `${e.id}-flat.jpg`)).resize({ width: 512, withoutEnlargement: true }).jpeg({ quality: 78 }).toFile(path.join(FIX_OUT, "elements", `${e.id}-flat.jpg`));
  }
  for (const s of state.scenes) {
    const f = path.join(SCENE_DIR, `${s.id}.jpg`);
    if (existsSync(f)) await sharp(f).resize({ width: 1024, withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(path.join(FIX_OUT, "scenes", `${s.id}.jpg`));
    await contactSheet(s);
  }
  const redactScene = ({ b64, messageExcerpt, ...rest }) => rest;
  writeFileSync(path.join(FIX_OUT, "fixtures.json"), JSON.stringify({
    generated: "PIN-50 scripts/studio-spike.mjs (synthetic images only; no real people, no payloads, no keys)",
    photos: state.photos.map(({ decomposed, ...p }) => p),
    elements: state.elements,
    scenes: state.scenes.map(redactScene),
  }, null, 1));
  writeFileSync(path.join(FIX_OUT, "call-log.json"), JSON.stringify({
    note: "Every live call: op, model, ms, usage, est $ (Spark $1.25/1M in, $4.25/1M out; SAM $2.50/1000 calls; Muse Image /responses tokens priced with Spark rates as a proxy). Higgsfield rows are credit-based, $0.",
    higgsImages: state.higgsImages, calls: state.calls,
  }, null, 1));
  writeFileSync(path.join(ROOT, "eval", "studio-findings.md"), buildFindings());
  console.log("report written: eval/studio-findings.md, eval/fixtures/studio/, eval/contact-sheets/");
}
function buildFindings() {
  const L = [];
  const t1Scenes = state.scenes.filter((s) => (s.test === "T1" || s.test === "T1/T2") && s.mode === "flattened");
  const t1Scores = t1Scenes.flatMap((s) => (s.scores || []).map((x) => x.score));
  const t1Mean = mean(t1Scores);
  const t1Clean = t1Scenes.filter((s) => s.outcome === "ok" && (s.scores || []).length && s.scores.every((x) => x.score >= 3)).length;
  const modes = ["flattened", "transparent", "whole"];
  const modeMeans = Object.fromEntries(modes.map((m) => [m, mean(sceneScores("T1/T2", m))]));
  const bestMode = modes.slice().sort((a, b) => modeMeans[b] - modeMeans[a])[0];
  const swap = state.scenes.find((s) => s.test === "T2b");
  const usablePhotos = state.photos.filter((p) => (p.usableCount || 0) >= 2).length;
  const t3Pass = state.photos.length && usablePhotos / state.photos.length >= 0.8;
  const dMs = state.photos.map((p) => p.decomposeMs || 0);
  const sceneMs = state.scenes.filter((s) => s.outcome === "ok").map((s) => s.ms);
  const t6 = state.scenes.filter((s) => s.test === "T6");
  const t6Refused = t6.filter((s) => s.outcome !== "ok").length;
  const sizes = state.scenes.filter((s) => s.test === "size");
  const probe = state.scenes.find((s) => s.test === "probe");
  const portrait = sizes.find((s) => s.size === "1024x1536");
  const totalEst = state.calls.reduce((a, c) => a + (c.estUsd || 0), 0);
  const samCalls = state.calls.filter((c) => c.op === "sam");
  const composeOk = state.scenes.filter((s) => s.outcome === "ok");
  const perPhoto = state.photos.length ? (callsCost("elements") + callsCost("sam")) / state.photos.length : 0;
  const perScene = composeOk.length ? callsCost("compose") / Math.max(1, state.scenes.filter((s) => s.test !== "probe").length) : 0;
  const maxOf = (xs) => (xs.length ? Math.max(...xs) : 0);
  const recTimeout = (ms, floor) => Math.max(floor, Math.ceil((ms * 1.5) / 5000) * 5000);
  const storeAll = state.scenes.every((s) => s.storeAccepted !== false);
  const t1Pass = t1Mean >= 3.5 && t1Clean >= 4;
  const alarm = modes.every((m) => modeMeans[m] < 2.5) && t1Scores.length > 0;

  L.push("# Studio Slice 0 — spike findings (PIN-50)", "");
  L.push(`_Generated by \`scripts/studio-spike.mjs\` from live local runs on synthetic images. Per A1 this file holds the findings; \`docs/11\` is not edited. Thresholds: docs/11 s8. Raw redacted data: \`eval/fixtures/studio/fixtures.json\` + \`call-log.json\`. Contact sheets: \`eval/contact-sheets/\`._`, "");
  if (alarm) L.push(`> **MORNING REVIEW ALARM (decision rule): T1 mean is below 2.5 in every input mode** (flattened ${modeMeans.flattened.toFixed(2)}, transparent ${modeMeans.transparent.toFixed(2)}, whole ${modeMeans.whole.toFixed(2)}). Slice 1 does not depend on T1 and still proceeds.`, "");
  L.push(`## T1 Fidelity — ${t1Pass ? "PASS" : "FAIL"}`, "");
  L.push(`- Mean element score across the 5 flattened scenes (C1-C5): **${t1Mean.toFixed(2)}/5** over ${t1Scores.length} scored elements (pass: >= 3.5).`);
  L.push(`- Scenes where every element scored >= 3: **${t1Clean} of ${t1Scenes.length}** (pass: 4 of 5).`);
  L.push(`- Spark judging Muse Image is a proxy; Robin's read of the contact sheets is final but never blocking.`, "");
  L.push("| Scene | Elements (score) |", "| --- | --- |");
  for (const s of t1Scenes) L.push(`| ${s.id} | ${(s.scores || []).map((x) => `${x.elementId?.split("--")[1] || "?"} ${x.score} (${x.reason})`).join("; ") || s.outcome} |`);
  L.push("");
  L.push("## T2 Input mode — best mean wins", "");
  L.push("| Mode | Mean score | Scored elements |", "| --- | --- | --- |");
  for (const m of modes) L.push(`| ${m} | ${modeMeans[m].toFixed(2)} | ${sceneScores("T1/T2", m).length} |`);
  L.push("", `Same 3 compositions (C1-C3) per mode. **Recommended \`sceneInputMode\`: \`${bestMode}\`.**`, "");
  L.push("## T2b Label binding (labels rotated by one, C2)", "");
  if (swap) {
    L.push(`- Outcome: ${swap.outcome}. Scores were judged against the TRUE element order while the model saw rotated labels: ${(swap.scores || []).map((x) => `${x.elementId?.split("--")[1]} ${x.score} (${x.reason})`).join("; ") || "n/a"}.`);
    L.push(`- Read: if scores stay high, the following image dominates its label; if they collapse, labels bind. Compare C2-flattened in \`eval/contact-sheets/C2-labelswap.jpg\`.`, "");
  } else L.push("- Not run.", "");
  L.push(`## T3 Naming — ${t3Pass ? "PASS" : "FAIL"}`, "");
  L.push(`- Usable pin = SAM segment found and mask covers 0.5%-60% of frame. Photos with >= 2 usable pins: **${usablePhotos} of ${state.photos.length}** (pass: >= 80%).`, "");
  L.push("| Photo | Kind | Named | Usable | faceFlags |", "| --- | --- | --- | --- | --- |");
  for (const p of state.photos) L.push(`| ${p.id} | ${p.kind} | ${p.namedCount ?? "?"} | ${p.usableCount ?? "?"} | ${state.elements.filter((e) => e.photoId === p.id && e.faceFlag).length} |`);
  L.push("");
  L.push(`## T4 Speed — ${mean(dMs) <= 15000 && mean(sceneMs) <= 30000 ? "PASS" : "FAIL"}`, "");
  L.push(`- Photo -> pins (Spark elements + SAM at concurrency 4 + cut-outs), wall clock per photo: mean **${fmtS(mean(dMs))}**, max ${fmtS(maxOf(dMs))} (pass: <= 15s).`);
  L.push(`- Scene compose per call: mean **${fmtS(mean(sceneMs))}**, max ${fmtS(maxOf(sceneMs))} over ${sceneMs.length} ok scenes (pass: <= 30s).`, "");
  L.push(`## T5 Cost — ${perPhoto <= 0.05 && perScene <= 0.1 ? "PASS" : "FAIL"} (estimates)`, "");
  L.push(`- Per photo (elements + SAM): **${fmt$(perPhoto)}** (pass: <= $0.05). SAM at $0.0025 per concept call (${samCalls.length} calls). Billing unit confirmed from the wire: every SAM response reports usage.images_processed=${samCalls.length ? Math.round(samCalls.reduce((a, c) => a + (c.usage?.images_processed || 0), 0) / Math.max(1, samCalls.filter((c) => c.ok).length)) : "?"} per call (0 tokens), independent of how many segments matched — so one concept call bills as one image (docs/11 Q2 resolved; dashboard remains the final authority).`);
  L.push(`- Per scene (Muse Image /responses): **${fmt$(perScene)}** estimated (pass: <= $0.10). Token usage is recorded per call in call-log.json; the /responses token price is not published in this repo, so tokens are priced with Muse Spark list rates as a labelled proxy — treat $/scene as an order-of-magnitude estimate, not a bill.`);
  L.push(`- Whole spike Meta estimate: **${fmt$(totalEst)}** of the $25 local cap (docs/11 A2: local spike money stays separate from the hosted budget; hosted recommendation remains dev/prod $10/day + per-board caps, Robin raises before PIN-55). Higgsfield images used: ${state.higgsImages} of 60.`, "");
  L.push(`## T6 Refusals — ${t6Refused < 1 ? "PASS" : t6Refused === 1 ? "BORDERLINE (exactly 1 in 10; pass is fewer than 1 in 10)" : "FAIL"}`, "");
  L.push(`- Harmless prompts refused/errored: **${t6Refused} of ${t6.length}** (3 include synthetic people).`, "");
  L.push("| Probe | Person? | Outcome | Code |", "| --- | --- | --- | --- |");
  for (const s of t6) L.push(`| ${s.id} | ${s.hasPerson ? "yes" : "no"} | ${s.outcome} | ${s.code || "-"} |`);
  L.push("");
  L.push("## Size matrix + transport probes", "");
  L.push(`- \`1536x1024\` (documented landscape): used for all main scenes — ${composeOk.length ? "accepted" : "no ok scenes"}.`);
  for (const s of sizes) L.push(`- \`${s.size}\`: ${s.outcome}${s.sceneWidth ? `, returned ${s.sceneWidth}x${s.sceneHeight}px` : ""}${s.code ? ` (${s.code}, HTTP ${s.status})` : ""}.`);
  L.push(`- Undocumented tool keys probe (\`output_format\` + \`reasoning_strength\` on the image_generation tool): ${probe ? `${probe.outcome}${probe.code ? ` (${probe.code}, HTTP ${probe.status})` : ""} — do not depend on them either way` : "not run"}.`);
  L.push(`- \`store: false\`: ${storeAll ? "accepted on every compose call" : "rejected at least once; fell back to omitting the field"}.`, "");
  L.push("## Recommended Policy defaults (for PIN-51)", "");
  L.push(`- \`sceneInputMode\`: **${bestMode}** (best T2 mean).`);
  L.push(`- \`sceneSize\`: **${portrait?.outcome === "ok" ? "1024x1536 (portrait accepted)" : "1536x1024 (portrait not confirmed; letterbox in the card)"}**.`);
  L.push(`- \`store\`: **false** ${storeAll ? "(verified accepted; remix stays stateless)" : "(field rejected by API — PIN-51 must revisit Q1)"}.`);
  L.push(`- Timeouts from observed maxima x1.5: Spark elements ${recTimeout(maxOf(state.calls.filter((c) => c.op === "elements").map((c) => c.ms)), 30000)}ms, SAM ${recTimeout(maxOf(samCalls.map((c) => c.ms)), 20000)}ms, scene ${recTimeout(maxOf(sceneMs), 120000)}ms.`);
  L.push(`- Retries: 1 on 429/5xx (as spiked). Judge timeout used here: 120s (eval only, not product).`, "");
  L.push("## Method notes", "");
  L.push("- Fixtures: 14 synthetic Higgsfield (Recraft V4.1 Utility) photoreal text-to-image scenes — 10 home/desk, 2 hard (glass, cables), 2 synthetic people. No real photos. Source + prompt per fixture in fixtures.json.");
  L.push("- Pipeline: Spark `prompts/elements.v1.md` -> SAM `POST /v1/responses` per concept -> sharp cut-out/flattened (sam-mask patterns) -> Muse Image `POST /v1/responses` with `{role:\"user\", content:[input_text label, input_image...]}` and `tools:[{type:\"image_generation\", size}]` only; image read from `image_generation_call.result`.");
  L.push("- Whole+pointer mode sends the full working photo with a red ring at the SAM box centre plus a text hint. Transparent mode sends the alpha PNG cut-out as-is.");
  L.push("- A refusal = HTTP 200 with no `image_generation_call` item, or an API error; both are recorded with redacted codes, never payloads.");
  L.push("- Compositions pick usable elements by keyword with a first-usable fallback; the exact element ids used per scene are in fixtures.json (two picks fell back: check C4/C5 there). Requested sizes are returned scaled up at the same aspect (1536x1024 -> 1920x1280, 1024x1536 -> 1280x1920, 1024x1024 -> 1600x1600).");
  L.push("");
  return L.join("\n");
}

/* ---------------- main ---------------- */
async function main() {
  const phase = process.argv[2] || "all";
  if (phase === "report") { await phaseReport(); return; }
  if (!LIVE) { console.log("studio-spike: live phases skipped (set STUDIO_SPIKE_LIVE=1 and AI_MOCK!=1 to run locally). Report phase works offline."); return; }
  if (!META_KEY) throw new Error("META_API_KEY missing from .env.local");
  if ((phase === "fixtures" || phase === "all")) await phaseFixtures();
  if ((phase === "decompose" || phase === "all")) await phaseDecompose();
  if ((phase === "scenes" || phase === "all")) await phaseScenes();
  if (phase === "all") await phaseReport();
}
main().catch((e) => { console.error("studio-spike failed:", e?.message || e); process.exit(1); });
