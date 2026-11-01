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
