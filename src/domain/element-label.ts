/**
 * Rename rule for a thing's label (PIN-156), shared by the server
 * and the rename sheet (PIN-157): trimmed, inner whitespace collapsed
 * to single spaces, 1 to `maxChars` code points
 * (Policy.elementLabelMaxChars), no control characters. Over the cap
 * is refused, never truncated, like board titles.
 */
export type ElementLabelCheck =
  | { ok: true; label: string }
  | { ok: false; reason: "empty" | "tooLong" | "invalid" };

export function normalizeElementLabel(raw: unknown, maxChars: number): ElementLabelCheck {
  if (typeof raw !== "string") return { ok: false, reason: "invalid" };
  const label = raw.trim().replace(/\s+/g, " ");
  if (!label) return { ok: false, reason: "empty" };
  if (/[\u0000-\u001f\u007f]/.test(label)) return { ok: false, reason: "invalid" };
  if (Array.from(label).length > maxChars) return { ok: false, reason: "tooLong" };
  return { ok: true, label };
}
