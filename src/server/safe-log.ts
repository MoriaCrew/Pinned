import "server-only";
/**
 * Error logging that never prints a board link (PIN-167 review). A
 * board slug is a capability, and repository errors name it in their
 * message ("Board <slug> not found"); a request racing a board delete
 * can now reach those paths. Slug-shaped tokens (exactly the 22-char
 * alphabet of SLUG_PATTERN, standing alone) are blanked in the message
 * and stack before anything is logged.
 */
const SLUG_TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{22}(?![A-Za-z0-9_-])/g;

export function redactSlugs(text: string): string {
  return text.replace(SLUG_TOKEN, "<slug>");
}

export type EventSeverity = "INFO" | "WARNING" | "CRITICAL";

/**
 * One structured line on stdout (PIN-270): Cloud Logging turns a JSON
 * line into `jsonPayload` and reads `severity`, so a log-based alert
 * can match `jsonPayload.event`. Callers pass opaque values only
 * (references, counts, enums); slug-shaped tokens are blanked anyway.
 */
export function logEvent(
  event: string,
  fields: Readonly<Record<string, unknown>>,
  severity: EventSeverity = "INFO",
): void {
  // `event` and `severity` last: a field can never overwrite the alert keys.
  console.log(redactSlugs(JSON.stringify({ ...fields, event, severity })));
}

export function logServerError(label: string, error: unknown): void {
  if (error instanceof Error) {
    console.error(label, {
      name: error.name,
      message: redactSlugs(error.message),
      ...(error.stack ? { stack: redactSlugs(error.stack) } : {}),
    });
    return;
  }
  console.error(label, { name: typeof error });
}
