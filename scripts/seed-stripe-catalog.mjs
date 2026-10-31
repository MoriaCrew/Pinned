#!/usr/bin/env node
/**
 * PIN-146 Stripe catalog seeder (operator-run, sandbox only,
 * never CI). Converges a Stripe test sandbox onto the committed
 * catalog manifest: `src/billing/catalog.ts` is the source of
 * truth and the CATALOG_ITEMS mirror below must stay in sync
 * (pinned by src/billing/catalog.test.ts).
 *
 *   node --env-file=.env.local scripts/seed-stripe-catalog.mjs \
 *     --env-var STRIPE_PINNED_LOCAL_AGENT_KEY            # dry-run
 *   node --env-file=.env.local scripts/seed-stripe-catalog.mjs \
 *     --env-var STRIPE_PINNED_LOCAL_AGENT_KEY --apply    # mutate
 *
 * Plain fetch against api.stripe.com — no SDK dependency. The
 * secret is read from the env var NAMED by --env-var (default
 * STRIPE_SECRET_KEY) and is never printed; output carries item
 * keys, actions and Stripe object ids only. Live keys are
 * refused. Convergence rules:
 * - product matched by metadata catalog + item_key (paginated);
 *   created when missing, updated in place on copy/metadata drift.
 * - price matched by lookup_key; reused on an exact match of
 *   amount/currency/product/tax_behavior/recurrence, otherwise a
 *   new price is minted with transfer_lookup_key=true and the
 *   old price is archived. POSTs carry idempotency keys.
 * - a "retired" item is archived (PIN-181): its product and every
 *   active price under its lookup key get active=false; nothing
 *   is ever created for it.
 * Re-running a converged sandbox is a no-op (zero duplicates).
 */

// --- Manifest mirror of src/billing/catalog.ts — keep in sync. ---
const CATALOG_ID = "pinneds";
const CATALOG_VERSION = "dev-v1";
const CATALOG_ITEMS = [
  {
    itemKey: "plus_20",
    lookupKey: "pinneds_plus_20",
    name: "Board Plus · 20 creations",
    description:
      "Board Plus for one board: every look, foil stickers and 20 creations (photos and scenes). Nothing expires.",
    unitAmount: 299,
    currency: "eur",
    taxBehavior: "inclusive",
    credits: 20,
    status: "live",
  },
  {
    itemKey: "credits_25",
    lookupKey: "pinneds_credits_25",
    name: "Pinneds Studio makes - 25",
    description:
      "Adds 25 AI makes to one Pinneds board. A make is one photo add with cut-outs or one AI scene/remix. Makes are used inside that board only.",
    unitAmount: 499,
    currency: "eur",
    taxBehavior: "inclusive",
    credits: 25,
    status: "retired",
  },
  {
    itemKey: "credits_60",
    lookupKey: "pinneds_credits_60",
    name: "Pinneds Studio makes - 60",
    description:
      "Adds 60 AI makes to one Pinneds board. A make is one photo add with cut-outs or one AI scene/remix. Makes are used inside that board only.",
    unitAmount: 999,
    currency: "eur",
    taxBehavior: "inclusive",
    credits: 60,
    status: "retired",
  },
  {
    itemKey: "credits_150",
    lookupKey: "pinneds_credits_150",
    name: "Pinneds Studio makes - 150",
    description:
      "Adds 150 AI makes to one Pinneds board. A make is one photo add with cut-outs or one AI scene/remix. Makes are used inside that board only.",
    unitAmount: 1999,
    currency: "eur",
    taxBehavior: "inclusive",
    credits: 150,
    status: "retired",
  },
  {
    itemKey: "host_monthly",
    lookupKey: "pinneds_host_monthly",
    name: "Pinneds Host plan - monthly (draft)",
    description:
      "Draft sandbox host plan for technical subscription testing. Not part of the board makes launch.",
    unitAmount: 499,
    currency: "eur",
    taxBehavior: "inclusive",
    recurring: { interval: "month" },
    status: "draft",
  },
];

