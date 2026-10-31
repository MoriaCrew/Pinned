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
import { CATALOG_ITEMS, catalogMetadata, type CatalogItem } from "./catalog";

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
function runScript(
  script: string,
  key: string,
  args: string[],
  fake: { preload?: string; env?: Record<string, string> } = {},
) {
  runs += 1;
  const files = {
    stripeLog: path.join(WORK, `stripe-${runs}.log`),
    gcloudLog: path.join(WORK, `gcloud-${runs}.log`),
    gcloudStdin: path.join(WORK, `stdin-${runs}.txt`),
  };
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(fake.preload ?? PRELOAD).href,
      path.join(ROOT, "scripts", script),
      "--env-var",
      "OPERATOR_KEY",
      ...args,
    ],
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
        ...fake.env,
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

// --- Catalog seed against archived prices (PIN-233 F3). ---

/**
 * A stateful fake of the catalog endpoints, Stripe-shaped where it
 * matters: GET /v1/prices lists ACTIVE prices unless `active=false`,
 * every list pages by `limit`/`starting_after` (capped by
 * FAKE_STRIPE_PAGE_SIZE), and creating a price whose lookup key
 * another price (archived or not) holds is rejected unless
 * `transfer_lookup_key=true`.
 */
const CATALOG_PRELOAD = path.join(WORK, "fake-stripe-catalog.mjs");
writeFileSync(
  CATALOG_PRELOAD,
  `import { appendFileSync, readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(process.env.FAKE_STRIPE_STATE, "utf8"));
const pageSize = Number(process.env.FAKE_STRIPE_PAGE_SIZE || 100);
let created = 0;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const metadataOf = (body) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k.startsWith("metadata[")).map(([k, v]) => [k.slice(9, -1), v]));
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const body = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : ""));
  appendFileSync(process.env.FAKE_STRIPE_LOG, JSON.stringify({ method, path: url.pathname, query: url.search, body }) + "\\n");
  const q = url.searchParams;
  const page = (rows) => {
    const after = q.get("starting_after");
    const start = after ? rows.findIndex((row) => row.id === after) + 1 : 0;
    const size = Math.min(Number(q.get("limit") || 10), pageSize);
    return json({ object: "list", data: rows.slice(start, start + size), has_more: start + size < rows.length });
  };
  if (method === "GET" && url.pathname === "/v1/products") return page(state.products);
  if (method === "GET" && url.pathname === "/v1/prices") {
    const keys = [...q.entries()].filter(([k]) => k.startsWith("lookup_keys[")).map(([, v]) => v);
    const active = q.get("active") ?? "true";
    return page(state.prices.filter((p) => String(p.active) === active && (!keys.length || keys.includes(p.lookup_key))));
  }
  if (method === "POST" && url.pathname === "/v1/prices") {
    const holder = state.prices.find((p) => p.lookup_key === body.lookup_key);
    if (holder && body.transfer_lookup_key !== "true") {
      return json({ error: { code: "lookup_key_in_use", message: "fake: lookup key already in use" } }, 400);
    }
    if (holder) holder.lookup_key = null;
    const price = {
      id: "price_new_" + ++created, active: true, lookup_key: body.lookup_key, product: body.product,
      unit_amount: Number(body.unit_amount), currency: body.currency, tax_behavior: body.tax_behavior,
      recurring: body["recurring[interval]"] ? { interval: body["recurring[interval]"] } : null,
      metadata: metadataOf(body),
    };
    state.prices.push(price);
    return json(price);
  }
  const priceId = /^\\/v1\\/prices\\/([^/]+)$/.exec(url.pathname)?.[1];
  const price = state.prices.find((p) => p.id === priceId);
  if (method === "POST" && price) {
    if (body.active !== undefined) price.active = body.active === "true";
    price.metadata = { ...price.metadata, ...metadataOf(body) };
    return json(price);
  }
  return json({ error: { message: "fake: write not modelled" } }, 400);
};
`,
);

function catalogState() {
  const plus = CATALOG_ITEMS.find((item) => item.itemKey === "plus_20")!;
  const host = CATALOG_ITEMS.find((item) => item.itemKey === "host_monthly")!;
  const product = (id: string, item: CatalogItem) => ({
    id, active: true, name: item.name, description: item.description, metadata: catalogMetadata(item),
  });
  const price = (id: string, item: CatalogItem, productId: string) => ({
    id, active: false, lookup_key: item.lookupKey, product: productId, unit_amount: item.unitAmount,
    currency: item.currency, tax_behavior: item.taxBehavior, recurring: item.recurring ?? null,
    metadata: catalogMetadata(item),
  });
  return {
    products: [product("prod_plus", plus), product("prod_host", host)],
    prices: [
      // Archived but still holding its lookup key, on the manifest's terms.
      price("price_plus", plus, "prod_plus"),
      // Archived on old terms: the amount has changed since.
      { ...price("price_host", host, "prod_host"), unit_amount: host.unitAmount + 100 },
    ],
  };
}

/** Sandbox seed run on the archived-prices fake, one price per page. */
function runCatalogSeed(args: string[]) {
  const stateFile = path.join(WORK, `catalog-state-${runs + 1}.json`);
  writeFileSync(stateFile, JSON.stringify(catalogState()));
  return runScript("seed-stripe-catalog.mjs", TEST_KEY, args, {
    preload: CATALOG_PRELOAD,
    env: { FAKE_STRIPE_STATE: stateFile, FAKE_STRIPE_PAGE_SIZE: "1" },
  });
}

describe("catalog seed sees archived prices (PIN-233 F3)", () => {
  it("dry-run pages through archived prices and plans unarchive or transfer, never a create", () => {
    const run = runCatalogSeed([]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("plus_20 product=reuse id=prod_plus price=unarchive id=price_plus");
    expect(run.stdout).toContain("host_monthly product=reuse id=prod_host price=transfer id=new (archives price_host)");
    expect(run.stdout).not.toContain("price=create");
    const archivedPages = run.stripeCalls.filter(
      (call) => call.path === "/v1/prices" && call.query.includes("active=false"),
    );
    expect(archivedPages).toHaveLength(2);
    expect(archivedPages[1].query).toContain("starting_after=price_plus");
    expect(run.stripeCalls.every((call) => call.method === "GET")).toBe(true);
  });

  it("apply reactivates the matching price and transfers the drifted key, then converges", () => {
    const run = runCatalogSeed(["--apply"]);
    expect(run.output).not.toContain("lookup key already in use");
    expect(run.code).toBe(0);
    const writes = run.stripeCalls.filter((call) => call.method === "POST");
    expect(writes.map((call) => call.path)).toEqual(["/v1/prices/price_plus", "/v1/prices", "/v1/prices/price_host"]);
    expect(writes[0].body.active).toBe("true");
    expect(writes[1].body).toMatchObject({ lookup_key: "pinneds_host_monthly", transfer_lookup_key: "true" });
    expect(run.stdout).toContain("plus_20 price=unarchive id=price_plus");
    // The post-apply self-check planned pure reuse.
    expect(run.stdout).toContain('CATALOG_IDS_JSON={"plus_20":{"product":"prod_plus","price":"price_plus"}');
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
