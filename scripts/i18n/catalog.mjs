/**
 * PIN-189 catalog I/O + the offline check shared by `npm run i18n:check`
 * and `src/i18n/catalog.test.ts`. Locales are discovered from
 * `src/i18n/messages/*.json` (minus en.json and *.lock.json).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkCatalog, findUnusedKeys } from "./core.mjs";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const MESSAGES_DIR = path.join(ROOT, "src/i18n/messages");
export const GLOSSARY_PATH = path.join(ROOT, "src/i18n/glossary.json");

const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : fallback);

export function listLocales(dir = MESSAGES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "en.json" && !f.endsWith(".lock.json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export const loadEnglish = (dir = MESSAGES_DIR) => readJson(path.join(dir, "en.json"), {});
export const loadLocale = (locale, dir = MESSAGES_DIR) => readJson(path.join(dir, `${locale}.json`), {});
export const loadLock = (locale, dir = MESSAGES_DIR) => readJson(path.join(dir, `${locale}.lock.json`), null);
export const loadGlossary = () => readJson(GLOSSARY_PATH, { doNotTranslate: [], terms: {} });

export function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Every TS/JS file under src/ (catalog JSON excluded by extension). */
export function loadSources(root = ROOT) {
  return walk(path.join(root, "src")).map((p) => ({ path: path.relative(root, p), text: readFileSync(p, "utf8") }));
}

/**
 * Full offline check. Only `errors` should fail a build; `missing`,
 * `unused` and `testOnly` are reports.
 */
export function runCatalogCheck({ dir = MESSAGES_DIR, root = ROOT } = {}) {
  const en = loadEnglish(dir);
  const locales = {};
  for (const locale of listLocales(dir)) locales[locale] = checkCatalog(en, loadLocale(locale, dir));
  const { unused, testOnly } = findUnusedKeys(Object.keys(en), loadSources(root));
  return { englishKeys: Object.keys(en).length, locales, unused, testOnly };
}
