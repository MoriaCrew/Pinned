import { describe, expect, it } from "vitest";
import { normalizeScores, pickWinner, rankSubmissions, totalScore, validateScores } from "./rubric";

const sub = (
  id: string,
  scores: { fit: number; effort: number; chaos: number } | null,
  submittedAt = 0,
  status: "active" | "hidden" = "active",
) => ({ id, scores, submittedAt, status });

describe("rubric", () => {
  it("totals Fit+Effort+Chaos", () => {
    expect(totalScore({ fit: 5, effort: 4, chaos: 3 })).toBe(12);
  });

  it("rejects out-of-range and non-integer scores", () => {
    expect(() => validateScores({ fit: 6, effort: 0, chaos: 0 })).toThrow(RangeError);
    expect(() => validateScores({ fit: 2.5, effort: 0, chaos: 0 })).toThrow(RangeError);
    expect(() => validateScores({ fit: -1, effort: 0, chaos: 0 })).toThrow(RangeError);
  });

  it("normalizes model score scales onto 0-5 integers", () => {
    expect(normalizeScores({ fit: 0.95, effort: 0.2, chaos: 0.85 })).toEqual({ fit: 5, effort: 1, chaos: 4 });
    expect(normalizeScores({ fit: 1, effort: 0, chaos: 1 })).toEqual({ fit: 1, effort: 0, chaos: 1 }); expect(normalizeScores({ fit: 9, effort: 2, chaos: 4 })).toEqual({ fit: 5, effort: 2, chaos: 4 });
    expect(normalizeScores({ fit: 3, effort: 3, chaos: 3 })).toEqual({ fit: 3, effort: 3, chaos: 3 });
  });

  it("picks the highest total", () => {
    const winner = pickWinner([
      sub("a", { fit: 1, effort: 1, chaos: 1 }),
      sub("b", { fit: 5, effort: 5, chaos: 5 }),
    ]);
    expect(winner?.id).toBe("b");
  });

  it("breaks ties by earlier submission, then id", () => {
    const tied = { fit: 3, effort: 3, chaos: 3 };
    expect(pickWinner([sub("a", tied, 200), sub("b", tied, 100)])?.id).toBe("b");
    expect(pickWinner([sub("b", tied, 100), sub("a", tied, 100)])?.id).toBe("a");
  });

  it("ignores hidden and unjudged entries; null when none qualify", () => {
    expect(pickWinner([sub("a", { fit: 5, effort: 5, chaos: 5 }, 0, "hidden")])).toBeNull();
    expect(pickWinner([sub("a", null)])).toBeNull();
    expect(pickWinner([])).toBeNull();
  });

  it("ranks without mutating input", () => {
    const input = [sub("a", { fit: 0, effort: 0, chaos: 0 }), sub("b", { fit: 5, effort: 5, chaos: 5 })];
    const ranked = rankSubmissions(input);
    expect(ranked.map((s) => s.id)).toEqual(["b", "a"]);
    expect(input.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
