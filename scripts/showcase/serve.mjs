/**
 * Start this checkout's Next dev server for a showcase run (PIN-173, docs/17 step 3).
 *
 * The environment is built from the caller's (plus, for a live run, the
 * operator's env file, which the CLI loads first), then local-only
 * overrides are forced: memory backend, link-only auth, no paywall, no
 * Stripe, a hard daily spend stop, and live-model timeouts raised for a
 * full run. The default is a MOCK server (`AI_MOCK=1`), so nothing paid
 * can start by accident; a live server needs `--live`.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Live-model timeouts for a full run (Policy.timeoutsMs defaults are Spark 30 s, SAM 20 s: too tight, PIN-171). */
export const LIVE_TIMEOUTS_MS = Object.freeze({ spark: 90_000, sam: 60_000, scene: 180_000 });

/** Variables a local showcase run must not inherit from an env file. */
const DROP = [/^STRIPE_/, /^DEMO_BOARD_SLUG$/, /^FIRESTORE_EMULATOR_HOST$/];

/** Env for `next dev`: a copy of `base` with the overrides forced. Never changes `base`. */
export function serveEnv(base, { live = false, port = 3000, newSecret = () => randomBytes(32).toString("hex") } = {}) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => !DROP.some((re) => re.test(key))));
  Object.assign(env, {
    // Board sessions need a signing secret. The memory backend forgets every board when the server
    // stops, so a throwaway one is enough when the environment has none.
    SESSION_SECRET: base.SESSION_SECRET || newSecret(),
    AI_MOCK: live ? "0" : "1",
    DATA_BACKEND: "memory",
    AUTH_MODE: "link-only",
    PLUS_MODE: "off",
    APP_BASE_URL: `http://localhost:${port}`,
    AI_DAILY_BUDGET_USD: "10",
    AI_DAILY_CALL_LIMIT: "2000",
  });
  if (live) {
    let overrides = {};
    if (env.POLICY_OVERRIDES_JSON) {
      try {
        overrides = JSON.parse(env.POLICY_OVERRIDES_JSON);
      } catch {
        throw new Error("POLICY_OVERRIDES_JSON is not valid JSON");
      }
    }
    // The env file's own timeouts win only when they are longer.
    const timeouts = { ...LIVE_TIMEOUTS_MS };
    for (const [key, ms] of Object.entries(overrides.timeoutsMs ?? {})) timeouts[key] = Math.max(ms, timeouts[key] ?? 0);
    env.POLICY_OVERRIDES_JSON = JSON.stringify({ ...overrides, timeoutsMs: timeouts });
  }
  return env;
}

/** Spawn `next dev` on localhost only (a live server must not listen on the network). Resolves with its exit code. */
export function startServer(env, { port = 3000 } = {}) {
  // Resolved like an import, so a worktree that shares its parent folder's install works too.
  const next = createRequire(path.join(REPO_ROOT, "package.json")).resolve("next/dist/bin/next");
  const child = spawn(process.execPath, [next, "dev", "-H", "localhost", "-p", String(port)], { cwd: REPO_ROOT, stdio: "inherit", env });
  return new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 0)));
}