function catalogMetadata(item) {
  return {
    catalog: CATALOG_ID,
    item_key: item.itemKey,
    ...(item.credits !== undefined ? { credits: String(item.credits) } : {}),
    catalog_version: CATALOG_VERSION,
  };
}

// Mirror of catalogValidationErrors in src/billing/catalog.ts.
function catalogValidationErrors(items) {
  const errors = [];
  if (items.length === 0) errors.push("catalog has no items");
  const seenItemKeys = new Set();
  const seenLookupKeys = new Set();
  for (const item of items) {
    const label = item.itemKey || item.lookupKey || "(unnamed item)";
    if (!item.itemKey) errors.push(`${label}: itemKey is empty`);
    if (!item.lookupKey) errors.push(`${label}: lookupKey is empty`);
    if (item.itemKey && seenItemKeys.has(item.itemKey)) {
      errors.push(`${label}: duplicate itemKey "${item.itemKey}"`);
    }
    if (item.lookupKey && seenLookupKeys.has(item.lookupKey)) {
      errors.push(`${label}: duplicate lookupKey "${item.lookupKey}"`);
    }
    seenItemKeys.add(item.itemKey);
    seenLookupKeys.add(item.lookupKey);
    if (!item.name.trim()) errors.push(`${label}: name is empty`);
    if (!Number.isInteger(item.unitAmount) || item.unitAmount <= 0) {
      errors.push(`${label}: unitAmount must be a positive integer, got ${item.unitAmount}`);
    }
    if (!/^[a-z]{3}$/.test(item.currency)) {
      errors.push(`${label}: currency must be a lowercase ISO code, got "${item.currency}"`);
    }
    if (item.credits !== undefined && (!Number.isInteger(item.credits) || item.credits <= 0)) {
      errors.push(`${label}: credits must be a positive integer, got ${item.credits}`);
    }
  }
  return errors;
}

// Mirrors of planProduct / planPrice in src/billing/catalog.ts.
function metadataMatches(actual, expected) {
  return Object.entries(expected).every(([k, v]) => actual?.[k] === v);
}

function matchingProducts(item, products) {
  return products.filter(
    (p) => p.metadata?.catalog === CATALOG_ID && p.metadata?.item_key === item.itemKey,
  );
}

function planProduct(item, products) {
  const existing = matchingProducts(item, products)[0];
  if (item.status === "retired") {
    return existing && existing.active !== false
      ? { kind: "archive", productId: existing.id }
      : { kind: "retired" };
  }
  if (!existing) return { kind: "create" };
  const drifted =
    existing.name !== item.name ||
    (existing.description ?? "") !== item.description ||
    existing.active === false ||
    !metadataMatches(existing.metadata, catalogMetadata(item));
  return drifted
    ? { kind: "update", productId: existing.id }
    : { kind: "reuse", productId: existing.id };
}

function planPrice(item, productId, prices) {
  if (item.status === "retired") {
    const priceIds = prices
      .filter((p) => p.lookup_key === item.lookupKey && p.active !== false)
      .map((p) => p.id);
    return priceIds.length > 0 ? { kind: "archive", priceIds } : { kind: "retired" };
  }
  const existing = prices.find((p) => p.lookup_key === item.lookupKey);
  if (!existing) return { kind: "create" };
  const matches =
    existing.unit_amount === item.unitAmount &&
    existing.currency === item.currency &&
    existing.product === productId &&
    (existing.tax_behavior ?? "unspecified") === item.taxBehavior &&
    (existing.recurring?.interval ?? null) === (item.recurring?.interval ?? null) &&
    existing.active !== false;
  return matches
    ? { kind: "reuse", priceId: existing.id }
    : { kind: "transfer", oldPriceId: existing.id };
}

// --- Stripe API over plain fetch (form-encoded, no SDK). ---

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

