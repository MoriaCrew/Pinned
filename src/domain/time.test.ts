import { describe, expect, it } from "vitest";
import { startOfUtcDay } from "./time";

describe("startOfUtcDay", () => {
  it("returns 00:00 UTC of the same UTC day", () => {
    const now = Date.UTC(2026, 9, 31, 23, 59, 59, 999);
    expect(startOfUtcDay(now)).toBe(Date.UTC(2026, 9, 31));
  });

  it("is the identity on midnight UTC", () => {
    const midnight = Date.UTC(2026, 10, 1);
    expect(startOfUtcDay(midnight)).toBe(midnight);
  });

  it("rolls over at the UTC boundary, not local time", () => {
    expect(startOfUtcDay(Date.UTC(2026, 10, 1) - 1)).toBe(Date.UTC(2026, 9, 31));
  });
});
