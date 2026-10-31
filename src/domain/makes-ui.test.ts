import { describe, expect, it } from "vitest";
import {
  CREDITS_POOL_EMPTY_CODE,
  billingBannerKind,
  creditCheckoutBody,
  formatEur,
  isPoolEmptyCode,
  makesState,
  parseBillingFlag,
  readCreditCheckoutResponse,
  urlWithoutBilling,
} from "./makes-ui";

describe("makes state (PIN-152)", () => {
  it("is empty at zero, low at the Policy threshold, ok above it", () => {
    expect(makesState(0, 5)).toBe("empty");
    expect(makesState(-1, 5)).toBe("empty");
    expect(makesState(5, 5)).toBe("low");
    expect(makesState(1, 5)).toBe("low");
    expect(makesState(6, 5)).toBe("ok");
    expect(makesState(3, 0)).toBe("ok");
  });
});

describe("billing return flag (PIN-152)", () => {
  it("parses only the flags the return redirector lands with", () => {
    expect(parseBillingFlag("processing")).toBe("processing");
    expect(parseBillingFlag("cancelled")).toBe("cancelled");
    expect(parseBillingFlag("failed")).toBe("failed");
    expect(parseBillingFlag("processing ")).toBeNull();
    expect(parseBillingFlag(["processing"])).toBeNull();
    expect(parseBillingFlag(undefined)).toBeNull();
    expect(parseBillingFlag("success")).toBeNull();
  });

  it("strips billing from the URL, keeping other params and the hash", () => {
    expect(urlWithoutBilling("https://x.test/g/abc?billing=processing&scene=s1#top")).toBe("/g/abc?scene=s1#top");
    expect(urlWithoutBilling("https://x.test/g/abc?billing=cancelled")).toBe("/g/abc");
    expect(urlWithoutBilling("https://x.test/g/abc")).toBeNull();
    expect(urlWithoutBilling("not a url")).toBeNull();
  });

  it("never calls processing a success until the count actually rises", () => {
    const base = { flag: "processing" as const, baseline: 3, current: 3, exhausted: false };
    expect(billingBannerKind(base)).toBe("processing");
    expect(billingBannerKind({ ...base, current: 28 })).toBe("added");
    expect(billingBannerKind({ ...base, current: 2 })).toBe("processing");
    expect(billingBannerKind({ ...base, exhausted: true })).toBe("checkLater");
    expect(billingBannerKind({ ...base, current: null })).toBe("processing");
    expect(billingBannerKind({ ...base, baseline: null, current: 9 })).toBe("processing");
    expect(billingBannerKind({ flag: "cancelled", baseline: 3, current: 3, exhausted: false })).toBe("cancelled");
    expect(billingBannerKind({ flag: "failed", baseline: 3, current: 3, exhausted: false })).toBe("failed");
    expect(billingBannerKind({ flag: null, baseline: 3, current: 3, exhausted: false })).toBeNull();
  });
});

describe("credits checkout answers (PIN-152)", () => {
  it("posts the chosen lookup key and follows only a safe redirect", () => {
    expect(creditCheckoutBody("pinneds_credits_60")).toEqual({ lookupKey: "pinneds_credits_60" });
    expect(readCreditCheckoutResponse(200, { status: "redirect", url: "https://checkout.stripe.com/c/pay/cs_1" })).toEqual({
      kind: "redirect",
      url: "https://checkout.stripe.com/c/pay/cs_1",
    });
    expect(readCreditCheckoutResponse(200, { status: "redirect", url: "http://evil.test" })).toEqual({
      kind: "error",
      error: "generic",
    });
    expect(readCreditCheckoutResponse(200, { status: "unavailable" })).toEqual({ kind: "unavailable" });
  });

  it("maps cap, rate-limit and join errors to their own copy", () => {
    expect(readCreditCheckoutResponse(429, { code: "intent_cap_reached" })).toEqual({ kind: "error", error: "cap" });
    expect(readCreditCheckoutResponse(429, { code: "rate_limited" })).toEqual({ kind: "error", error: "rate" });
    expect(readCreditCheckoutResponse(401, { code: "participant_required" })).toEqual({ kind: "error", error: "join" });
    expect(readCreditCheckoutResponse(503, { code: "checkout_unavailable" })).toEqual({ kind: "unavailable" });
    expect(readCreditCheckoutResponse(500, null)).toEqual({ kind: "error", error: "generic" });
  });

  it("recognises the PIN-151 pool-empty code", () => {
    expect(CREDITS_POOL_EMPTY_CODE).toBe("credits_pool_empty");
    expect(isPoolEmptyCode("credits_pool_empty")).toBe(true);
    expect(isPoolEmptyCode("photos_per_day")).toBe(false);
    expect(isPoolEmptyCode(undefined)).toBe(false);
  });
});

describe("pack prices (PIN-152, PIN-182)", () => {
  it("formats EUR prices from cents in EN and FR", () => {
    expect(formatEur(299, "en")).toBe("€2.99");
    expect(formatEur(299, "fr")).toBe("2,99 €");
    expect(formatEur(1999, "en")).toBe("€19.99");
    expect(formatEur(500, "fr")).toBe("5,00 €");
    expect(formatEur(5, "en")).toBe("€0.05");
  });
});
