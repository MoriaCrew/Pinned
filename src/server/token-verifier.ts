import "server-only";
/**
 * TokenVerifier port (PIN-83, docs/11 section 5.4): the server
 * boundary that turns a Firebase ID token into a verified
 * identity. Route/service code depends on the port only; tests
 * use FakeTokenVerifier, hosted runs use the Firebase Admin
 * adapter below.
 *
 * Note: the repo's Firestore/Storage access goes through the
 * @google-cloud clients directly, NOT firebase-admin — the Admin
 * SDK is added by this issue solely for Auth `verifyIdToken`.
 * It is loaded lazily (dynamic import on first verify) and every
 * failure — no project id, SDK/credential error, bad/expired
 * token — fails closed to null. The identity carries uid plus
 * the optional display name / photo claims only; the email
 * claim is deliberately never read (see src/domain/user.ts).
 */
import { getConfig, type AppConfig } from "../config";

export interface VerifiedIdentity {
  uid: string;
  displayName?: string;
  photoUrl?: string;
}

export interface TokenVerifier {
  /** Null = token invalid or verification unavailable. Never throws. */
  verifyIdToken(idToken: string): Promise<VerifiedIdentity | null>;
}

/** Deterministic verifier for tests: exact token -> identity map. */
export class FakeTokenVerifier implements TokenVerifier {
  constructor(
    private readonly tokens: Readonly<Record<string, VerifiedIdentity>>,
  ) {}

  async verifyIdToken(idToken: string): Promise<VerifiedIdentity | null> {
    const identity = this.tokens[idToken];
    return identity ? { ...identity } : null;
  }
}

interface AdminAuthLike {
  verifyIdToken(
    idToken: string,
  ): Promise<{ uid?: unknown; name?: unknown; picture?: unknown }>;
}

const ADMIN_APP_NAME = "pinned-auth";

/** Firebase Admin `verifyIdToken` adapter (lazy, fail-closed). */
export class FirebaseAdminTokenVerifier implements TokenVerifier {
  private authPromise: Promise<AdminAuthLike | null> | null = null;

  constructor(private readonly projectId: string | null) {}

  private loadAuth(): Promise<AdminAuthLike | null> {
    this.authPromise ??= (async () => {
      try {
        const { applicationDefault, getApps, initializeApp } =
          await import("firebase-admin/app");
        const { getAuth } = await import("firebase-admin/auth");
        const existing = getApps().find((app) => app.name === ADMIN_APP_NAME);
        const app =
          existing ??
          initializeApp(
            {
              credential: applicationDefault(),
              projectId: this.projectId ?? undefined,
            },
            ADMIN_APP_NAME,
          );
        return getAuth(app) as unknown as AdminAuthLike;
      } catch {
        return null;
      }
    })();
    return this.authPromise;
  }

  async verifyIdToken(idToken: string): Promise<VerifiedIdentity | null> {
    if (!idToken || !this.projectId) return null;
    try {
      const auth = await this.loadAuth();
      if (!auth) return null;
      const decoded = await auth.verifyIdToken(idToken);
      if (typeof decoded.uid !== "string" || !decoded.uid) return null;
      return {
        uid: decoded.uid,
        ...(typeof decoded.name === "string" && decoded.name
          ? { displayName: decoded.name }
          : {}),
        ...(typeof decoded.picture === "string" && decoded.picture
          ? { photoUrl: decoded.picture }
          : {}),
      };
    } catch {
      return null;
    }
  }
}

export function createTokenVerifier(config: AppConfig = getConfig()): TokenVerifier {
  return new FirebaseAdminTokenVerifier(config.firebaseProjectId);
}

const globalVerifier = globalThis as typeof globalThis & {
  __pinnedTokenVerifier?: TokenVerifier;
};

/** Process-wide verifier (the Admin app init is lazy + cached inside). */
export function getTokenVerifier(): TokenVerifier {
  globalVerifier.__pinnedTokenVerifier ??= createTokenVerifier();
  return globalVerifier.__pinnedTokenVerifier;
}

/**
 * Test seam only: swap the process-wide verifier (route tests run
 * the real handlers against FakeTokenVerifier). Not reachable
 * over HTTP; production code never calls this.
 */
export function setTokenVerifierForTests(verifier: TokenVerifier | null): void {
  if (verifier) {
    globalVerifier.__pinnedTokenVerifier = verifier;
  } else {
    delete globalVerifier.__pinnedTokenVerifier;
  }
}
