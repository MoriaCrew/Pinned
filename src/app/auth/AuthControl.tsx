"use client";

import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Avatar, Menu } from "../../ui";
import { useAuth } from "./AuthProvider";
import { SignInButton } from "./SignInButton";

/**
 * Quiet sign-in surface (PIN-84, restyled for the design system
 * in PIN-104). Renders null whenever sign-in is disabled, so
 * link-only pages carry zero auth DOM. Signed out: a quiet
 * "Sign in" button. Signed in: the person's avatar (photo or
 * initials) opening a small menu: My boards, My pins (PIN-85),
 * Sign out. Escape or a tap outside closes it.
 */
export function AuthControl() {
  const { enabled, status, user, signOut } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const items = () =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const list = items();
      if (list.length === 0) return;
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next = event.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
      list[next].focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  if (!enabled) return null;
  if (status === "loading") {
    return <span className="pn-lib-auth-skeleton" aria-hidden="true" />;
  }
  if (!user) {
    return (
      <span className="pn-lib-auth">
        <SignInButton />
      </span>
    );
  }
  const label = `${t("en", "auth.signedInAs")} ${user.displayName ?? ""}`.trim();
  const go = (href: string) => () => {
    setMenuOpen(false);
    window.location.assign(href);
  };
  return (
    <span className="pn-lib-auth" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="pn-lib-avatar"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((open) => !open)}
      >
        <Avatar id={user.uid} name={user.displayName ?? ""} src={user.photoUrl ?? undefined} size="lg" />
      </button>
      {menuOpen ? (
        <Menu
          label={label}
          className="pn-lib-auth-menu"
          items={[
            { label: t("en", "auth.myBoards"), onSelect: go("/me/boards") },
            { label: t("en", "auth.myPins"), onSelect: go("/me/pins") },
            {
              label: t("en", "auth.signOut"),
              onSelect: () => {
                setMenuOpen(false);
                void signOut();
              },
            },
          ]}
        />
      ) : null}
    </span>
  );
}
