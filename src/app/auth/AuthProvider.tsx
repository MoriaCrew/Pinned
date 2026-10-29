"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { FirebaseWebConfig } from "../../domain/auth-ui";
import {
  completeRedirectSignIn,
  RedirectingToGoogle,
  signInWithGoogle,
  signOutFirebase,
} from "../../auth/firebase-client";

export interface AuthUser {
  uid: string;
  displayName: string | null;
  photoUrl: string | null;
}

export interface AuthContextValue {
  /** False = link-only or no web config: auth UI renders null. */
  enabled: boolean;
  status: "loading" | "signedOut" | "signedIn";
  user: AuthUser | null;
  signInError: boolean;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

const DISABLED: AuthContextValue = {
  enabled: false,
  status: "signedOut",
  user: null,
  signInError: false,
  signIn: async () => {},
  signOut: async () => {},
};

const AuthContext = createContext<AuthContextValue>(DISABLED);

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

async function postSession(idToken: string): Promise<AuthUser | null> {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { user?: AuthUser };
  return data.user ?? null;
}

interface HydrateResult {
  user: AuthUser | null;
  /** True when this run wrote the session cookie (redirect
   * completion) after the page was server-rendered. */
  viaRedirect: boolean;
}

let hydrateInFlight: Promise<HydrateResult> | null = null;

/**
 * One shared in-flight hydrate (PIN-86). `getRedirectResult` is
 * consumed once, so overlapping effect runs (Strict Mode,
 * remounts) must await the same promise instead of competing:
 * a cancelled run could otherwise take the redirect token while
 * the surviving run reads /api/me before the cookie exists.
 * Cleared once settled, so a later remount re-reads fresh state.
 */
function hydrateSession(config: FirebaseWebConfig): Promise<HydrateResult> {
  if (!hydrateInFlight) {
    const run = (async (): Promise<HydrateResult> => {
      try {
        const redirectToken = await completeRedirectSignIn(config).catch(
          () => null,
        );
        let viaRedirect = false;
        if (redirectToken) {
          await postSession(redirectToken).catch(() => null);
          viaRedirect = true;
        }
        const response = await fetch("/api/me", { cache: "no-store" });
        if (response.ok) {
          const data = (await response.json()) as { user?: AuthUser };
          if (data.user) return { user: data.user, viaRedirect };
        }
        return { user: null, viaRedirect };
      } catch {
        return { user: null, viaRedirect: false };
      }
    })();
    hydrateInFlight = run;
    void run.finally(() => {
      if (hydrateInFlight === run) hydrateInFlight = null;
    });
  }
  return hydrateInFlight;
}

/**
 * Sign-in state (PIN-84). Rendered by the layout only when
 * resolveAuthUi enables it; with `config: null` it is a pure
 * pass-through (no fetches, no DOM) so link-only pages stay
 * byte-identical. When enabled it hydrates from GET /api/me
 * (the httpOnly cookie is the session of record) and first
 * completes any redirect sign-in in flight.
 */
export function AuthProvider({
  config,
  children,
}: {
  config: FirebaseWebConfig | null;
  children: ReactNode;
}) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<"loading" | "signedOut" | "signedIn">(
    config ? "loading" : "signedOut",
  );
  const [signInError, setSignInError] = useState(false);
  const router = useRouter();
  // PIN-86: bumped by every explicit sign-in/out. A hydrate run
  // only applies its result while the epoch it started in is
  // still current, so a slow hydrate can never resurrect a
  // session the user explicitly ended (or clobber a fresh one).
  const authEpoch = useRef(0);

  // PIN-86: every effect run awaits the shared hydrate (no
  // "started" latch to strand status at "loading", no competing
  // runs to drop the consume-once redirect result). Each run
  // still guards its own setState with `cancelled`.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    const runEpoch = authEpoch.current;
    void hydrateSession(config).then((result) => {
      if (cancelled || authEpoch.current !== runEpoch) return;
      if (result.user) {
        setUser(result.user);
        setStatus("signedIn");
        // Redirect completion wrote the cookie after SSR, so
        // server pages still show the signed-out render.
        if (result.viaRedirect) router.refresh();
      } else {
        setStatus("signedOut");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config, router]);

  const signIn = useCallback(async () => {
    if (!config) return;
    setSignInError(false);
    try {
      const idToken = await signInWithGoogle(config);
      const signedIn = await postSession(idToken);
      if (!signedIn) throw new Error("session failed");
      authEpoch.current += 1;
      setUser(signedIn);
      setStatus("signedIn");
      // PIN-86: server pages (/me/*) read the cookie server-side;
      // refresh so they reflect the new session immediately.
      router.refresh();
    } catch (error) {
      // Redirect fallback: the browser is leaving for Google;
      // popup-closed is a user cancel, not an error to report.
      if (error instanceof RedirectingToGoogle) return;
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String((error as { code: unknown }).code) === "auth/popup-closed-by-user"
      ) {
        return;
      }
      setSignInError(true);
    }
  }, [config, router]);

  const signOut = useCallback(async () => {
    if (!config) return;
    try {
      await fetch("/api/auth/session", { method: "DELETE" });
    } catch {
      // Cookie clear is idempotent server-side; still sign out locally.
    }
    await signOutFirebase(config).catch(() => {});
    authEpoch.current += 1;
    setUser(null);
    setStatus("signedOut");
    router.refresh();
  }, [config, router]);

  if (!config) return <>{children}</>;
  return (
    <AuthContext.Provider
      value={{ enabled: true, status, user, signInError, signIn, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}
