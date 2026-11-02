/**
 * Report-this-board link (PIN-239). Pure and client-safe: the board
 * page builds a `mailto:` to the legal contact whose subject/body
 * carry only the opaque report reference (`boardReportRef` in
 * tokens.ts, server-computed) — never the capability slug, so a
 * report never puts the board link in mail or logs. The operator
 * maps a reference back to a board with the same hash
 * (docs/20-abuse-runbook.md).
 */
export function reportBoardHref(
  email: string | null | undefined,
  reportRef: string | null | undefined,
  subject: string,
  body: string,
): string | null {
  if (!email || !reportRef) return null;
  const query = `subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return `mailto:${email}?${query}`;
}
