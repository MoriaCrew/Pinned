#!/usr/bin/env node
/**
 * PIN-189 UI translation tool (dev-time only, never in CI or the app).
 *
 * Translates `src/i18n/messages/en.json` into one locale file per
 * language with Muse Spark Open on Baseten (OpenAI-compatible chat
 * completions), then runs a reviewer pass. Delta only: each
 * `<locale>.lock.json` maps every key to a hash of its English text +
 * the prompt version, so only new or changed English is sent.
 *
 * Usage:
 *   npm run i18n:translate -- --locale it            # delta for one locale
 *   npm run i18n:translate -- --all                  # every locale file
 *   npm run i18n:translate -- --locale fr --force    # redo everything
 *   npm run i18n:translate -- --locale it --keys landing.tagline,landing.start --dry-run
 *   npm run i18n:check                               # offline check, no network
 *
 * Flags:
 *   --locale <code>   locale to translate (a file src/i18n/messages/<code>.json must exist)
 *   --all             every locale file found in src/i18n/messages
 *   --force           ignore the lock, re-translate all selected keys
 *   --keys a,b        only these keys (still subject to the lock unless --force)
 *   --dry-run         call the model and print results, write nothing
 *   --no-review       skip the reviewer pass
 *   --max-usd <n>     stop before spend would exceed this (default 5)
 *   --price-in <n>    USD per million prompt tokens (default 1.25)
 *   --price-out <n>   USD per million completion tokens (default 4.25)
 *   --batch <n>       keys per request (default 50; plural pairs never split)
 *   --max-tokens <n>  max_tokens per request (default 16000; reasoning counts)
 *
 * Env (from the environment or .env.local, never printed):
 *   BASETEN_API_KEY   required
 *   BASETEN_BASE_URL  default https://inference.baseten.co/v1
 *   I18N_MODEL        default meta-models/muse-spark-open-1026
 *
 * Full i18n guide: docs/18-i18n.md (PIN-190/PIN-199).
 *
 * Adding a language: PIN-190 adds `src/i18n/messages/<code>.json`
 * (may be `{}`); add a register line to prompts/translate-ui.v1.md and
 * fixed terms to src/i18n/glossary.json, then run --locale <code>.
 * Hand edits to a locale file survive: the lock only changes when the
 * English text or the prompt version changes.
 *
 * Model quirks (Muse Spark Open): no JSON mode, so JSON is requested in
 * the prompt and parsed tolerantly; it always reasons and reasoning
 * counts toward max_tokens, so we send reasoning_effort "low" with
 * generous headroom; n > 1 is a 400; output is not repeatable even at
 * temperature 0. Prints counts, flags, tokens and USD — never the key
 * or raw payloads.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ReviewSchema,
  batchKeys,
  checkEntry,
  deltaKeys,
  entryHash,
  normalizeTranslation,
  orderLikeEnglish,
  parseModelJson,
  validateBatch,
} from "./i18n/core.mjs";
import { MESSAGES_DIR, ROOT, listLocales, loadEnglish, loadGlossary, loadLocale, loadLock, writeJson } from "./i18n/catalog.mjs";

const TRANSLATE_PROMPT = "translate-ui.v1";
const REVIEW_PROMPT = "review-ui.v1";
/** docs/08-ux-principles.md §2: icon + ≤6 words. */
const BUTTON_MAX_WORDS = 6;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const HTTP_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 180_000;

function loadEnvLocal() {
  const file = path.join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

function parseArgs(argv) {
  const opts = {
    locales: [],
    all: false,
    force: false,
    keys: null,
    dryRun: false,
    review: true,
    maxUsd: 5,
    priceIn: 1.25,
    priceOut: 4.25,
    batch: 50,
    maxTokens: 16000,
  };
  const num = (flag, v) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--locale") opts.locales.push(next());
    else if (a === "--all") opts.all = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--keys") opts.keys = next().split(",").map((k) => k.trim()).filter(Boolean);
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-review") opts.review = false;
    else if (a === "--max-usd") opts.maxUsd = num(a, next());
    else if (a === "--price-in") opts.priceIn = num(a, next());
    else if (a === "--price-out") opts.priceOut = num(a, next());
    else if (a === "--batch") opts.batch = Math.floor(num(a, next()));
    else if (a === "--max-tokens") opts.maxTokens = Math.floor(num(a, next()));
    else throw new Error(`unknown flag ${a}`);
  }
  return opts;
}

