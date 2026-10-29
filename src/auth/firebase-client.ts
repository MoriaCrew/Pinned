/**
 * Firebase Auth web client (PIN-84). The `firebase` package is
 * loaded with dynamic import() only when a sign-in actually
 * starts (or a redirect result is checked on an auth-enabled
 * page), so link-only visitors never download it. Only the
 * modular app/auth entry points are used; no client Firestore
 * or Storage — those rules stay deny-all (AGENTS.md).
 */
import type { FirebaseWebConfig } from "../domain/auth-ui";

/** Sign-in turned into a full-page redirect; the page is leaving. */
export class RedirectingToGoogle extends Error {
  constructor() {
    super("redirecting");
    this.name = "RedirectingToGoogle";
  }
}

async function loadAuth(config: FirebaseWebConfig) {
  const [{ getApps, initializeApp }, authMod] = await Promise.all([
    import("firebase/app"),
    import("firebase/auth"),
  ]);
  const app =
    getApps()[0] ??
    initializeApp({
      apiKey: config.apiKey,
      authDomain: config.authDomain,
      projectId: config.projectId,
    });
  return { auth: authMod.getAuth(app), authMod };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
}

/**
 * Google sign-in -> Firebase ID token for /api/auth/session.
 * Popup first; when the browser blocks it (or the hosted domain
 * cannot do popups) fall back to the redirect flow — the result
 * is then picked up by completeRedirectSignIn on return.
 */
export async function signInWithGoogle(
  config: FirebaseWebConfig,
): Promise<string> {
  const { auth, authMod } = await loadAuth(config);
  const provider = new authMod.GoogleAuthProvider();
  try {
    const result = await authMod.signInWithPopup(auth, provider);
    return result.user.getIdToken();
  } catch (error) {
    const code = errorCode(error);
    if (
      code === "auth/popup-blocked" ||
      code === "auth/cancelled-popup-request" ||
      code === "auth/operation-not-supported-in-this-environment"
    ) {
      await authMod.signInWithRedirect(auth, provider);
      throw new RedirectingToGoogle();
    }
    throw error;
  }
}

/** ID token from a completed redirect sign-in; null when none. */
export async function completeRedirectSignIn(
  config: FirebaseWebConfig,
): Promise<string | null> {
  const { auth, authMod } = await loadAuth(config);
  const result = await authMod.getRedirectResult(auth);
  return result ? result.user.getIdToken() : null;
}

/** Best-effort Firebase sign-out; the server cookie is the session. */
export async function signOutFirebase(
  config: FirebaseWebConfig,
): Promise<void> {
  const { auth, authMod } = await loadAuth(config);
  await authMod.signOut(auth);
}
