import { describe, expect, it } from "vitest";
import { resolveDeadline } from "./deadlines";

describe("resolveDeadline", () => {
  const now = Date.UTC(2026, 9, 27, 10, 15, 0);

  it("resolves express and 24h presets", () => {
    expect(resolveDeadline({ now, preset: "express" })).toBe(now + 2 * 3_600_000);
    expect(resolveDeadline({ now, preset: "24h" })).toBe(now + 24 * 3_600_000);
  });

  it("resolves custom whole hours and rejects invalid ranges", () => {
    expect(resolveDeadline({ now, preset: "custom", customHours: 72 })).toBe(now + 72 * 3_600_000);
    expect(() => resolveDeadline({ now, preset: "custom", customHours: 0 })).toThrow(RangeError);
    expect(() => resolveDeadline({ now, preset: "custom", customHours: 73 })).toThrow(RangeError);
    expect(() => resolveDeadline({ now, preset: "custom", customHours: 1.5 })).toThrow(RangeError);
    expect(() => resolveDeadline({ now, preset: "custom" })).toThrow(RangeError);
  });

  it("uses today at 21:00 local before the evening cutoff", () => {
    // 10:15 UTC = 12:15 in UTC+2, represented by getTimezoneOffset() -120.
    expect(resolveDeadline({ now, preset: "evening", timeZoneOffsetMinutes: -120 }))
      .toBe(Date.UTC(2026, 9, 27, 19, 0, 0));
  });

  it("rolls to tomorrow 21:00 local after the cutoff", () => {
    const late = Date.UTC(2026, 9, 27, 20, 30, 0); // 22:30 in UTC+2
    expect(resolveDeadline({ now: late, preset: "evening", timeZoneOffsetMinutes: -120 }))
      .toBe(Date.UTC(2026, 9, 28, 19, 0, 0));
  });

  it("rejects invalid offsets and times", () => {
    expect(() => resolveDeadline({ now, preset: "evening", timeZoneOffsetMinutes: 841 }))
      .toThrow(RangeError);
    expect(() => resolveDeadline({ now: Number.NaN, preset: "24h" })).toThrow(RangeError);
  });
});
