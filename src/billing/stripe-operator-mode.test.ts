import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  DEV_PROJECT_ID,
  DEV_WEBHOOK_URL,
  LIVE_CONFIRM_FLAG,
  LIVE_FLAG,
  LIVE_WEBHOOK_URL,
  PROD_PROJECT_ID,
  projectModeError,
  resolveStripeMode,
  stripeKeyKind,
  webhookTarget,
} from "../../scripts/stripe/operator-mode.mjs";
import { STRIPE_WEBHOOK_EVENT_TYPES } from "../server/stripe-webhook";

/**
 * PIN-210: the sandbox/live gate of the Stripe operator scripts.
 * Pure cases run the shared module; script cases spawn the real
 * scripts with a fake `fetch` preload and a fake `gcloud` on PATH,
 * so nothing here touches Stripe, GCP or the network. Fake keys
 * are short on purpose (not key-shaped for the secret scanners).
 */
const LIVE_KEY = "rk_live_fake";
const TEST_KEY = "sk_test_fake";
const SIGNING = ["whsec", "fakeSigningValue"].join("_");
const BOTH = [LIVE_FLAG, LIVE_CONFIRM_FLAG];

describe("stripe operator mode gate (PIN-210)", () => {
  it("detects the key kind by prefix only", () => {
    expect(stripeKeyKind("sk_live_x")).toBe("live");
    expect(stripeKeyKind(LIVE_KEY)).toBe("live");
    expect(stripeKeyKind(TEST_KEY)).toBe("test");
    expect(stripeKeyKind("rk_test_x")).toBe("test");
    for (const odd of ["pk_live_x", "x_sk_live_", "sk_prod_x", "whsec_x", ""]) {
      expect(stripeKeyKind(odd)).toBe("unknown");
    }
  });

  it.each([
    [TEST_KEY, false, false, "sandbox"],
    [LIVE_KEY, true, true, "live"],
    [LIVE_KEY, false, false, /holds a LIVE key/],
    [LIVE_KEY, true, false, /needs --i-understand-live/],
    [LIVE_KEY, false, true, /only counts together with --live/],
    [TEST_KEY, true, true, /holds a test key/],
    [TEST_KEY, true, false, /holds a test key/],
    [TEST_KEY, false, true, /only counts together with --live/],
    ["pk_live_x", true, true, /does not hold a Stripe secret or restricted key/],
  ] as const)("key %s live=%s confirmed=%s -> %s", (key, live, confirmed, want) => {
    const gate = resolveStripeMode({ key, envName: "OPERATOR_KEY", live, confirmed });
    if (typeof want === "string") {
      expect(gate).toEqual({ ok: true, mode: want });
      return;
    }
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.error).toMatch(want);
    expect(gate.error).not.toContain(key);
  });

  it("live is prod-only and sandbox never prod", () => {
    expect(projectModeError("live", PROD_PROJECT_ID)).toBeNull();
    expect(projectModeError("live", DEV_PROJECT_ID)).toMatch(/only targets/);
    expect(projectModeError("live", undefined)).toMatch(/only targets/);
    expect(projectModeError("sandbox", DEV_PROJECT_ID)).toBeNull();
    expect(projectModeError("sandbox", undefined)).toBeNull();
    expect(projectModeError("sandbox", PROD_PROJECT_ID)).toMatch(/never targets/);
  });

  it("webhook defaults: sandbox = dev URL + dev project, live = prod URL + prod project", () => {
    expect(webhookTarget("sandbox")).toEqual({ ok: true, url: DEV_WEBHOOK_URL, project: DEV_PROJECT_ID });
    expect(webhookTarget("live")).toEqual({ ok: true, url: LIVE_WEBHOOK_URL, project: PROD_PROJECT_ID });
    expect(LIVE_WEBHOOK_URL).toBe("https://pinneds.com/api/billing/stripe/webhook");
    expect(PROD_PROJECT_ID).toBe("moriacrew-pinned-prod");
    const other = "https://example.test/hook";
    expect(webhookTarget("sandbox", { url: other })).toMatchObject({ ok: true, url: other });
  });

  it("webhook overrides cannot cross modes", () => {
    expect(webhookTarget("live", { project: DEV_PROJECT_ID }).ok).toBe(false);
    expect(webhookTarget("live", { url: DEV_WEBHOOK_URL }).ok).toBe(false);
    expect(webhookTarget("sandbox", { project: PROD_PROJECT_ID }).ok).toBe(false);
    expect(webhookTarget("sandbox", { url: LIVE_WEBHOOK_URL }).ok).toBe(false);
  });
});

// --- Script level: the real scripts, fake Stripe + fake gcloud. ---

const ROOT = path.resolve(__dirname, "../..");
const WORK = mkdtempSync(path.join(tmpdir(), "pin210-"));
afterAll(() => rmSync(WORK, { recursive: true, force: true }));

