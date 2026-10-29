import { describe, expect, it } from "vitest";
import { t, tCount, tf } from "./index";

describe("i18n catalog (FR9)", () => {
  it("resolves English strings", () => {
    expect(t("en", "landing.start")).toBe("Start a board");
  });

  it("falls back to English while fr is an empty stub", () => {
    expect(t("fr", "landing.start")).toBe(t("en", "landing.start"));
    expect(t("fr", "landing.tagline").length).toBeGreaterThan(0);
  });

  it("fills {placeholders} and leaves unknown ones visible (PIN-97)", () => {
    expect(tf("en", "ui.pickedCount", { n: 2, max: 4 })).toBe("2 of 4 picked");
    expect(tf("en", "ui.pickedCount", { n: 2 })).toBe("2 of {max} picked");
  });

  it("picks singular and plural count forms (PIN-97)", () => {
    expect(tCount("en", "meta.people", 1)).toBe("1 person");
    expect(tCount("en", "meta.people", 6)).toBe("6 people");
    expect(tCount("en", "meta.things", 0)).toBe("0 things");
    expect(tCount("en", "meta.scenes", 1)).toBe("1 scene");
  });
});
