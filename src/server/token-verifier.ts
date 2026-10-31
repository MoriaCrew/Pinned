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
 * PIN-94: it also carries `firebase.sign_in_provider` and
 * `auth_time`, which user-session checks against Policy
 * (provider allowlist at exchange, freshness at claim/restore).
 */
import { getConfig, type AppConfig } from "../config";

export interface VerifiedIdentity {
  uid: string;
  displayName?: string;
  photoUrl?: string;
  /** Firebase `firebase.sign_in_provider` (PIN-94), e.g. "google.com". */
  signInProvider?: string;
  /** Firebase `auth_time` in ms: when the user last authenticated. */
  authTimeMs?: number;
}

export interface VerifyIdTokenOptions {
  /** Firebase revocation check; session exchange always passes true. */
  checkRevoked?: boolean;
}

export interface TokenVerifier {
  /** Null = token invalid or verification unavailable. Never throws. */
  verifyIdToken(
    idToken: string,
    options?: VerifyIdTokenOptions,
  ): Promise<VerifiedIdentity | null>;
}

/** Test fixture shape: a VerifiedIdentity plus a revocation flag. */
export type FakeTokenIdentity = VerifiedIdentity & { revoked?: boolean };

/**
 * Deterministic verifier for tests: exact token -> identity map.
 * Mirrors the hosted contract (PIN-94): entries default to a fresh
 * Google sign-in (provider "google.com", authTime = now) unless a
 * fixture overrides them, and a `revoked` entry verifies only when
 * the caller does NOT request the revocation check — exactly like
 * Firebase, where revocation bites only with checkRevoked=true.
 */
export class FakeTokenVerifier implements TokenVerifier {
  constructor(
    private readonly tokens: Readonly<Record<string, FakeTokenIdentity>>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async verifyIdToken(
    idToken: string,
    options?: VerifyIdTokenOptions,
  ): Promise<VerifiedIdentity | null> {
    const entry = this.tokens[idToken];
    if (!entry) return null;
    if (options?.checkRevoked && entry.revoked) return null;
    const { revoked: _revoked, ...identity } = entry;
    return {
      ...identity,
      signInProvider: identity.signInProvider ?? "google.com",
      authTimeMs: identity.authTimeMs ?? this.now(),
    };
  }
}

interface DecodedTokenLike {
  uid?: unknown;
  name?: unknown;
  picture?: unknown;
  auth_time?: unknown;
  firebase?: { sign_in_provider?: unknown } | null;
}

interface AdminAuthLike {
  verifyIdToken(
    idToken: string,
    checkRevoked?: boolean,
  ): Promise<DecodedTokenLike>;
}

/** Decoded Firebase token -> VerifiedIdentity; null without a uid. */
export function identityFromDecodedToken(
  decoded: DecodedTokenLike,
): VerifiedIdentity | null {
  if (typeof decoded.uid !== "string" || !decoded.uid) return null;
  const provider = decoded.firebase?.sign_in_provider;
  return {
    uid: decoded.uid,
    ...(typeof decoded.name === "string" && decoded.name
      ? { displayName: decoded.name }
      : {}),
    ...(typeof decoded.picture === "string" && decoded.picture
      ? { photoUrl: decoded.picture }
      : {}),
    ...(typeof provider === "string" && provider
      ? { signInProvider: provider }
      : {}),
    ...(typeof decoded.auth_time === "number" &&
    Number.isFinite(decoded.auth_time)
      ? { authTimeMs: decoded.auth_time * 1000 }
      : {}),
  };
}

const ADMIN_APP_NAME = "pinned-auth";

/** Firebase Admin `verifyIdToken` adapter (lazy, fail-closed). */
export class FirebaseAdminTokenVerifier implements TokenVerifier {
  private authPromise: Promise<AdminAuthLike | null> | null = null;

  constructor(
    private readonly projectId: string | null,
    // Test seam: inject a fake Admin Auth instead of loading the SDK.
    private readonly authLoader?: () => Promise<AdminAuthLike | null>,
  ) {}

  private loadAuth(): Promise<AdminAuthLike | null> {
    if (this.authLoader) {
      this.authPromise ??= this.authLoader().catch(() => null);
      return this.authPromise;
    }
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

  async verifyIdToken(
    idToken: string,
    options?: VerifyIdTokenOptions,
  ): Promise<VerifiedIdentity | null> {
    if (!idToken || !this.projectId) return null;
    try {
      const auth = await this.loadAuth();
      if (!auth) return null;
      // With checkRevoked, Firebase throws auth/id-token-revoked for
      // revoked tokens; the catch below fails closed to null.
      const decoded = await auth.verifyIdToken(
        idToken,
        options?.checkRevoked ?? false,
      );
      return identityFromDecodedToken(decoded);
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
