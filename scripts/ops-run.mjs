#!/usr/bin/env node
/**
 * Run a TypeScript operator script against the app's real server code
 * (PIN-272). The server modules are `server-only` and import each other
 * without extensions, so plain Node cannot load them; this bundles the
 * entry with esbuild (already in node_modules through vitest/vite)
 * under the `react-server` condition, which turns `server-only` into
 * its empty module, keeps node_modules external, and runs the result.
 *
 *   node scripts/ops-run.mjs scripts/report-ops.ts -- <script args>
 *
 * Nothing here reads env or credentials: the script itself decides
 * what it needs (ADC for Firestore and Storage, an explicit --project).
 * Build output lands in .ops-build/ (gitignored).
 */
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const [entry, ...rest] = process.argv.slice(2);
const dash = rest.indexOf("--");
const scriptArgs = dash >= 0 ? rest.slice(dash + 1) : rest;

if (!entry || !entry.endsWith(".ts")) {
  console.error("usage: node scripts/ops-run.mjs <script.ts> -- <args>");
  process.exit(2);
}

let esbuild;
try {
  esbuild = require("esbuild");
} catch {
  console.error("esbuild is not installed; run `npm ci` first.");
  process.exit(2);
}

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const outDir = path.join(root, ".ops-build");
await mkdir(outDir, { recursive: true });
const outfile = path.join(outDir, `${path.basename(entry, ".ts")}.mjs`);

await esbuild.build({
  entryPoints: [path.resolve(root, entry)],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // node_modules stay external (Firestore, Storage, sharp load from disk);
  // `server-only` is the one exception: aliased to its own empty module,
  // the file Next itself serves under the react-server condition, so the
  // marker never throws in a plain Node process.
  packages: "external",
  // The package exports only "." so resolve its entry and take the sibling file.
  alias: { "server-only": path.join(path.dirname(require.resolve("server-only")), "empty.js") },
  logLevel: "warning",
  // JSON catalogs and config are bundled in; secrets never are (they come from env at run time).
  loader: { ".json": "json" },
});

// The bundled script owns argv from here on.
process.argv = [process.argv[0], outfile, ...scriptArgs];
await import(pathToFileURL(outfile).href);
