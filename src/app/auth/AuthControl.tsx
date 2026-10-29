"use client";

import { useState } from "react";
import { authInitials } from "../../domain/auth-ui";
import { t } from "../../i18n";
import { useAuth } from "./AuthProvider";

/**
 * Quiet sign-in surface (PIN-84, docs/08: icon + short words,
 * 44px targets). Renders null whenever sign-in is disabled, so
 * link-only pages carry zero auth DOM. Signed in: avatar (photo
 * or initials) opening a small menu — who you are, My boards,
 * Sign out. "My pins" is PIN-57c and intentionally absent.
 */
export function AuthControl() {
  const { enabled, status, user, signInError, signIn, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!enabled) return null;
  if (status === "loading") {
    return <span className="auth-skeleton" aria-hidden="true" />;
  }
  if (!user) {
    return (
      <span className="auth-control">
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void signIn().finally(() => setBusy(false));
          }}
        >
          🔐 {busy ? t("en", "auth.signingIn") : t("en", "auth.signIn")}
        </button>
        {signInError ? (
          <span className="error" role="alert">
            {t("en", "auth.failed")}
          </span>
        ) : null}
      </span>
    );
  }
  const label = `${t("en", "auth.signedInAs")} ${user.displayName ?? ""}`.trim();
  return (
    <span className="auth-control">
      <button
        type="button"
        className="auth-avatar"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        {user.photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- provider photo URL
          <img src={user.photoUrl} alt="" width={44} height={44} />
        ) : (
          <span aria-hidden="true">{authInitials(user.displayName)}</span>
        )}
      </button>
      {menuOpen ? (
        <span className="auth-menu" role="menu">
          <span className="auth-menu-who" role="presentation">
            {label}
          </span>
          <a className="btn" href="/me/boards" role="menuitem">
            📌 {t("en", "auth.myBoards")}
          </a>
          <button
            type="button"
            className="btn"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              void signOut();
            }}
          >
            {t("en", "auth.signOut")}
          </button>
        </span>
      ) : null}
    </span>
  );
}
