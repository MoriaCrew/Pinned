/**
 * Stripe catalog manifest (PIN-146, docs/15-board-plus.md).
 *
 * The committed source of truth for what Pinneds sells: credit
 * ("makes") packs and the draft host-monthly plan. Runtime code
 * imports this module later (checkout/webhook slices); nothing
 * here reads env or touches the network.
 *
 * `scripts/seed-stripe-catalog.mjs` mirrors this manifest to
 * converge a Stripe sandbox onto it (keep the two in sync — a
 * test in catalog.test.ts pins the mirror). Amounts are EUR
 * cents, tax-inclusive (TTC): the displayed price is the charged
 * price.
 */

/** Stripe metadata `catalog` value marking Pinneds-owned objects. */
export const CATALOG_ID = "pinneds";

/** Bump when the manifest's Stripe-facing shape changes. */
export const CATALOG_VERSION = "dev-v1";

export type CatalogItemStatus = "live" | "draft";
export type CatalogTaxBehavior = "inclusive" | "exclusive" | "unspecified";

export interface CatalogItem {
  /** Product identity: Stripe product metadata `item_key`. */
  itemKey: string;
  /** Price identity: Stripe price `lookup_key`. Stable across price transfers. */
  lookupKey: string;
  /** Customer-facing product name ("makes" copy). */
  name: string;
  description: string;
  /** Smallest currency unit (EUR cents). Must be a positive integer. */
  unitAmount: number;
  currency: string;
  taxBehavior: CatalogTaxBehavior;
  /** Makes granted by one purchase; absent for non-credit items. */
  credits?: number;
  /** Present only for subscription prices. */
  recurring?: { interval: "month" | "year" };
  /** "draft" items are seeded in Stripe but not offered by runtime yet. */
  status: CatalogItemStatus;
}

export const CATALOG_ITEMS: readonly CatalogItem[] = [
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
    status: "live",
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
    status: "live",
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
    status: "live",
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

/** Stripe metadata stamped on every catalog product and price. */
export function catalogMetadata(item: CatalogItem): Record<string, string> {
  return {
    catalog: CATALOG_ID,
    item_key: item.itemKey,
    ...(item.credits !== undefined ? { credits: String(item.credits) } : {}),
    catalog_version: CATALOG_VERSION,
  };
}

export function findCatalogItem(lookupKey: string): CatalogItem | undefined {
  return CATALOG_ITEMS.find((item) => item.lookupKey === lookupKey);
}

// ---------------------------------------------------------------------------
// Validation (pure). The seed script refuses to run on any error.
// ---------------------------------------------------------------------------

/** Every manifest problem, in item order; empty means valid. */
export function catalogValidationErrors(
  items: readonly CatalogItem[],
): string[] {
  const errors: string[] = [];
  if (items.length === 0) errors.push("catalog has no items");
  const seenItemKeys = new Set<string>();
  const seenLookupKeys = new Set<string>();
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
      errors.push(
        `${label}: unitAmount must be a positive integer, got ${item.unitAmount}`,
      );
    }
    if (!/^[a-z]{3}$/.test(item.currency)) {
      errors.push(
        `${label}: currency must be a lowercase ISO code, got "${item.currency}"`,
      );
    }
    if (
      item.credits !== undefined &&
      (!Number.isInteger(item.credits) || item.credits <= 0)
    ) {
      errors.push(
        `${label}: credits must be a positive integer, got ${item.credits}`,
      );
    }
  }
  return errors;
}

/** Throws with every problem joined, for callers that cannot proceed. */
export function assertValidCatalog(items: readonly CatalogItem[]): void {
  const errors = catalogValidationErrors(items);
  if (errors.length > 0) {
    throw new Error(`Invalid catalog manifest:\n- ${errors.join("\n- ")}`);
  }
}

// ---------------------------------------------------------------------------
// Convergence plan (pure). The seed script fetches the existing
// Stripe state, asks these functions what to do, then executes.
// ---------------------------------------------------------------------------

/** The slice of a Stripe product the plan reads. */
export interface ExistingProduct {
  id: string;
  name?: string;
  description?: string | null;
  active?: boolean;
  metadata?: Record<string, string>;
}

/** The slice of a Stripe price the plan reads. */
export interface ExistingPrice {
  id: string;
  lookup_key?: string | null;
  product: string;
  unit_amount: number | null;
  currency: string;
  tax_behavior?: string | null;
  recurring?: { interval?: string } | null;
  active?: boolean;
  metadata?: Record<string, string>;
}

export type ProductPlan =
  | { kind: "create" }
  | { kind: "reuse"; productId: string }
  | { kind: "update"; productId: string };

export type PricePlan =
  | { kind: "create" }
  | { kind: "reuse"; priceId: string }
  /** Immutable fields drifted: mint a new price, transfer the lookup key, archive the old. */
  | { kind: "transfer"; oldPriceId: string };

export interface CatalogItemPlan {
  item: CatalogItem;
  product: ProductPlan;
  price: PricePlan;
}

/** Product identity is metadata, never the (editable) name. */
export function matchProduct(
  item: CatalogItem,
  products: readonly ExistingProduct[],
): ExistingProduct | undefined {
  return products.find(
    (product) =>
      product.metadata?.catalog === CATALOG_ID &&
      product.metadata?.item_key === item.itemKey,
  );
}

function metadataMatches(
  actual: Record<string, string> | undefined,
  expected: Record<string, string>,
): boolean {
  return Object.entries(expected).every(
    ([key, value]) => actual?.[key] === value,
  );
}

export function planProduct(
  item: CatalogItem,
  products: readonly ExistingProduct[],
): ProductPlan {
  const existing = matchProduct(item, products);
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

/**
 * Price identity is the lookup key. Amount, currency, product,
 * tax behavior and recurrence are immutable on a Stripe price,
 * so any drift means a transfer, never an in-place edit.
 */
export function planPrice(
  item: CatalogItem,
  productId: string,
  prices: readonly ExistingPrice[],
): PricePlan {
  const existing = prices.find((price) => price.lookup_key === item.lookupKey);
  if (!existing) return { kind: "create" };
  const matches =
    existing.unit_amount === item.unitAmount &&
    existing.currency === item.currency &&
    existing.product === productId &&
    (existing.tax_behavior ?? "unspecified") === item.taxBehavior &&
    (existing.recurring?.interval ?? null) ===
      (item.recurring?.interval ?? null) &&
    existing.active !== false;
  return matches
    ? { kind: "reuse", priceId: existing.id }
    : { kind: "transfer", oldPriceId: existing.id };
}

/**
 * Full plan for one run. A not-yet-created product has no id, so
 * its price can only be "reuse" never; a price carrying the
 * lookup key under some other product transfers onto the new one.
 */
export function buildCatalogPlan(
  items: readonly CatalogItem[],
  products: readonly ExistingProduct[],
  prices: readonly ExistingPrice[],
): CatalogItemPlan[] {
  assertValidCatalog(items);
  return items.map((item) => {
    const product = planProduct(item, products);
    const productId = product.kind === "create" ? "" : product.productId;
    return { item, product, price: planPrice(item, productId, prices) };
  });
}
