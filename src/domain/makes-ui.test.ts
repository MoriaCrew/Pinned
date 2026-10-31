import { describe, expect, it } from "vitest";
import { FREE_PHOTOS_USED } from "./free-photos";
import {
  CREDITS_POOL_EMPTY_CODE,
  addPickView,
  billingBannerKind,
  creditCheckoutBody,
  formatEur,
  freePhotosState,
  freePhotosUsedCopy,
  isFreePhotosUsedCode,
  isPoolEmptyCode,
  makesState,
  parseBillingFlag,
  plusActionKey,
  poolEmptyCopy,
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

  it("with the shipped threshold of 2, speaks at 2 left and not at 3 (PIN-183)", () => {
    expect(makesState(3, 2)).toBe("ok");
    expect(makesState(2, 2)).toBe("low");
    expect(makesState(1, 2)).toBe("low");
    expect(makesState(0, 2)).toBe("empty");
    // 0 turns the low state off; empty still speaks.
    expect(makesState(1, 0)).toBe("ok");
    expect(makesState(0, 0)).toBe("empty");
  });
});

describe("the way into the Plus sheet (PIN-183)", () => {
  it("says Get Plus until the board has Plus, then Add creations", () => {
    expect(plusActionKey(false)).toBe("makes.add");
    expect(plusActionKey(true)).toBe("makes.addMore");
  });

  it("makes a dry pool an invitation with a button where buying works", () => {
    expect(poolEmptyCopy("photo", { canBuy: true, plusActive: false })).toEqual({ line: "makes.poolEmpty", action: "makes.add" });
    expect(poolEmptyCopy("scene", { canBuy: true, plusActive: false })).toEqual({ line: "makes.poolEmpty", action: "makes.add" });
    expect(poolEmptyCopy("photo", { canBuy: true, plusActive: true })).toEqual({
      line: "makes.poolEmptyPlus",
      action: "makes.addMore",
    });
  });

  it("keeps the plain fact and no button with billing off", () => {
    expect(poolEmptyCopy("photo", { canBuy: false, plusActive: false })).toEqual({ line: "makes.poolEmptyPhoto", action: null });
    expect(poolEmptyCopy("scene", { canBuy: false, plusActive: true })).toEqual({ line: "makes.poolEmptyScene", action: null });
  });
});

describe("free photos in the Add sheet (PIN-231)", () => {
  it("reads only the PIN-230 code, the same constant the server and the queue use", () => {
    expect(isFreePhotosUsedCode(FREE_PHOTOS_USED)).toBe(true);
    expect(isFreePhotosUsedCode("free_photos_used")).toBe(true);
    expect(isFreePhotosUsedCode(CREDITS_POOL_EMPTY_CODE)).toBe(false);
    expect(isFreePhotosUsedCode("photos_per_day")).toBe(false);
    expect(isFreePhotosUsedCode(undefined)).toBe(false);
    // And the pool code stays its own outcome.
    expect(isPoolEmptyCode(FREE_PHOTOS_USED)).toBe(false);
  });

  it("says nothing with plenty left or no limit, goes low at the threshold, used at 0", () => {
    // Absent: Plus or credits off, no photo limit at all.
    expect(freePhotosState(undefined, 3)).toBe("ok");
    expect(freePhotosState(15, 3)).toBe("ok");
    expect(freePhotosState(4, 3)).toBe("ok");
    expect(freePhotosState(3, 3)).toBe("low");
    expect(freePhotosState(1, 3)).toBe("low");
    expect(freePhotosState(0, 3)).toBe("used");
    expect(freePhotosState(-1, 3)).toBe("used");
    // 0 turns the low line off; used still speaks.
    expect(freePhotosState(1, 0)).toBe("ok");
    expect(freePhotosState(0, 0)).toBe("used");
  });

  it("invites to Plus where buying works, keeps the plain fact with billing off", () => {
    expect(freePhotosUsedCopy({ canBuy: true, plusActive: false })).toEqual({ line: "makes.freePhotosUsed", action: "makes.add" });
    expect(freePhotosUsedCopy({ canBuy: false, plusActive: false })).toEqual({ line: "makes.freePhotosUsedOff", action: null });
  });

  it("once the board has Plus, says the limit is gone, with no button (billing on or off)", () => {
    expect(freePhotosUsedCopy({ canBuy: true, plusActive: true })).toEqual({ line: "makes.freePhotosPlusOn", action: null });
    expect(freePhotosUsedCopy({ canBuy: false, plusActive: true })).toEqual({ line: "makes.freePhotosPlusOn", action: null });
  });

  it("shows the picker, with the low count only at the threshold", () => {
    const view = (freePhotosLeft: number | undefined, over: Partial<Parameters<typeof addPickView>[0]> = {}) =>
      addPickView({ freePhotosLeft, lowWarning: 3, uploadHitLimit: false, plusActive: false, ...over });
    expect(view(undefined)).toEqual({ kind: "picker", lowLeft: null });
    expect(view(10)).toEqual({ kind: "picker", lowLeft: null });
    expect(view(3)).toEqual({ kind: "picker", lowLeft: 3 });
    expect(view(1)).toEqual({ kind: "picker", lowLeft: 1 });
    expect(view(2, { lowWarning: 0 })).toEqual({ kind: "picker", lowLeft: null });
  });

  it("swaps the picker for the invitation at 0 left, or when an upload just hit the limit", () => {
    const view = (freePhotosLeft: number | undefined, over: Partial<Parameters<typeof addPickView>[0]> = {}) =>
      addPickView({ freePhotosLeft, lowWarning: 3, uploadHitLimit: false, plusActive: false, ...over });
    expect(view(0)).toEqual({ kind: "freePhotosUsed" });
    expect(view(0, { lowWarning: 0 })).toEqual({ kind: "freePhotosUsed" });
    // The 429 came back before the board poll caught up.
    expect(view(2, { uploadHitLimit: true })).toEqual({ kind: "freePhotosUsed" });
    expect(view(undefined, { uploadHitLimit: true })).toEqual({ kind: "freePhotosUsed" });
  });

  it("always brings the picker back once the board has Plus", () => {
    expect(addPickView({ freePhotosLeft: 0, lowWarning: 3, uploadHitLimit: true, plusActive: true })).toEqual({
      kind: "picker",
      lowLeft: null,
    });
    expect(addPickView({ freePhotosLeft: 2, lowWarning: 3, uploadHitLimit: false, plusActive: true })).toEqual({
      kind: "picker",
      lowLeft: null,
    });
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
    expect(formatEur(299, "fr").replace(/[  ]/g, " ")).toBe("2,99 €");
    expect(formatEur(1999, "en")).toBe("€19.99");
    expect(formatEur(500, "fr").replace(/[  ]/g, " ")).toBe("5,00 €");
    expect(formatEur(5, "en")).toBe("€0.05");
    expect(formatEur(499, "fr")).toBe("4,99 €");
  });
});
