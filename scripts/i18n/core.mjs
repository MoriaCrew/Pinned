/**
 * PIN-189 i18n core: pure helpers shared by `npm run i18n:translate`,
 * `npm run i18n:check` and the vitest suite. No network, no fs.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

const PLACEHOLDER = /\{(\w+)\}/g;
const PLURAL_SUFFIX = /\.(one|other)$/;
/** Our fonts lack U+202F (narrow no-break space); FR models love it. */
const NARROW_NBSP = / /g;
const EMOJI = /\p{Extended_Pictographic}/gu;

/** Sorted, de-duplicated `{name}` placeholders in a message. */
export function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

/** `x.one` ↔ `x.other`; null for keys that are not plural forms. */
export function pluralPartner(key) {
  const m = key.match(PLURAL_SUFFIX);
  if (!m) return null;
  return key.replace(PLURAL_SUFFIX, m[1] === "one" ? ".other" : ".one");
}

/** Lock hash: English text + prompt version, so a prompt bump re-translates. */
export function entryHash(english, promptVersion) {
  return createHash("sha256").update(`${promptVersion}\n${english}`).digest("hex").slice(0, 16);
}

export function normalizeTranslation(text) {
  return text.replace(NARROW_NBSP, " ");
}

/**
 * Keys that need a (re)translation: missing from the locale file, no
 * lock entry, or English/prompt changed since the lock was written.
 * Result follows `en` key order.
 */
export function deltaKeys({ en, locale, lock, promptVersion, force = false, only = null }) {
  const wanted = only ? new Set(only) : null;
  const lockKeys = lock?.keys ?? {};
  return Object.keys(en).filter((key) => {
    if (wanted && !wanted.has(key)) return false;
    if (force) return true;
    if (typeof locale[key] !== "string" || locale[key] === "") return true;
    return lockKeys[key] !== entryHash(en[key], promptVersion);
  });
}

/**
 * Split keys into batches of about `size`, never separating a
 * `.one`/`.other` pair (they must be judged together).
 */
