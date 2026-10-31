#!/usr/bin/env node
/**
 * PIN-189 offline i18n catalog check (no network). Fails only on
 * real errors (unknown keys, placeholder or plural mismatches);
 * missing translations and unused English keys are reported.
 * Same module as src/i18n/catalog.test.ts.
 */
import { runCatalogCheck } from "./i18n/catalog.mjs";

const r = runCatalogCheck();
let errors = 0;
console.log(`en: ${r.englishKeys} keys`);
for (const [locale, { errors: errs, missing }] of Object.entries(r.locales)) {
  const translated = r.englishKeys - missing.length;
  console.log(`${locale}: ${translated}/${r.englishKeys} translated, ${missing.length} fall back to English, ${errs.length} error(s)`);
  for (const e of errs) console.log(`  ERROR ${e}`);
  errors += errs.length;
}
if (r.unused.length) console.log(`unused English keys (${r.unused.length}): ${r.unused.join(", ")}`);
if (r.testOnly.length) console.log(`English keys referenced only by tests (${r.testOnly.length}): ${r.testOnly.join(", ")}`);
process.exitCode = errors ? 1 : 0;
