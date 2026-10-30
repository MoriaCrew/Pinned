/**
 * Same-origin Firebase sign-in helper (PIN-163, docs/13-auth.md).
 * Pure: no env reads, no server imports — next.config.ts builds
 * its rewrites from this at build time, and src/config.ts uses
 * the same project-id check before pointing the client authDomain
 * at the app's own host.
 *
 * Firebase Hosting serves the sign-in helper under the reserved
 * `/__/auth/*` paths of `{project}.firebaseapp.com`; App Hosting
 * does not. Proxying exactly that prefix to the project's own
 * firebaseapp host lets `authDomain` be the app's domain, so
 * Google's account chooser names the app instead of the
 * firebaseapp address.
 */

/** GCP/Firebase project id format: lowercase letter first, 6-30 chars, no trailing hyphen. */
const FIREBASE_PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function isFirebaseProjectId(value: string | null | undefined): value is string {
  return typeof value === "string" && FIREBASE_PROJECT_ID_PATTERN.test(value);
}

export interface ProxyRewrite {
  source: string;
  destination: string;
}

/** The only path prefix ever proxied. */
export const FIREBASE_AUTH_PROXY_SOURCE = "/__/auth/:path*";

/**
 * Off, or a missing/invalid project id, means no rewrite at all, so
 * the destination host can never be attacker- or typo-controlled:
 * it is always `https://{valid project id}.firebaseapp.com`.
 */
export function firebaseAuthProxyRewrites(input: {
  enabled: boolean;
  projectId: string | null;
}): ProxyRewrite[] {
  if (!input.enabled || !isFirebaseProjectId(input.projectId)) return [];
  return [
    {
      source: FIREBASE_AUTH_PROXY_SOURCE,
      destination: `https://${input.projectId}.firebaseapp.com/__/auth/:path*`,
    },
  ];
}
