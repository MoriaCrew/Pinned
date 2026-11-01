/**
 * The /models walk-through stepper (PIN-237). Pure, so the page's
 * client island only holds the index. Back stops at the first step;
 * Next on the last step starts over (its label says so). Any index
 * from outside (a step dot) is clamped into range.
 */
export type StepMove = "back" | "next";

export function clampStep(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), count - 1);
}

export function stepAfter(current: number, move: StepMove, count: number): number {
  const at = clampStep(current, count);
  if (move === "back") return Math.max(at - 1, 0);
  return at >= count - 1 ? 0 : at + 1;
}