const PRELOAD = path.join(WORK, "fake-stripe.mjs");
writeFileSync(
  PRELOAD,
  `import { appendFileSync } from "node:fs";
const endpoints = [];
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const body = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : ""));
  appendFileSync(process.env.FAKE_STRIPE_LOG, JSON.stringify({ method, path: url.pathname, query: url.search, body }) + "\\n");
  if (method === "GET") return json({ data: url.pathname === "/v1/webhook_endpoints" ? endpoints : [], has_more: false });
  if (url.pathname === "/v1/webhook_endpoints") {
    const events = Object.keys(body).filter((k) => k.startsWith("enabled_events[")).map((k) => body[k]);
    const created = { id: "we_fake", url: body.url, status: "enabled", enabled_events: events, api_version: body.api_version };
    endpoints.push(created);
    return json({ ...created, secret: process.env.FAKE_SIGNING_SECRET });
  }
  return json({ error: { message: "fake: write not modelled" } }, 400);
};
`,
);
const BIN = path.join(WORK, "bin");
const GCLOUD = path.join(BIN, "gcloud");
mkdirSync(BIN);
writeFileSync(
  GCLOUD,
  `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"
case "$1 $2" in
  "secrets describe") echo "ERROR: NOT_FOUND: secret not found" >&2; exit 1 ;;
  "secrets create") cat > "$FAKE_GCLOUD_STDIN"; exit 0 ;;
  "secrets get-iam-policy") echo '{"bindings":[{"role":"roles/secretmanager.secretAccessor","members":["serviceAccount:apphosting@example.test"]}]}'; exit 0 ;;
  "secrets add-iam-policy-binding") exit 0 ;;
esac
exit 3
`,
);
chmodSync(GCLOUD, 0o755);

let runs = 0;
function runScript(script: string, key: string, args: string[]) {
  runs += 1;
  const files = {
    stripeLog: path.join(WORK, `stripe-${runs}.log`),
    gcloudLog: path.join(WORK, `gcloud-${runs}.log`),
    gcloudStdin: path.join(WORK, `stdin-${runs}.txt`),
  };
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(PRELOAD).href, path.join(ROOT, "scripts", script), "--env-var", "OPERATOR_KEY", ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 20_000,
      // A clean env: no real Stripe key or ADC can leak in from the host.
      env: {
        NODE_ENV: "test",
        PATH: `${BIN}${path.delimiter}${process.env.PATH ?? ""}`,
        OPERATOR_KEY: key,
        FAKE_STRIPE_LOG: files.stripeLog,
        FAKE_GCLOUD_LOG: files.gcloudLog,
        FAKE_GCLOUD_STDIN: files.gcloudStdin,
        FAKE_SIGNING_SECRET: SIGNING,
      },
    },
  );
  const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8") : "");
  const stripeCalls = read(files.stripeLog)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; path: string; query: string; body: Record<string, string> });
  const output = `${result.stdout}${result.stderr}`;
  return {
    code: result.status,
    stdout: result.stdout,
    output,
    stripeCalls,
    gcloudCalls: read(files.gcloudLog).split("\n").filter(Boolean),
    gcloudStdin: read(files.gcloudStdin),
  };
}

const SCRIPTS = [
  "seed-stripe-catalog.mjs",
  "ensure-stripe-webhook-endpoint.mjs",
  "billing-reconciliation.mjs",
];

describe("operator scripts refuse before any network call (PIN-210)", () => {
  it.each(
    SCRIPTS.flatMap((script) => [
      [script, LIVE_KEY, [] as string[]],
      [script, LIVE_KEY, [LIVE_FLAG]],
      [script, LIVE_KEY, [LIVE_CONFIRM_FLAG]],
      [script, TEST_KEY, BOTH],
      [script, "pk_live_x", BOTH],
    ]),
  )("%s key=%s %j exits 2", (script, key, args) => {
    const run = runScript(script, key, args);
    expect(run.code).toBe(2);
    expect(run.stripeCalls).toEqual([]);
    expect(run.gcloudCalls).toEqual([]);
    expect(run.output).not.toContain(key);
  });

  it("webhook and reconciliation refuse a live run against the dev project", () => {
    for (const [script, flag] of [
      ["ensure-stripe-webhook-endpoint.mjs", "--secret-project"],
      ["billing-reconciliation.mjs", "--project"],
    ]) {
      const run = runScript(script, LIVE_KEY, [...BOTH, flag, DEV_PROJECT_ID]);
      expect(run.code).toBe(2);
      expect(run.output).toMatch(/only targets project moriacrew-pinned-prod/);
      expect(run.stripeCalls).toEqual([]);
    }
    // Live reconciliation never falls back to ADC/env: --project is required.
    expect(runScript("billing-reconciliation.mjs", LIVE_KEY, BOTH).code).toBe(2);
    // Sandbox never reads prod.
    expect(
      runScript("billing-reconciliation.mjs", TEST_KEY, ["--project", PROD_PROJECT_ID]).code,
    ).toBe(2);
  });
});

