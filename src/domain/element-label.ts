/**
 * Rename rule for a thing's label (PIN-156), shared by the server
 * and the rename sheet (PIN-157): trimmed, inner whitespace collapsed
 * to single spaces, 1 to `maxChars` code points
 * (Policy.elementLabelMaxChars). Labels reach other people's credit
 * lines and scene/chip prompts, so characters that are invisible or
 * reorder text are refused ("invalid"): C0/C1 controls, bidi controls,
 * tag characters and lone surrogates. ZWJ/ZWNJ stay (emoji sequences,
 * some scripts). A label with no visible character is "empty". Over
 * the cap is refused, never truncated, like board titles.
 */
export type ElementLabelCheck =
  | { ok: true; label: string }
  | { ok: false; reason: "empty" | "tooLong" | "invalid" };

const REFUSED = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u{E0000}-\u{E007F}\p{Cs}]/u;
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

export function normalizeElementLabel(raw: unknown, maxChars: number): ElementLabelCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label) return { ok: false, reason: "empty" };
  if (REFUSED.test(label)) return { ok: false, reason: "invalid" };
  if (!VISIBLE.test(label)) return { ok: false, reason: "empty" };
  if (Array.from(label).length > maxChars) return { ok: false, reason: "tooLong" };
  return { ok: true, label };
}

/**
 * The board view with one thing's label replaced (the rename sheet's
 * optimistic patch and its reconcile, PIN-157). The grid, the credits
 * and the scene viewer all read `elements`, so this one change
 * reaches them. Returns the same view when the thing is not in it.
 */
export function withElementLabel<V extends { elements: readonly { id: string; label: string }[] }>(
  view: V,
  elementId: string,
  label: string,
): V {
  if (!view.elements.some((element) => element.id === elementId)) return view;
  return {
    ...view,
    elements: view.elements.map((element) => (element.id === elementId ? { ...element, label } : element)),
  };
}
