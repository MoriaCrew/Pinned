import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ID,
  CATALOG_ITEMS,
  CATALOG_VERSION,
  assertValidCatalog,
  buildCatalogPlan,
  catalogItemsForMode,
  catalogMetadata,
  catalogValidationErrors,
  findCatalogItem,
  planPrice,
  planProduct,
  type CatalogItem,
  type ExistingPrice,
  type ExistingProduct,
} from "./catalog";

const pack = findCatalogItem("pinneds_plus_20")!;
const retired25 = findCatalogItem("pinneds_credits_25")!;
const hostMonthly = findCatalogItem("pinneds_host_monthly")!;

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return { ...pack, ...overrides };
}

function product(overrides: Partial<ExistingProduct> = {}): ExistingProduct {
  return {
    id: "prod_20",
    name: pack.name,
    description: pack.description,
    active: true,
    metadata: catalogMetadata(pack),
    ...overrides,
  };
}

function price(overrides: Partial<ExistingPrice> = {}): ExistingPrice {
  return {
    id: "price_20",
    lookup_key: pack.lookupKey,
    product: "prod_20",
    unit_amount: pack.unitAmount,
    currency: pack.currency,
    tax_behavior: pack.taxBehavior,
    recurring: null,
    active: true,
    metadata: catalogMetadata(pack),
    ...overrides,
  };
}

describe("catalog manifest (PIN-146, PIN-181)", () => {
  it("pins one live pack, the retired makes packs and the draft plan, EUR TTC", () => {
    expect(
      CATALOG_ITEMS.map((i) => [
        i.itemKey,
        i.lookupKey,
        i.credits ?? null,
        i.unitAmount,
        i.currency,
        i.recurring?.interval ?? null,
        i.status,
      ]),
    ).toEqual([
      ["plus_20", "pinneds_plus_20", 20, 299, "eur", null, "live"],
      ["credits_25", "pinneds_credits_25", 25, 499, "eur", null, "retired"],
      ["credits_60", "pinneds_credits_60", 60, 999, "eur", null, "retired"],
      ["credits_150", "pinneds_credits_150", 150, 1999, "eur", null, "retired"],
      ["host_monthly", "pinneds_host_monthly", null, 499, "eur", "month", "draft"],
    ]);
    for (const i of CATALOG_ITEMS) {
      expect(i.taxBehavior).toBe("inclusive");
      if (i.status === "live" && i.credits !== undefined) {
        // Customer copy on the Stripe Checkout page says "creations".
        expect(i.name).toContain(`${i.credits} creations`);
        expect(i.description).toContain(`${i.credits} creations`);
        expect(i.description).toContain("Board Plus");
      }
    }
  });

  it("stamps catalog metadata, with credits only on credit packs", () => {
    expect(catalogMetadata(pack)).toEqual({
      catalog: CATALOG_ID,
      item_key: "plus_20",
      credits: "20",
      catalog_version: CATALOG_VERSION,
    });
    expect(catalogMetadata(hostMonthly)).toEqual({
      catalog: CATALOG_ID,
      item_key: "host_monthly",
      catalog_version: CATALOG_VERSION,
    });
  });

  it("the committed manifest is valid", () => {
    expect(catalogValidationErrors(CATALOG_ITEMS)).toEqual([]);
    expect(() => assertValidCatalog(CATALOG_ITEMS)).not.toThrow();
  });

  it("rejects duplicate lookup keys and duplicate item keys", () => {
    const dupLookup = catalogValidationErrors([
      item(),
      item({ itemKey: "other_key" }),
    ]);
    expect(dupLookup.join("\n")).toContain("duplicate lookupKey");
    const dupItem = catalogValidationErrors([
      item(),
      item({ lookupKey: "other_lookup" }),
    ]);
    expect(dupItem.join("\n")).toContain("duplicate itemKey");
    expect(() => assertValidCatalog([item(), item()])).toThrow(
      /duplicate lookupKey/,
    );
  });

  it("rejects non-positive and non-integer amounts and credits", () => {
    for (const unitAmount of [0, -299, 2.99, Number.NaN]) {
      expect(
        catalogValidationErrors([item({ unitAmount })]).join("\n"),
      ).toContain("unitAmount must be a positive integer");
    }
    for (const credits of [0, -1, 2.5]) {
      expect(catalogValidationErrors([item({ credits })]).join("\n")).toContain(
        "credits must be a positive integer",
      );
    }
    expect(catalogValidationErrors([]).join("\n")).toContain("no items");
  });
});

