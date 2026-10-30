import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CATALOG_ID,
  CATALOG_ITEMS,
  CATALOG_VERSION,
  assertValidCatalog,
  buildCatalogPlan,
  catalogMetadata,
  catalogValidationErrors,
  findCatalogItem,
  planPrice,
  planProduct,
  type CatalogItem,
  type ExistingPrice,
  type ExistingProduct,
} from "./catalog";

const pack25 = findCatalogItem("pinneds_credits_25")!;
const hostMonthly = findCatalogItem("pinneds_host_monthly")!;

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return { ...pack25, ...overrides };
}

function product(overrides: Partial<ExistingProduct> = {}): ExistingProduct {
  return {
    id: "prod_25",
    name: pack25.name,
    description: pack25.description,
    active: true,
    metadata: catalogMetadata(pack25),
    ...overrides,
  };
}

function price(overrides: Partial<ExistingPrice> = {}): ExistingPrice {
  return {
    id: "price_25",
    lookup_key: pack25.lookupKey,
    product: "prod_25",
    unit_amount: pack25.unitAmount,
    currency: pack25.currency,
    tax_behavior: pack25.taxBehavior,
    recurring: null,
    active: true,
    metadata: catalogMetadata(pack25),
    ...overrides,
  };
}

describe("catalog manifest (PIN-146)", () => {
  it("pins the four items with EUR TTC amounts and makes copy", () => {
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
      ["credits_25", "pinneds_credits_25", 25, 499, "eur", null, "live"],
      ["credits_60", "pinneds_credits_60", 60, 999, "eur", null, "live"],
      ["credits_150", "pinneds_credits_150", 150, 1999, "eur", null, "live"],
      ["host_monthly", "pinneds_host_monthly", null, 499, "eur", "month", "draft"],
    ]);
    for (const i of CATALOG_ITEMS) {
      expect(i.taxBehavior).toBe("inclusive");
      if (i.credits !== undefined) {
        expect(i.name).toContain("makes");
        expect(i.description).toContain("makes");
      }
    }
  });

  it("stamps catalog metadata, with credits only on credit packs", () => {
    expect(catalogMetadata(pack25)).toEqual({
      catalog: CATALOG_ID,
      item_key: "credits_25",
      credits: "25",
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
    for (const unitAmount of [0, -499, 4.99, Number.NaN]) {
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
    expect(planProduct(pack25, [])).toEqual({ kind: "create" });
    // Same name but no catalog metadata: not ours, still create.
    expect(planProduct(pack25, [product({ metadata: {} })])).toEqual({
      kind: "create",
    });
    expect(planProduct(pack25, [product()])).toEqual({
      kind: "reuse",
      productId: "prod_25",
    });
    expect(planProduct(pack25, [product({ name: "Old copy" })])).toEqual({
      kind: "update",
      productId: "prod_25",
    });
    expect(
      planProduct(pack25, [
        product({
          metadata: { ...catalogMetadata(pack25), catalog_version: "old" },
        }),
      ]),
    ).toEqual({ kind: "update", productId: "prod_25" });
    expect(planProduct(pack25, [product({ active: false })])).toEqual({
      kind: "update",
      productId: "prod_25",
    });
  });

  it("price: create when the lookup key is unused, reuse on an exact match", () => {
    expect(planPrice(pack25, "prod_25", [])).toEqual({ kind: "create" });
    expect(planPrice(pack25, "prod_25", [price()])).toEqual({
      kind: "reuse",
      priceId: "price_25",
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
      expect(planPrice(pack25, "prod_25", [price(drift)])).toEqual({
        kind: "transfer",
        oldPriceId: "price_25",
      });
    }
  });

  it("price: the recurring host price reuses only a monthly match", () => {
    const monthly = price({
      id: "price_host",
      lookup_key: hostMonthly.lookupKey,
      product: "prod_host",
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

  it("buildCatalogPlan combines both decisions per item", () => {
    const plan = buildCatalogPlan(CATALOG_ITEMS, [product()], [price()]);
    expect(plan).toHaveLength(4);
    expect(plan[0]).toMatchObject({
      product: { kind: "reuse" },
      price: { kind: "reuse" },
    });
    // Everything else is missing from the sandbox: create both.
    for (const entry of plan.slice(1)) {
      expect(entry.product.kind).toBe("create");
      expect(entry.price.kind).toBe("create");
    }
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
    expect(script).toContain(`"${CATALOG_VERSION}"`);
    for (const i of CATALOG_ITEMS) {
      expect(script).toContain(`itemKey: "${i.itemKey}"`);
      expect(script).toContain(`"${i.lookupKey}"`);
      expect(script).toContain(`unitAmount: ${i.unitAmount}`);
      expect(script).toContain(`name: "${i.name}"`);
    }
  });
});