async function listAll(path, params = {}) {
  const out = [];
  let startingAfter;
  for (;;) {
    const page = await stripe("GET", path, {
      ...params,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    out.push(...(page.data ?? []));
    if (!page.has_more || !page.data?.length) return out;
    startingAfter = page.data[page.data.length - 1].id;
  }
}

async function fetchState() {
  const products = await listAll("/products");
  const prices = await listAll("/prices", {
    lookup_keys: CATALOG_ITEMS.map((i) => i.lookupKey),
  });
  return { products, prices };
}

// --- Execution. ---

const idem = (what, item, extra = "") =>
  `pinneds-catalog-${CATALOG_VERSION}-${what}-${item.itemKey}${extra}`;

/** Retired item: archive its active prices, then its product. Already archived = no-op. */
async function retireItem(item, state) {
  const pricePlan = planPrice(item, "", state.prices);
  for (const priceId of pricePlan.kind === "archive" ? pricePlan.priceIds : []) {
    await stripe("POST", `/prices/${priceId}`, { active: false }, idem("price-archive", item, `-${priceId}`));
    console.log(`${item.itemKey} price=archive id=${priceId}`);
  }
  const plan = planProduct(item, state.products);
  if (plan.kind === "archive") {
    await stripe(
      "POST",
      `/products/${plan.productId}`,
      { active: false },
      idem("product-archive", item, `-${plan.productId}`),
    );
    console.log(`${item.itemKey} product=archive id=${plan.productId}`);
  }
  if (plan.kind === "retired" && pricePlan.kind === "retired") {
    console.log(`${item.itemKey} retired (nothing active)`);
  }
}

async function applyItem(item, state) {
  if (item.status === "retired") return retireItem(item, state);
  const plan = planProduct(item, state.products);
  let productId;
  if (plan.kind === "create") {
    const created = await stripe(
      "POST",
      "/products",
      { name: item.name, description: item.description, metadata: catalogMetadata(item) },
      idem("product-create", item),
    );
    productId = created.id;
    console.log(`${item.itemKey} product=create id=${productId}`);
  } else {
    productId = plan.productId;
    if (plan.kind === "update") {
      await stripe(
        "POST",
        `/products/${productId}`,
        {
          name: item.name,
          description: item.description,
          active: true,
          metadata: catalogMetadata(item),
        },
        idem("product-update", item),
      );
      console.log(`${item.itemKey} product=update id=${productId}`);
    } else {
      console.log(`${item.itemKey} product=reuse id=${productId}`);
    }
  }

  const pricePlan = planPrice(item, productId, state.prices);
  const priceParams = {
    product: productId,
    unit_amount: item.unitAmount,
    currency: item.currency,
    tax_behavior: item.taxBehavior,
    lookup_key: item.lookupKey,
    metadata: catalogMetadata(item),
    ...(item.recurring ? { recurring: { interval: item.recurring.interval } } : {}),
  };
  if (pricePlan.kind === "reuse") {
    const existing = state.prices.find((p) => p.id === pricePlan.priceId);
    if (!metadataMatches(existing?.metadata, catalogMetadata(item))) {
      await stripe(
        "POST",
        `/prices/${pricePlan.priceId}`,
        { metadata: catalogMetadata(item) },
        idem("price-metadata", item),
      );
      console.log(`${item.itemKey} price=reuse+metadata id=${pricePlan.priceId}`);
    } else {
      console.log(`${item.itemKey} price=reuse id=${pricePlan.priceId}`);
    }
    return { itemKey: item.itemKey, productId, priceId: pricePlan.priceId };
  }
  if (pricePlan.kind === "create") {
    const created = await stripe(
      "POST",
      "/prices",
      priceParams,
      idem("price-create", item, `-${productId}`),
    );
    console.log(`${item.itemKey} price=create id=${created.id}`);
    return { itemKey: item.itemKey, productId, priceId: created.id };
  }
  // transfer: mint the replacement carrying the lookup key, archive the old.
  const created = await stripe(
    "POST",
    "/prices",
    { ...priceParams, transfer_lookup_key: true },
    idem("price-transfer", item, `-${productId}-${item.unitAmount}`),
  );
  await stripe(
    "POST",
    `/prices/${pricePlan.oldPriceId}`,
    { active: false },
    idem("price-archive", item, `-${pricePlan.oldPriceId}`),
  );
  console.log(
    `${item.itemKey} price=transfer id=${created.id} archived=${pricePlan.oldPriceId}`,
  );
  return { itemKey: item.itemKey, productId, priceId: created.id };
}

function describePlan(state) {
  for (const item of CATALOG_ITEMS) {
    const product = planProduct(item, state.products);
    const productId = product.productId ?? "";
    const price = planPrice(item, productId, state.prices);
    if (item.status === "retired") {
      console.log(
        `${item.itemKey} product=${product.kind} id=${productId || "none"} ` +
          `price=${price.kind} ids=${(price.priceIds ?? []).join(",") || "none"}`,
      );
      continue;
    }
    const priceId =
      price.kind === "reuse"
        ? price.priceId
        : price.kind === "transfer"
          ? `new (archives ${price.oldPriceId})`
          : "new";
    console.log(
      `${item.itemKey} product=${product.kind} id=${productId || "new"} ` +
        `price=${price.kind} id=${priceId}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const envIdx = args.indexOf("--env-var");
  const envName = envIdx >= 0 ? args[envIdx + 1] : "STRIPE_SECRET_KEY";
  if (!envName || envName.startsWith("--")) {
    console.error("usage: seed-stripe-catalog.mjs --env-var <ENV_VAR_NAME> [--apply]");
    process.exit(2);
  }
  const errors = catalogValidationErrors(CATALOG_ITEMS);
  if (errors.length > 0) {
    console.error(`Invalid catalog manifest:\n- ${errors.join("\n- ")}`);
    process.exit(2);
  }
  apiKey = process.env[envName] ?? "";
  if (!apiKey) {
    console.error(`Env var ${envName} is not set; refusing to run.`);
    process.exit(2);
  }
  if (apiKey.includes("_live_")) {
    console.error(`Env var ${envName} holds a LIVE key; this seeder is sandbox-only.`);
    process.exit(2);
  }
  console.log(
    `catalog=${CATALOG_ID} version=${CATALOG_VERSION} mode=${apply ? "apply" : "dry-run"} keyEnv=${envName}`,
  );

  const state = await fetchState();
  for (const item of CATALOG_ITEMS) {
    const dupes = matchingProducts(item, state.products);
    if (dupes.length > 1) {
      throw new Error(
        `Multiple products carry item_key=${item.itemKey}: ${dupes.map((p) => p.id).join(", ")} — resolve manually.`,
      );
    }
  }

  if (!apply) {
    describePlan(state);
    console.log("dry-run only; pass --apply to mutate.");
    return;
  }

  for (const item of CATALOG_ITEMS) await applyItem(item, state);

  // Self-check: a converged sandbox plans as pure reuse (retired: nothing active).
  const after = await fetchState();
  const ids = {};
  for (const item of CATALOG_ITEMS) {
    const product = planProduct(item, after.products);
    const productId = product.productId ?? "";
    const price = planPrice(item, productId, after.prices);
    const done = item.status === "retired" ? "retired" : "reuse";
    if (product.kind !== done || price.kind !== done) {
      throw new Error(
        `Post-apply state did not converge for ${item.itemKey}: product=${product.kind} price=${price.kind}`,
      );
    }
    if (item.status === "retired") continue;
    ids[item.itemKey] = { product: productId, price: price.priceId };
    console.log(`${item.itemKey} product=${productId} price=${price.priceId}`);
  }
  console.log(`CATALOG_IDS_JSON=${JSON.stringify(ids)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
