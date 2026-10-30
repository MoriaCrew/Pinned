#!/usr/bin/env node
/**
 * PIN-153 webhook endpoint ensure (operator-run, sandbox only,
 * never CI). Idempotent, dry-run unless --apply (the PIN-146
 * catalog-seed pattern): lists webhook endpoints in the target
 * sandbox, and when none sits at the desired URL creates one
 * with exactly the documented 11 events (PIN-150). Endpoints
 * created via POST /v1/webhook_endpoints deliver snapshot
 * payloads (full resource in data.object - the classic style
 * the PIN-150 handler parses; event_payload=snapshot in the
 * newer event-destination API), rendered at the pinned API
 * version.
 *
 *   node --env-file=.env.local scripts/ensure-stripe-webhook-endpoint.mjs \
 *     --env-var STRIPE_PINNED_DEV_AGENT_KEY                 # dry-run
 *   node --env-file=.env.local scripts/ensure-stripe-webhook-endpoint.mjs \
 *     --env-var STRIPE_PINNED_DEV_AGENT_KEY --apply         # create + store
 *
 * SECRET HYGIENE: Stripe returns the signing secret exactly
 * once, on creation. It stays in this process's memory and is
 * piped to `gcloud secrets ... --data-file=-` over stdin. It is
 * NEVER printed, echoed, written to a file, or placed in a
 * command argument. The API key is read from the env var NAMED
 * by --env-var and is never printed; live keys are refused.
 * When an endpoint already exists the secret cannot be re-read
 * (Stripe never returns it again): the script verifies URL +
 * events + status and reports that an operator must roll the
 * secret in Workbench instead. After a create, Secret Manager
 * IAM bindings are mirrored from --mirror-iam-from (metadata
 * only) so the new secret carries the same accessor grants.
 * Mirrors src/billing/webhook-endpoint.ts — keep in sync.
 */
import { spawn } from "node:child_process";

// --- Mirrors of src/billing/webhook-endpoint.ts / src/config.ts / src/server/stripe-webhook.ts — keep in sync. ---
const DEFAULT_URL = "https://dev.pinneds.com/api/billing/stripe/webhook";
const API_VERSION = "2026-10-28.endive";
const EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "refund.created",
  "refund.updated",
  "refund.failed",
  "charge.dispute.created",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
  "charge.dispute.closed",
];

function planWebhookEndpoint(existing, desiredUrl, desiredEvents) {
  const found = existing.find((endpoint) => endpoint.url === desiredUrl);
  if (!found) return { kind: "create" };
  const carried = new Set(found.enabled_events ?? []);
  const wanted = new Set(desiredEvents);
  return {
    kind: "reuse",
    endpointId: found.id,
    disabled: found.status !== "enabled",
    missingEvents: desiredEvents.filter((event) => !carried.has(event)),
    extraEvents: (found.enabled_events ?? []).filter((event) => !wanted.has(event)),
  };
}

// --- Stripe API over plain fetch (form-encoded, seed pattern). ---
const API_BASE = "https://api.stripe.com/v1";
let apiKey = "";

function formBody(params) {
  const body = new URLSearchParams();
  const walk = (prefix, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((entry, i) => walk(`${prefix}[${i}]`, entry));
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
    } else {
      body.append(prefix, String(value));
    }
  };
  for (const [k, v] of Object.entries(params)) walk(k, v);
  return body;
}

async function stripe(method, path, params, idempotencyKey) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(method === "GET" && params ? `${url}?${formBody(params)}` : url, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(method !== "GET" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: method === "GET" ? undefined : formBody(params ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json?.error ?? {};
    throw new Error(
      `Stripe ${method} ${path} failed: HTTP ${res.status} ${err.code ?? ""} ${err.message ?? ""}`.trim(),
    );
  }
  return json;
}

async function listEndpoints() {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await stripe("GET", "/webhook_endpoints", {
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) return out;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

// --- gcloud helper: runs with piped stdin; callers pass NO secret in args. ---
function runGcloud(argv, stdinText) {
  // Node on Windows refuses to spawn a .cmd shim without a shell
  // (EINVAL); our args never contain spaces or shell metachars.
  const win = process.platform === "win32";
  const command = win ? "gcloud.cmd" : "gcloud";
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { stdio: ["pipe", "pipe", "pipe"], shell: win });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (stdinText !== undefined) child.stdin.write(stdinText);
    child.stdin.end();
  });
}