describe("catalog seed dry-run (PIN-210)", () => {
  it("live: plans the pack, skips the draft host plan, only reads", () => {
    const run = runScript("seed-stripe-catalog.mjs", LIVE_KEY, BOTH);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("mode=dry-run stripe=live");
    expect(run.stdout).toContain("Draft items skipped: host_monthly");
    expect(run.stdout).toContain("plus_20 product=create id=new price=create id=new");
    expect(run.stdout).toContain("credits_25 product=retired");
    expect(run.stdout).not.toContain("host_monthly product=");
    expect(run.stripeCalls.every((call) => call.method === "GET")).toBe(true);
    expect(run.stripeCalls.map((call) => call.query).join(" ")).not.toContain("pinneds_host_monthly");
    expect(run.output).not.toContain(LIVE_KEY);
  });

  it("sandbox: unchanged, still plans the draft host plan", () => {
    const run = runScript("seed-stripe-catalog.mjs", TEST_KEY, []);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("mode=dry-run stripe=sandbox");
    expect(run.stdout).toContain("host_monthly product=create");
    expect(run.stdout).not.toContain("LIVE");
    expect(run.stripeCalls.every((call) => call.method === "GET")).toBe(true);
  });
});

describe("webhook endpoint ensure (PIN-210)", () => {
  it("sandbox dry-run keeps the dev URL and dev project", () => {
    const run = runScript("ensure-stripe-webhook-endpoint.mjs", TEST_KEY, []);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`stripe=sandbox keyEnv=OPERATOR_KEY url=${DEV_WEBHOOK_URL} secretProject=${DEV_PROJECT_ID}`);
    expect(run.stdout).toContain("existing endpoints in sandbox: 0");
    expect(run.stdout).toContain("dry-run only");
    expect(run.stripeCalls.every((call) => call.method === "GET")).toBe(true);
    expect(run.gcloudCalls).toEqual([]);
  });

  it("live dry-run defaults to the prod URL and prod project and creates nothing", () => {
    const run = runScript("ensure-stripe-webhook-endpoint.mjs", LIVE_KEY, BOTH);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`stripe=live keyEnv=OPERATOR_KEY url=${LIVE_WEBHOOK_URL} secretProject=${PROD_PROJECT_ID}`);
    expect(run.stdout).toContain("plan=create");
    expect(run.stripeCalls.every((call) => call.method === "GET")).toBe(true);
    expect(run.gcloudCalls).toEqual([]);
  });

  // The fake gcloud is a POSIX shell script (the script spawns gcloud.cmd on Windows).
  it.skipIf(process.platform === "win32")("live apply pipes the signing secret over stdin into prod and mirrors IAM there", () => {
    const run = runScript("ensure-stripe-webhook-endpoint.mjs", LIVE_KEY, [...BOTH, "--apply"]);
    expect(run.code).toBe(0);
    const create = run.stripeCalls.find((call) => call.method === "POST");
    expect(create?.body.url).toBe(LIVE_WEBHOOK_URL);
    expect(create?.body.description).toBe("Pinneds prod Board Plus webhook (PIN-210)");
    expect(Object.keys(create?.body ?? {}).filter((k) => k.startsWith("enabled_events["))).toHaveLength(
      STRIPE_WEBHOOK_EVENT_TYPES.length,
    );
    expect(run.gcloudCalls.length).toBeGreaterThan(0);
    for (const call of run.gcloudCalls) expect(call).toContain(`--project ${PROD_PROJECT_ID}`);
    expect(run.gcloudCalls).toContain(
      `secrets create STRIPE_WEBHOOK_SECRET --project ${PROD_PROJECT_ID} --replication-policy=automatic --data-file=-`,
    );
    expect(run.gcloudCalls).toContain(
      `secrets get-iam-policy STRIPE_SECRET_KEY --project ${PROD_PROJECT_ID} --format json`,
    );
    expect(run.gcloudCalls.some((call) => call.startsWith("secrets add-iam-policy-binding STRIPE_WEBHOOK_SECRET"))).toBe(true);
    // The one-time secret travels by stdin only: never argv, never output.
    expect(run.gcloudStdin).toBe(SIGNING);
    expect(run.gcloudCalls.join("\n")).not.toContain(SIGNING);
    expect(run.output).not.toContain(SIGNING);
    expect(run.output).not.toContain(LIVE_KEY);
    expect(run.stdout).toContain(`secret stored (value never printed): project=${PROD_PROJECT_ID}`);
  });
});
