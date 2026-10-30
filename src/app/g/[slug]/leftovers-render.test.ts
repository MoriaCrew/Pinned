import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Leftovers } from "../../../domain/leftovers";
import { LeftoversLine, leftoversLine } from "./Leftovers";

const noop = () => {};
const group = (jobId: string, n: number, newestAt: number) => ({
  jobId,
  pinIds: Array.from({ length: n }, (_, i) => `${jobId}-pin${i}`),
  elementIds: Array.from({ length: n }, (_, i) => `${jobId}-el${i}`),
  newestAt,
});
const one: Leftovers = { groups: [group("j1", 3, 9)], count: 3 };

const line = (props: Partial<Parameters<typeof LeftoversLine>[0]> = {}) =>
  renderToStaticMarkup(
    h(LeftoversLine, {
      leftovers: one,
      stickers: [{ src: "/a.png", seed: "a" }],
      confirming: false,
      clearing: false,
      failed: false,
      onPin: noop,
      onAskClear: noop,
      onClear: noop,
      onKeep: noop,
      ...props,
    }),
  );

describe("leftovers line (PIN-122)", () => {
  it("says how many things from the last photo wait, with Pin them and Clear", () => {
    const out = line();
    expect(out).toContain("3 things from your last photo aren&#x27;t pinned");
    expect(out).toContain("Pin them");
    expect(out).toContain("Clear");
    expect(out).toContain("pn-btn-secondary");
    expect(out).toContain("pn-btn-quiet");
    expect(out).toContain("pn-sticker");
  });

  it("uses the singular forms for one thing", () => {
    const out = line({ leftovers: { groups: [group("j1", 1, 1)], count: 1 } });
    expect(out).toContain("1 thing from your last photo isn&#x27;t pinned");
    expect(out).toContain("Pin it");
  });

  it("counts every photo's leftovers", () => {
    const many: Leftovers = { groups: [group("new", 2, 9), group("old", 3, 1)], count: 5 };
    expect(leftoversLine(many)).toBe("5 things from your last photos aren't pinned");
  });

  it("asks once before clearing, and says when clearing failed", () => {
    const ask = line({ confirming: true });
    expect(ask).toContain("Clear 3 things? They won&#x27;t be pinned.");
    expect(ask).toContain("Yes, clear");
    expect(ask).toContain("Keep");
    expect(ask).not.toContain("Pin them");
    const busy = line({ confirming: true, clearing: true });
    expect(busy).toContain("Clearing…");
    expect(busy.match(/disabled=""/g)).toHaveLength(2);
    const failed = line({ confirming: true, failed: true });
    expect(failed).toContain("Couldn&#x27;t clear. Try again.");
    expect(failed).toContain('role="alert"');
  });
});
