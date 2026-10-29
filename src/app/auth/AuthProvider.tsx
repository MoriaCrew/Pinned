"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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

  // PIN-86: hydrate is idempotent across remounts. No "started"
  // latch: Strict Mode setup-cleanup-setup would abandon the one
  // allowed run and strand status at "loading". Each run owns a
  // cancelled flag; a duplicate /api/me read is harmless.
  useEffect(() => {
    if (!config) return;
    let cancelled = false;
    void (async () => {
      try {
        const redirectToken = await completeRedirectSignIn(config).catch(
          () => null,
        );
        if (redirectToken) await postSession(redirectToken).catch(() => null);
        const response = await fetch("/api/me", { cache: "no-store" });
        if (cancelled) return;
        if (response.ok) {
          const data = (await response.json()) as { user?: AuthUser };
          if (data.user) {
            setUser(data.user);
            setStatus("signedIn");
            return;
          }
        }
        setStatus("signedOut");
      } catch {
        if (!cancelled) setStatus("signedOut");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config]);

  const signIn = useCallback(async () => {
    if (!config) return;
    setSignInError(false);
    try {
      const idToken = await signInWithGoogle(config);
      const signedIn = await postSession(idToken);
      if (!signedIn) throw new Error("session failed");
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