describe("catalog convergence plan (PIN-146)", () => {
  it("product: create when no metadata match, reuse when converged, update on drift", () => {
    expect(planProduct(pack, [])).toEqual({ kind: "create" });
    // Same name but no catalog metadata: not ours, still create.
    expect(planProduct(pack, [product({ metadata: {} })])).toEqual({
      kind: "create",
    });
    expect(planProduct(pack, [product()])).toEqual({
      kind: "reuse",
      productId: "prod_20",
    });
    expect(planProduct(pack, [product({ name: "Old copy" })])).toEqual({
      kind: "update",
      productId: "prod_20",
    });
    expect(
      planProduct(pack, [
        product({
          metadata: { ...catalogMetadata(pack), catalog_version: "old" },
        }),
      ]),
    ).toEqual({ kind: "update", productId: "prod_20" });
    expect(planProduct(pack, [product({ active: false })])).toEqual({
      kind: "update",
      productId: "prod_20",
    });
  });

  it("price: create when the lookup key is unused, reuse on an exact match", () => {
    expect(planPrice(pack, "prod_20", [])).toEqual({ kind: "create" });
    expect(planPrice(pack, "prod_20", [price()])).toEqual({
      kind: "reuse",
      priceId: "price_20",
    });
  });

  it("price: any immutable-field drift transfers the lookup key", () => {
    const drifts: Partial<ExistingPrice>[] = [
      { unit_amount: 599 }, // amount changed
      { currency: "usd" },
      { product: "prod_other" },
      { tax_behavior: "exclusive" },
      { tax_behavior: null },
      { recurring: { interval: "month" } }, // one-time pack priced as a sub
      { active: false }, // archived prices cannot be reused
    ];
    for (const drift of drifts) {
      expect(planPrice(pack, "prod_20", [price(drift)])).toEqual({
        kind: "transfer",
        oldPriceId: "price_20",
      });
    }
  });

  it("price: the recurring host price reuses only a monthly match", () => {
    const monthly = price({
      id: "price_host",
      lookup_key: hostMonthly.lookupKey,
      product: "prod_host",
      unit_amount: hostMonthly.unitAmount,
      recurring: { interval: "month" },
    });
    expect(planPrice(hostMonthly, "prod_host", [monthly])).toEqual({
      kind: "reuse",
      priceId: "price_host",
    });
    expect(
      planPrice(hostMonthly, "prod_host", [{ ...monthly, recurring: null }]),
    ).toEqual({ kind: "transfer", oldPriceId: "price_host" });
  });

  it("retired (PIN-181): archives the product and every active price, then no-ops", () => {
    const retiredProduct = product({
      id: "prod_25",
      name: retired25.name,
      description: retired25.description,
      metadata: catalogMetadata(retired25),
    });
    const livePrice = price({
      id: "price_25",
      lookup_key: retired25.lookupKey,
      product: "prod_25",
      unit_amount: retired25.unitAmount,
    });
    expect(planProduct(retired25, [retiredProduct, product()])).toEqual({
      kind: "archive",
      productId: "prod_25",
    });
    expect(
      planPrice(retired25, "prod_25", [
        livePrice,
        { ...livePrice, id: "price_25_b", product: "prod_other" },
        { ...livePrice, id: "price_25_old", active: false },
        price(),
      ]),
    ).toEqual({ kind: "archive", priceIds: ["price_25", "price_25_b"] });
    // Already archived, or never created: nothing to do, never a create.
    expect(planProduct(retired25, [{ ...retiredProduct, active: false }])).toEqual({
      kind: "retired",
    });
    expect(planProduct(retired25, [])).toEqual({ kind: "retired" });
    expect(planPrice(retired25, "prod_25", [{ ...livePrice, active: false }])).toEqual({
      kind: "retired",
    });
    expect(planPrice(retired25, "", [])).toEqual({ kind: "retired" });
  });

  it("buildCatalogPlan combines both decisions per item", () => {
    const plan = buildCatalogPlan(CATALOG_ITEMS, [product()], [price()]);
    expect(plan.map((entry) => [entry.item.itemKey, entry.product.kind, entry.price.kind])).toEqual([
      ["plus_20", "reuse", "reuse"],
      // Retired items missing from the sandbox: nothing to create.
      ["credits_25", "retired", "retired"],
      ["credits_60", "retired", "retired"],
      ["credits_150", "retired", "retired"],
      ["host_monthly", "create", "create"],
    ]);
  });

  it("live mode (PIN-210) skips drafts but keeps live and retired items; sandbox takes all", () => {
    expect(catalogItemsForMode(CATALOG_ITEMS, "sandbox")).toEqual([...CATALOG_ITEMS]);
    const live = catalogItemsForMode(CATALOG_ITEMS, "live");
    expect(live.map((i) => i.itemKey)).toEqual(["plus_20", "credits_25", "credits_60", "credits_150"]);
    // A fresh live account: create the pack, nothing to archive, no host plan.
    expect(
      buildCatalogPlan(live, [], []).map((e) => [e.item.itemKey, e.product.kind, e.price.kind]),
    ).toEqual([
      ["plus_20", "create", "create"],
      ["credits_25", "retired", "retired"],
      ["credits_60", "retired", "retired"],
      ["credits_150", "retired", "retired"],
    ]);
  });

  it("buildCatalogPlan refuses an invalid manifest", () => {
    expect(() => buildCatalogPlan([item(), item()], [], [])).toThrow(
      /duplicate lookupKey/,
    );
  });
});

describe("seed script mirror (PIN-146)", () => {
  it("scripts/seed-stripe-catalog.mjs carries the same manifest", () => {
    const script = readFileSync(
      path.resolve(__dirname, "../../scripts/seed-stripe-catalog.mjs"),
      "utf8",
    );
    expect(script).toContain(`const CATALOG_VERSION = "${CATALOG_VERSION}";`);
    // Evaluate the mirror's array literal and compare every field
    // (credits and status included), in both directions.
    const literal = /const CATALOG_ITEMS = (\[[\s\S]*?\n\]);/.exec(script)?.[1];
    expect(literal).toBeDefined();
    const mirror: unknown = new Function(`return ${literal};`)();
    expect(mirror).toEqual(CATALOG_ITEMS);
    expect(script).toContain('item.status === "retired"');
    // PIN-210: the same live filter as catalogItemsForMode.
    expect(script).toContain(
      'mode === "live" ? items.filter((item) => item.status !== "draft") : [...items]',
    );
  });
});
