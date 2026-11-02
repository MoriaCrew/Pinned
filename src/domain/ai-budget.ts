/**
 * The daily AI allowance as the board sees it (PIN-180). The decorator
 * chain (src/gateway/decorators.ts, PIN-61) fails a call it did not
 * make with one of three error codes: "budget" and "call_limit" mean
 * today's allowance is used up, "budget_off" that AI is switched off.
 * Participant, board and photo caps and "budget_unavailable" are not
 * budget denials. Pure and client-safe: the page turns the answer into
 * words, and a photo job that ends on one shows the budget line instead
 * of the generic "didn't work".
 */
export type AiBudgetDenial = "exhausted" | "off";

export function aiBudgetDenial(code: unknown): AiBudgetDenial | null {
  if (code === "budget" || code === "call_limit" || code === "hourly_budget") return "exhausted";
  if (code === "budget_off") return "off";
  return null;
}