async function storeSecret({ project, secretName, mirrorFrom }, signingSecret) {
  const describe = await runGcloud([
    "secrets", "describe", secretName, "--project", project, "--format", "value(name)",
  ]);
  const storeArgs =
    describe.code === 0
      ? ["secrets", "versions", "add", secretName, "--project", project, "--data-file=-"]
      : [
          "secrets", "create", secretName, "--project", project,
          "--replication-policy=automatic", "--data-file=-",
        ];
  const stored = await runGcloud(storeArgs, signingSecret);
  if (stored.code !== 0) {
    throw new Error(
      `Storing the signing secret in Secret Manager failed (gcloud exit ${stored.code}). ` +
        "The endpoint exists but its secret was shown only once: roll it in Workbench, " +
        "store the new value in Secret Manager by hand, then re-run to verify. " +
        (stored.stderr.split("\n").slice(-3).join(" ").trim() || ""),
    );
  }
  console.log(
    `secret stored (value never printed): project=${project} secret=${secretName} action=${describe.code === 0 ? "versions-add" : "create"}`,
  );

  if (!mirrorFrom) return;
  const policy = await runGcloud([
    "secrets", "get-iam-policy", mirrorFrom, "--project", project, "--format", "json",
  ]);
  if (policy.code !== 0) {
    throw new Error(`Could not read IAM policy metadata from ${mirrorFrom} to mirror grants.`);
  }
  const bindings = JSON.parse(policy.stdout)?.bindings ?? [];
  for (const binding of bindings) {
    for (const member of binding.members ?? []) {
      const grant = await runGcloud([
        "secrets", "add-iam-policy-binding", secretName, "--project", project,
        `--member=${member}`, `--role=${binding.role}`,
      ]);
      if (grant.code !== 0) {
        throw new Error(`Mirroring IAM grant ${binding.role} for ${member} failed.`);
      }
      console.log(`iam mirrored from ${mirrorFrom}: role=${binding.role} member=${member}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const apply = argv.includes("--apply");
  const envName = arg("--env-var") ?? "STRIPE_SECRET_KEY";
  const url = arg("--url") ?? DEFAULT_URL;
  const project = arg("--secret-project") ?? "moriacrew-pinned-dev";
  const secretName = arg("--secret-name") ?? "STRIPE_WEBHOOK_SECRET";
  const mirrorFrom = argv.includes("--no-mirror-iam")
    ? ""
    : (arg("--mirror-iam-from") ?? "STRIPE_SECRET_KEY");
  if (!envName || envName.startsWith("--")) {
    console.error("usage: ensure-stripe-webhook-endpoint.mjs --env-var <ENV_VAR_NAME> [--apply]");
    process.exit(2);
  }
  apiKey = process.env[envName] ?? "";
  if (!apiKey) {
    console.error(`Env var ${envName} is not set; refusing to run.`);
    process.exit(2);
  }
  if (apiKey.includes("_live_")) {
    console.error(`Env var ${envName} holds a LIVE key; this script is sandbox-only.`);
    process.exit(2);
  }
  console.log(
    `webhook-endpoint mode=${apply ? "apply" : "dry-run"} keyEnv=${envName} url=${url} events=${EVENTS.length} apiVersion=${API_VERSION} payload=snapshot(v1)`,
  );

  const existing = await listEndpoints();
  console.log(`existing endpoints in sandbox: ${existing.length}`);
  for (const endpoint of existing) {
    console.log(
      `endpoint id=${endpoint.id} url=${endpoint.url} status=${endpoint.status} events=${(endpoint.enabled_events ?? []).length}`,
    );
  }
  const plan = planWebhookEndpoint(existing, url, EVENTS);

  if (plan.kind === "reuse") {
    const converged =
      !plan.disabled && plan.missingEvents.length === 0 && plan.extraEvents.length === 0;
    console.log(
      `plan=reuse endpoint=${plan.endpointId} disabled=${plan.disabled} ` +
        `missing=[${plan.missingEvents.join(",")}] extra=[${plan.extraEvents.join(",")}] converged=${converged}`,
    );
    console.log(
      "signing secret: cannot be re-read for an existing endpoint (Stripe returns it only " +
        "on creation); if Secret Manager does not already hold it, an operator must roll " +
        "the secret in Workbench and store the new value.",
    );
    if (!converged) {
      console.error("endpoint exists but is not converged; fix in Workbench (events/status).");
      process.exit(1);
    }
    return;
  }

  console.log("plan=create (no endpoint at the desired URL)");
  if (!apply) {
    console.log("dry-run only; pass --apply to create the endpoint and store its secret.");
    return;
  }

  // Preflight BEFORE creating: Stripe shows the signing secret
  // exactly once, so a broken gcloud must fail here, not after
  // the create (PIN-153 first run: the secret was lost with the
  // process and the unused endpoint had to be deleted).
  const preflight = await runGcloud([
    "secrets", "describe", secretName, "--project", project, "--format", "value(name)",
  ]).catch((error) => ({ code: -1, stdout: "", stderr: String(error?.message ?? error) }));
  if (preflight.code === -1) {
    throw new Error(`gcloud preflight failed (${preflight.stderr}); endpoint NOT created.`);
  }
  console.log(
    `gcloud preflight ok (secret ${secretName} ${preflight.code === 0 ? "exists" : "absent"})`,
  );

  // Create, then verify the endpoint really exists BEFORE
  // storing its secret: a deterministic idempotency key can
  // replay the response of an endpoint that was since deleted
  // (PIN-153 hit exactly this), so a missing endpoint retries
  // once with a fresh key. The signing secret stays in memory
  // throughout and goes straight to gcloud stdin; never logged.
  const baseIdem = `pinneds-webhook-endpoint-${Buffer.from(url).toString("base64url").slice(0, 32)}`;
  let signingSecret = "";
  let replan = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = await stripe(
      "POST",
      "/webhook_endpoints",
      {
        url,
        enabled_events: EVENTS,
        api_version: API_VERSION,
        description: "Pinneds dev credit packs webhook (PIN-153)",
      },
      attempt === 0 ? baseIdem : `${baseIdem}-r${Date.now()}`,
    );
    signingSecret = typeof created.secret === "string" ? created.secret : "";
    console.log(
      `created endpoint id=${created.id} url=${created.url} status=${created.status} events=${(created.enabled_events ?? []).length} apiVersion=${created.api_version ?? API_VERSION} attempt=${attempt + 1}`,
    );
    replan = planWebhookEndpoint(await listEndpoints(), url, EVENTS);
    if (replan.kind === "reuse" && replan.endpointId === created.id) break;
    console.log(
      "create response does not match a live endpoint (idempotent replay of a deleted endpoint?); retrying with a fresh idempotency key",
    );
    signingSecret = "";
    replan = null;
  }
  if (!replan || replan.kind !== "reuse") {
    throw new Error("Endpoint create did not produce a live endpoint after two attempts.");
  }
  if (!signingSecret) {
    throw new Error(
      "Stripe created the endpoint without returning a signing secret; roll it in " +
        "Workbench and store the value in Secret Manager by hand.",
    );
  }
  if (replan.disabled || replan.missingEvents.length > 0 || replan.extraEvents.length > 0) {
    throw new Error(`Post-create state did not converge: ${JSON.stringify(replan)}`);
  }
  await storeSecret({ project, secretName, mirrorFrom }, signingSecret);
  console.log(`converged endpoint=${replan.endpointId} events=${EVENTS.join(",")}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