/** Text above the `---` rule is the verbatim system prompt. */
function loadPrompt(version) {
  const raw = readFileSync(path.join(ROOT, "prompts", `${version}.md`), "utf8");
  const [system, notes = ""] = raw.split(/\n---\n/);
  return { system: system.trim(), notes };
}

function registers(notes) {
  const out = {};
  for (const m of notes.matchAll(/^- ([A-Za-z-]+): (.+)$/gm)) out[m[1]] = m[2].trim();
  return out;
}

function languageName(locale) {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

function fill(template, slots) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name) => (name in slots ? String(slots[name]) : m));
}

class Budget {
  constructor(opts) {
    this.opts = opts;
    this.promptTokens = 0;
    this.completionTokens = 0;
    this.calls = 0;
  }
  usd(promptTokens = this.promptTokens, completionTokens = this.completionTokens) {
    return (promptTokens * this.opts.priceIn + completionTokens * this.opts.priceOut) / 1e6;
  }
  /** Worst case for the next call: rough prompt estimate + full max_tokens. */
  assertRoom(promptChars) {
    const worst = this.usd(this.promptTokens + Math.ceil(promptChars / 3), this.completionTokens + this.opts.maxTokens);
    if (worst > this.opts.maxUsd) {
      throw new BudgetStop(`next call could exceed --max-usd ${this.opts.maxUsd} (spent $${this.usd().toFixed(4)})`);
    }
  }
  add(usage) {
    this.calls++;
    this.promptTokens += usage?.prompt_tokens ?? 0;
    this.completionTokens += usage?.completion_tokens ?? 0;
  }
}
class BudgetStop extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chat(env, budget, system, user, log) {
  budget.assertRoom(system.length + user.length);
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    let res;
    let json = {};
    try {
      res = await fetch(`${env.base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: env.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          max_tokens: budget.opts.maxTokens,
          temperature: 0.2,
          reasoning_effort: "low",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      json = await res.json().catch(() => ({}));
    } catch (err) {
      if (attempt >= HTTP_ATTEMPTS) throw new Error(`network: ${err.name}`);
      log(`  network ${err.name}, retry ${attempt}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    const ms = Date.now() - started;
    if (res.ok) {
      budget.add(json.usage);
      const choice = json.choices?.[0];
      log(
        `  HTTP ${res.status} ${ms}ms tokens in=${json.usage?.prompt_tokens ?? "?"} out=${json.usage?.completion_tokens ?? "?"} finish=${choice?.finish_reason ?? "?"}`,
      );
      return { content: choice?.message?.content ?? "", finish: choice?.finish_reason };
    }
    const code = json?.error?.code ?? json?.error?.type ?? "";
    if (RETRY_STATUSES.has(res.status) && attempt < HTTP_ATTEMPTS) {
      log(`  HTTP ${res.status} ${code}, retry ${attempt}`);
      await sleep(2000 * 2 ** (attempt - 1));
      continue;
    }
    const err = new Error(`HTTP ${res.status}${code ? ` ${code}` : ""}`);
    err.status = res.status;
    throw err;
  }
}

/** One translate call + deterministic checks; returns validateBatch output. */
async function translateOnce(ctx, requested, fixes) {
  const payload = JSON.stringify(requested, null, 1);
  const user = fixes
    ? `Your previous answer had problems. Fix them:\n${Object.entries(fixes)
        .map(([k, e]) => `- ${k}: ${e}`)
        .join("\n")}\n\nTranslate:\n${payload}`
    : payload;
  const { content, finish } = await chat(ctx.env, ctx.budget, ctx.translateSystem, user, ctx.log);
  let parsed;
  try {
    parsed = parseModelJson(content);
  } catch (err) {
    const why = finish === "length" ? `${err.message} (finish=length; raise --max-tokens)` : err.message;
    return { parseError: why, ok: {}, failed: Object.fromEntries(Object.keys(requested).map((k) => [k, why])), warnings: {}, extra: [] };
  }
  return validateBatch(requested, parsed, ctx.checkOpts);
}

async function translateBatch(ctx, keys) {
  const requested = Object.fromEntries(keys.map((k) => [k, ctx.en[k]]));
  const first = await translateOnce(ctx, requested);
  const ok = { ...first.ok };
  const warnings = { ...first.warnings };
  let failed = first.failed;
  if (Object.keys(failed).length) {
    // Retry only the failing keys (plus their plural partners), once.
    const retryKeys = keys.filter((k) => k in failed);
    const retryReq = Object.fromEntries(retryKeys.map((k) => [k, ctx.en[k]]));
    ctx.log(`  retrying ${retryKeys.length} key(s)`);
    const second = await translateOnce(ctx, retryReq, first.parseError ? { reply: first.parseError } : failed);
    Object.assign(ok, second.ok);
    Object.assign(warnings, second.warnings);
    failed = second.failed;
  }
  if (first.parseError) ctx.stats.parseBatches++;
  return { ok, failed, warnings };
}

async function reviewBatch(ctx, translated) {
  const keys = Object.keys(translated);
  if (!keys.length) return { applied: [], rejected: [] };
  const body = Object.fromEntries(keys.map((k) => [k, { en: ctx.en[k], tr: translated[k] }]));
  let result;
  try {
    const { content } = await chat(ctx.env, ctx.budget, ctx.reviewSystem, JSON.stringify(body, null, 1), ctx.log);
    result = parseModelJson(content, ReviewSchema);
  } catch (err) {
    if (err instanceof BudgetStop) throw err;
    ctx.log(`  review skipped: ${err.message}`);
    return { applied: [], rejected: [] };
  }
  const applied = [];
  const rejected = [];
  for (const c of result.corrections) {
    if (!(c.key in translated)) continue;
    const value = normalizeTranslation(c.value);
    if (value === translated[c.key]) continue;
    const { errors } = checkEntry(ctx.en[c.key], value, ctx.checkOpts);
    if (errors.length) rejected.push({ ...c, why: errors.join("; ") });
    else {
      applied.push({ key: c.key, from: translated[c.key], to: value, reason: c.reason });
      translated[c.key] = value;
    }
  }
  return { applied, rejected };
}

async function runLocale(locale, opts, env, budget, glossary, prompts) {
  const log = (s) => console.log(s);
  const en = loadEnglish();
  const current = loadLocale(locale);
  const lock = loadLock(locale);
  const register = prompts.registers[locale];
  if (!register) throw new Error(`no register for ${locale}: add "- ${locale}: …" to prompts/${TRANSLATE_PROMPT}.md`);
  const unknown = (opts.keys ?? []).filter((k) => !(k in en));
  if (unknown.length) throw new Error(`unknown keys: ${unknown.join(", ")}`);

  const terms = glossary.terms?.[locale] ?? {};
  const slots = {
    LANGUAGE: languageName(locale),
    LOCALE: locale,
    REGISTER: register,
    BUTTON_MAX_WORDS,
    DO_NOT_TRANSLATE: glossary.doNotTranslate.join(", "),
    TERMS: Object.keys(terms).length
      ? Object.entries(terms)
          .map(([enTerm, tr]) => `${enTerm} → ${tr}`)
          .join("; ")
      : "none fixed yet; pick one natural word per concept and keep it",
  };
  const ctx = {
    en,
    env,
    budget,
    log,
    translateSystem: fill(prompts.translate.system, slots),
    reviewSystem: fill(prompts.review.system, slots),
    checkOpts: { doNotTranslate: glossary.doNotTranslate },
    stats: { parseBatches: 0 },
  };

  const todo = deltaKeys({ en, locale: current, lock, promptVersion: TRANSLATE_PROMPT, force: opts.force, only: opts.keys });
  const batches = batchKeys(todo, opts.batch);
  log(`\n[${locale}] ${languageName(locale)} — ${todo.length} key(s) to translate in ${batches.length} batch(es)`);

  const done = {};
  const failed = {};
  const warnings = {};
  const corrections = [];
  const rejectedCorrections = [];
  let stopped = null;
  for (const [i, keys] of batches.entries()) {
    log(` batch ${i + 1}/${batches.length} (${keys.length} keys)`);
    try {
      const r = await translateBatch(ctx, keys);
      if (opts.review) {
        const rev = await reviewBatch(ctx, r.ok);
        corrections.push(...rev.applied);
        rejectedCorrections.push(...rev.rejected);
      }
      Object.assign(done, r.ok);
      Object.assign(failed, r.failed);
      Object.assign(warnings, r.warnings);
    } catch (err) {
      stopped = err.message;
      for (const k of keys) failed[k] = err.message;
      if (err instanceof BudgetStop || err.status === 401 || err.status === 403 || err.status === 404) break;
    }
  }

  // Stale entries that failed now fall back to English rather than keep a wrong translation.
  const next = { ...current };
  const nextLockKeys = { ...(lock?.keys ?? {}) };
  for (const key of Object.keys(failed)) {
    if (key in next && nextLockKeys[key] !== entryHash(en[key], TRANSLATE_PROMPT)) {
      delete next[key];
      delete nextLockKeys[key];
    }
  }
  for (const [key, value] of Object.entries(done)) {
    next[key] = value;
    nextLockKeys[key] = entryHash(en[key], TRANSLATE_PROMPT);
  }
  const catalog = orderLikeEnglish(en, next);
  const lockOut = {
    prompt: TRANSLATE_PROMPT,
    review: opts.review ? REVIEW_PROMPT : null,
    model: env.model,
    keys: orderLikeEnglish(en, Object.fromEntries(Object.entries(nextLockKeys).filter(([k]) => k in catalog))),
  };

  if (opts.dryRun) {
    log(` dry run — nothing written. Results:`);
    for (const [k, v] of Object.entries(done)) log(`   ${k}: ${v}`);
  } else if (Object.keys(done).length || Object.keys(failed).length) {
    writeJson(path.join(MESSAGES_DIR, `${locale}.json`), catalog);
    writeJson(path.join(MESSAGES_DIR, `${locale}.lock.json`), lockOut);
    log(` wrote ${locale}.json (${Object.keys(catalog).length}/${Object.keys(en).length} keys) and ${locale}.lock.json`);
  }

  log(` translated ${Object.keys(done).length}, failed ${Object.keys(failed).length}, warnings ${Object.keys(warnings).length}`);
  for (const [k, e] of Object.entries(failed)) log(`   FAIL ${k}: ${e}`);
  for (const [k, w] of Object.entries(warnings)) log(`   WARN ${k}: ${w.join("; ")}`);
  for (const c of corrections) log(`   REVIEW ${c.key}: "${c.from}" → "${c.to}" (${c.reason})`);
  for (const c of rejectedCorrections) log(`   REVIEW-REJECTED ${c.key}: ${c.why}`);
  if (batches.length && ctx.stats.parseBatches / batches.length > 0.2) {
    log(` STOP CONDITION: ${ctx.stats.parseBatches}/${batches.length} batches unparseable on first try`);
  }
  if (stopped) log(` stopped: ${stopped}`);
  return { stopped, failed: Object.keys(failed).length };
}

async function main() {
  loadEnvLocal();
  const opts = parseArgs(process.argv.slice(2));
  const available = listLocales();
  const locales = opts.all ? available : opts.locales;
  if (!locales.length) throw new Error("pass --locale <code> or --all");
  const missing = locales.filter((l) => !available.includes(l));
  if (missing.length) throw new Error(`no catalog file for ${missing.join(", ")} in src/i18n/messages`);
  const env = {
    key: process.env.BASETEN_API_KEY || "",
    base: (process.env.BASETEN_BASE_URL || "https://inference.baseten.co/v1").replace(/\/$/, ""),
    model: process.env.I18N_MODEL || "meta-models/muse-spark-open-1026",
  };
  if (!env.key) throw new Error("BASETEN_API_KEY is not set (environment or .env.local)");

  const translate = loadPrompt(TRANSLATE_PROMPT);
  const prompts = { translate, review: loadPrompt(REVIEW_PROMPT), registers: registers(translate.notes) };
  const glossary = loadGlossary();
  const budget = new Budget(opts);
  console.log(`model ${env.model} · prompts ${TRANSLATE_PROMPT}${opts.review ? ` + ${REVIEW_PROMPT}` : ""} · max $${opts.maxUsd}${opts.dryRun ? " · dry run" : ""}`);

  let exit = 0;
  for (const locale of locales) {
    const r = await runLocale(locale, opts, env, budget, glossary, prompts);
    if (r.stopped) {
      exit = 1;
      if (/max-usd|HTTP 40[134]/.test(r.stopped)) break;
    }
  }
  console.log(
    `\ncalls ${budget.calls} · tokens in ${budget.promptTokens} out ${budget.completionTokens} · $${budget.usd().toFixed(4)} (at $${opts.priceIn}/$${opts.priceOut} per M)`,
  );
  process.exitCode = exit;
}

main().catch((err) => {
  console.error(`i18n:translate: ${err.message}`);
  process.exitCode = 1;
});