export function batchKeys(keys, size) {
  const batches = [];
  let current = [];
  for (let i = 0; i < keys.length; i++) {
    current.push(keys[i]);
    const next = keys[i + 1];
    const keepPair = next && pluralPartner(keys[i]) === next;
    if (current.length >= size && !keepPair) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

/**
 * Index just past the balanced `}` matching the `{` at `start`, or -1
 * when the text ends first (a truncated reply). String-aware.
 */
function matchBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

const StringMap = z.record(z.string(), z.string());

/**
 * Tolerant parse of a model reply that should be one JSON object of
 * strings: strips code fences and prose, takes the outermost object.
 * Throws a short Error (safe to print; no payload) on failure.
 */
export function parseModelJson(reply, schema = StringMap) {
  if (typeof reply !== "string" || reply.trim() === "") throw new Error("empty reply");
  const unfenced = reply.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  const end = matchBrace(unfenced, start);
  if (end < 0) throw new Error("truncated JSON object");
  let value;
  try {
    value = JSON.parse(unfenced.slice(start, end));
  } catch (err) {
    throw new Error(`invalid JSON: ${err.message.slice(0, 80)}`);
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`unexpected JSON shape: ${parsed.error.issues[0]?.message ?? "?"}`);
  return parsed.data;
}

export const ReviewSchema = z.object({
  corrections: z
    .array(z.object({ key: z.string(), value: z.string(), reason: z.string() }))
    .default([]),
});

/** Do-not-translate terms present in `english` must survive verbatim. */
function missingTerms(english, translated, doNotTranslate) {
  return doNotTranslate.filter((term) => english.includes(term) && !translated.includes(term));
}

/**
 * Deterministic checks for one translated string. Returns
 * `{ errors, warnings }` (arrays of short strings).
 */
export function checkEntry(english, translated, { doNotTranslate = [], maxRatio = 1.5 } = {}) {
  const errors = [];
  const warnings = [];
  if (typeof translated !== "string" || translated.trim() === "") {
    errors.push("empty value");
    return { errors, warnings };
  }
  const want = placeholders(english).join(",");
  const got = placeholders(translated).join(",");
  if (want !== got) errors.push(`placeholders {${got}} must be exactly {${want}}`);
  const lost = missingTerms(english, translated, doNotTranslate);
  if (lost.length) errors.push(`keep these words unchanged: ${lost.join(", ")}`);
  // Short labels naturally grow a few characters; only flag real growth.
  if (translated.length > english.length * maxRatio && translated.length - english.length > 4) {
    warnings.push(`long: ${translated.length} chars vs ${english.length} in English`);
  }
  const added = (translated.match(EMOJI) ?? []).filter((e) => !english.includes(e));
  if (added.length) warnings.push(`emoji added: ${added.join("")}`);
  return { errors, warnings };
}

/**
 * Validate a model result for one batch. `requested` maps key →
 * English. Returns per-key verdicts plus batch-level problems.
 */
export function validateBatch(requested, result, opts = {}) {
  const ok = {};
  const failed = {};
  const warnings = {};
  const extra = Object.keys(result).filter((k) => !(k in requested));
  for (const [key, english] of Object.entries(requested)) {
    if (!(key in result)) {
      failed[key] = "missing from reply";
      continue;
    }
    const value = normalizeTranslation(result[key]);
    const { errors, warnings: w } = checkEntry(english, value, opts);
    if (w.length) warnings[key] = w;
    if (errors.length) failed[key] = errors.join("; ");
    else ok[key] = value;
  }
  // A plural pair is all-or-nothing.
  for (const key of Object.keys(ok)) {
    const partner = pluralPartner(key);
    if (partner && partner in requested && !(partner in ok)) {
      delete ok[key];
      failed[key] = `plural pair incomplete (${partner} failed)`;
    }
  }
  return { ok, failed, warnings, extra };
}

/** Rebuild a locale catalog in `en` key order, only keys with a value. */
export function orderLikeEnglish(en, entries) {
  const out = {};
  for (const key of Object.keys(en)) {
    if (typeof entries[key] === "string" && entries[key] !== "") out[key] = entries[key];
  }
  return out;
}

/**
 * Offline catalog check for one locale. Errors: keys not in English,
 * placeholder mismatch, half a plural pair, non-string or empty values.
 * Missing translations are informational only (English fallback).
 */
export function checkCatalog(en, locale) {
  const errors = [];
  for (const [key, value] of Object.entries(locale)) {
    if (!(key in en)) {
      errors.push(`${key}: not in en.json`);
      continue;
    }
    if (typeof value !== "string" || value === "") {
      errors.push(`${key}: empty or not a string`);
      continue;
    }
    const want = placeholders(en[key]).join(",");
    const got = placeholders(value).join(",");
    if (want !== got) errors.push(`${key}: placeholders {${got}} ≠ English {${want}}`);
    const partner = pluralPartner(key);
    if (partner && partner in en && !(partner in locale)) errors.push(`${key}: plural pair missing ${partner}`);
  }
  const missing = Object.keys(en).filter((k) => !(k in locale));
  return { errors, missing };
}

const QUOTED = /(["'`])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g;
// A template literal that starts with a key-ish prefix and interpolates:
// `skin.${id}.mood`, `create.reason.${reason}`, `activity.${kind}`.
const TEMPLATE = /`([A-Za-z][\w.-]*\$\{[^`]*)`/g;

function templateToRegex(body) {
  const parts = body.split(/\$\{[^}]*\}/);
  const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join("[\\w-]+")}$`);
}

/**
 * English keys no source file references. A key counts as used when it
 * appears quoted, when its plural base appears quoted (`tCount`), or
 * when it matches a template family such as `skin.${id}.mood`.
 * `sources` is a list of `{ path, text }`. Returns
 * `{ unused, testOnly }` where testOnly keys appear only in `*.test.*`.
 */
export function findUnusedKeys(enKeys, sources) {
  const scan = (files) => {
    const literals = new Set();
    const families = [];
    for (const { text } of files) {
      for (const m of text.matchAll(QUOTED)) literals.add(m[2]);
      for (const m of text.matchAll(TEMPLATE)) families.push(templateToRegex(m[1]));
    }
    return (key) => {
      if (literals.has(key)) return true;
      const base = key.replace(PLURAL_SUFFIX, "");
      if (base !== key && literals.has(base)) return true;
      return families.some((re) => re.test(key));
    };
  };
  const isTest = (p) => /\.test\.[cm]?[jt]sx?$/.test(p);
  const inApp = scan(sources.filter((s) => !isTest(s.path)));
  const inTests = scan(sources.filter((s) => isTest(s.path)));
  const unused = [];
  const testOnly = [];
  for (const key of enKeys) {
    if (inApp(key)) continue;
    if (inTests(key)) testOnly.push(key);
    else unused.push(key);
  }
  return { unused, testOnly };
}
