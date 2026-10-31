/**
 * Muse Image text-to-image for the friends' source photos (PIN-173, docs/17 step 2).
 *
 * One call per photo (`POST {META_API_BASE_URL}/images/generations`), one at a
 * time, against a hard image cap counted in a state file in the work folder.
 * The key comes from the environment (the operator's env file) and is sent only
 * to that endpoint. Logs hold status, timing and size, never the key, a prompt
 * or the response body. These are PAID calls: the CLI plans by default and
 * needs `--live` to make them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isRelativePhotoName } from "./spec.mjs";

export const PHOTO_SIZES = ["1024x1536", "1536x1024", "1024x1024"];
export const DEFAULT_IMAGE_CAP = 40;
const PROMPT_MAX = 2000;
const DEFAULT_BASE = "https://api.meta.ai/v1";
const DEFAULT_MODEL = "muse-image-1.0"; // DEFAULT_META_MODELS.image in src/config.ts

/** The items file: `[ { "out": "cat/aye.webp", "size": "1536x1024", "prompt": "..." } ]`. Returns the problems found. */
export function validatePhotoItems(items) {
  if (!Array.isArray(items) || items.length === 0) return ["the items file must be a list of photos"];
  const errors = [];
  const seen = new Set();
  items.forEach((item, i) => {
    const at = `items[${i}]`;
    if (!isRelativePhotoName(item?.out)) errors.push(`${at}: out must be a relative .webp, .jpg or .png name`);
    else if (seen.has(item.out)) errors.push(`${at}: "${item.out}" appears twice`);
    else seen.add(item.out);
    if (!PHOTO_SIZES.includes(item?.size)) errors.push(`${at}: size must be one of ${PHOTO_SIZES.join(", ")}`);
    if (typeof item?.prompt !== "string" || !item.prompt.trim() || item.prompt.length > PROMPT_MAX) errors.push(`${at}: prompt must be 1 to ${PROMPT_MAX} characters`);
  });
  return errors;
}

/** The real image type from its first bytes. Muse Image answers WebP whatever name was asked for. */
export function detectImageType(buf) {
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return ".webp";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  return null;
}

/** The first inline image or image URL in an answer, however the API nests it. */
export function findImage(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && (key === "b64_json" || key === "base64")) return { b64: item };
    if (typeof item === "string" && key === "url" && /^https:/.test(item)) return { url: item };
    const hit = findImage(item, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function readState(stateFile, baseline = 0) {
  if (existsSync(stateFile)) return JSON.parse(readFileSync(stateFile, "utf8"));
  return { generated: baseline, log: [] };
}

/**
 * Generate the photos that do not exist yet. `opts`: { photosDir, stateFile, cap, baseline, force, baseUrl, key,
 * model, fetchImpl, log }. Stops before any call that would pass the cap. Returns { made, skipped, failed }.
 */
export async function generatePhotos(items, opts) {
  const { photosDir, stateFile, cap = DEFAULT_IMAGE_CAP, baseline = 0, force = false, key, log } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = (opts.baseUrl || DEFAULT_BASE).replace(/\/+$/, "");
  const model = opts.model || DEFAULT_MODEL;
  if (!key) throw new Error("META_API_KEY is missing: load the operator's env file with --env-file");
  mkdirSync(path.dirname(stateFile), { recursive: true });
  const state = readState(stateFile, baseline);
  const result = { made: [], skipped: [], failed: [] };

  for (const item of items) {
    const exists = [".webp", ".jpg", ".png"].some((ext) => existsSync(path.join(photosDir, item.out.replace(/\.\w+$/, ext))));
    if (exists && !force) {
      result.skipped.push(item.out);
      log(`${item.out}: already there, skipped (use --force to make it again)`);
      continue;
    }
    if (state.generated >= cap) {
      log(`image cap of ${cap} reached (${state.generated} generated): stopping before ${item.out}. Raise --image-cap only on purpose.`);
      result.failed.push(item.out);
      break;
    }
    const t0 = Date.now();
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, prompt: item.prompt, size: item.size, n: 1 }),
      });
    } catch {
      log(`${item.out}: FAIL network error`);
      result.failed.push(item.out);
      continue;
    }
    const json = await res.json().catch(() => ({}));
    const hit = res.ok ? findImage(json) : null;
    if (!hit) {
      log(`${item.out}: FAIL http=${res.status} ms=${Date.now() - t0}`);
      result.failed.push(item.out);
      continue;
    }
    const bytes = hit.b64 ? Buffer.from(hit.b64, "base64") : Buffer.from(await (await fetchImpl(hit.url)).arrayBuffer());
    const ext = detectImageType(bytes);
    if (!ext) {
      log(`${item.out}: FAIL the answer was not an image`);
      result.failed.push(item.out);
      continue;
    }
    // The call is paid for either way: count it first, then write.
    state.generated += 1;
    const dest = path.join(photosDir, item.out.replace(/\.\w+$/, ext));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, bytes);
    state.log.push({
      out: path.basename(dest),
      model,
      size: item.size,
      requestId: res.headers.get("x-request-id") ?? json.id ?? null,
      at: new Date().toISOString(),
    });
    writeFileSync(stateFile, `${JSON.stringify(state, null, 1)}\n`);
    result.made.push(path.relative(photosDir, dest));
    log(`${item.out}: OK ms=${Date.now() - t0} bytes=${bytes.length} image ${state.generated} of ${cap}`);
  }
  return result;
}
