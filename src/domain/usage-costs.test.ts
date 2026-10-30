import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AiCallLog } from "./types";
import { formatMicroUsdEst, summarizeUsageCosts } from "./usage-costs";

const hash = (id: string) =>
  `board:${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;

// Synthetic slugs only (PIN-137) — never a real board link.
const SYNTHETIC_BOARD = "synthetic-board-aaaaaa";

function log(over: Partial<AiCallLog> = {}): AiCallLog {
  return {
    id: "l1",
    operation: "nameElements",
    model: "m",
    latencyMs: 1,
    outcome: "ok",
    dayBucket: "2026-10-30",
    createdAt: 0,
    boardId: SYNTHETIC_BOARD,
    participantId: "p-synthetic-1",
    costMicroUsdEst: 11_322,
    reservedMicroUsd: 17_000,
    ...over,
  };
}

describe("usage:costs rollup (PIN-137, seeded synthetic data)", () => {
  it("groups per board/participant/operation, counts denials, never leaks the slug", () => {
    const summary = summarizeUsageCosts(
      [
        log(),
        log({ id: "l2", costMicroUsdEst: 2_500, operation: "segment" }),
        log({
          id: "l3",
          outcome: "denied_participant_cap",
          costMicroUsdEst: 0,
          reservedMicroUsd: 0,
        }),
        // Old-shape row: gameId + float cost only — still readable.
        log({
          id: "old",
          boardId: undefined,
          gameId: SYNTHETIC_BOARD,
          costMicroUsdEst: undefined,
          reservedMicroUsd: undefined,
          costEstimateUsd: 0.01,
          participantId: undefined,
        }),
        log({ id: "outside", dayBucket: "2026-10-01" }),
      ],
      { fromDay: "2026-10-30", toDay: "2026-10-30" },
      hash,
    );
    expect(summary.totalCalls).toBe(4);
    expect(summary.totalDenied).toBe(1);
    expect(summary.totalCostMicroUsdEst).toBe(11_322 + 2_500 + 10_000);
    expect(JSON.stringify(summary)).not.toContain(SYNTHETIC_BOARD);
    expect(summary.rows[0].board).toBe(hash(SYNTHETIC_BOARD));
    const namer = summary.rows.find(
      (r) => r.operation === "nameElements" && r.participantId === "p-synthetic-1",
    );
    expect(namer).toMatchObject({ calls: 2, denied: 1, costMicroUsdEst: 11_322 });
  });

  it("labels money as an estimate", () => {
    expect(formatMicroUsdEst(11_322)).toBe("$0.0113 (estimate)");
  });
});
