/**
 * Pure sign-in UI decisions (PIN-84, docs/11 section 5.4).
 * Client-safe: no env reads, no server imports. The layout and
 * board components render from these helpers so the flag-off
 * contract — zero auth DOM in link-only mode or without web
 * config — is unit-testable without a DOM.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
}

export interface AuthUiState {
  enabled: boolean;
  config: FirebaseWebConfig | null;
}

/**
 * Sign-in UI exists only when AUTH_MODE=optional AND the public
 * Firebase web config is complete. NEXT_PUBLIC_* values are
 * build-time: empty means the operator has not finished the
 * console steps (docs/13-auth.md), so the UI stays hidden rather
 * than offering a sign-in that cannot work. The project id falls
 * back to the authDomain prefix (`{project}.firebaseapp.com`),
 * the standard Firebase shape; a custom auth domain without an
 * explicit project id disables the UI honestly.
 */
export function resolveAuthUi(input: {
  authMode: string;
  apiKey: string | null;
  authDomain: string | null;
  projectId: string | null;
}): AuthUiState {
  if (input.authMode !== "optional") return { enabled: false, config: null };
  const apiKey = input.apiKey?.trim() || null;
  const authDomain = input.authDomain?.trim() || null;
  if (!apiKey || !authDomain) return { enabled: false, config: null };
  const projectId =
    input.projectId?.trim() ||
    (authDomain.endsWith(".firebaseapp.com")
      ? authDomain.slice(0, -".firebaseapp.com".length)
      : null);
  if (!projectId) return { enabled: false, config: null };
  return { enabled: true, config: { apiKey, authDomain, projectId } };
}

/** Avatar initials from a display name; "?" when there is none. */
export function authInitials(displayName: string | null | undefined): string {
  const words = (displayName ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "?";
  const second = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + second).toUpperCase();
}

/** localStorage key for the once-only first-pin nudge. */
export const SIGN_IN_NUDGE_STORAGE_KEY = "pinned.signInNudgeSeen";

/**
 * First-pin nudge (PIN-84): shown once, after the viewer's first
 * pinned pin, only when sign-in is actually available and Policy
 * allows it. Never for signed-in users or link-only visitors.
 */
export function shouldShowSignInNudge(input: {
  authEnabled: boolean;
  policyNudge: boolean;
  signedIn: boolean;
  joined: boolean;
  myPinnedCount: number;
  seenBefore: boolean;
}): boolean {
  return (
    input.authEnabled &&
    input.policyNudge &&
    !input.signedIn &&
    input.joined &&
    input.myPinnedCount >= 1 &&
    !input.seenBefore
  );
}
