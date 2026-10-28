import { describe, expect, it } from "vitest";
import { t } from "./index";

describe("i18n catalog (FR9)", () => {
  it("resolves English strings", () => {
    expect(t("en", "landing.start")).toBe("Start a board");
  });

  it("falls back to English while fr is an empty stub", () => {
    expect(t("fr", "landing.start")).toBe(t("en", "landing.start"));
    expect(t("fr", "landing.tagline").length).toBeGreaterThan(0);
  });
});
