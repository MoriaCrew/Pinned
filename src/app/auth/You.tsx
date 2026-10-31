"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import {
  youControl,
  youFace,
  youMenuEntries,
  youName,
  type YouEntry,
  type YouState,
} from "../../domain/you-menu";
import { t, tf } from "../../i18n";
import { Avatar, Icon, Menu, cx } from "../../ui";
import { useAuth, type AuthContextValue } from "./AuthProvider";
import { SignInButton } from "./SignInButton";

/** What a board page tells the button (absent everywhere else). */
export interface YouBoard {
  me: { id: string; displayName: string } | null;
  isHost: boolean;
  /** Opens the join sheet. */
  onJoin: () => void;
  /** Opens the join sheet in edit mode. */
  onEditName: () => void;
  /** Opens the host's Change look (PIN-111 look flow). */
  onChangeLook: () => void;
  /** Opens the host's Delete board confirm (PIN-168). */
  onDeleteBoard: () => void;
}

/**
 * The one "you" button (PIN-120), last in every page's own header:
 * your photo, your initials in your person colour, or a person icon.
 * It opens a small menu with your name on this board (Edit name or
 * Join this board), My boards / My pins when signed in, Change look
 * and Delete board (a danger entry that asks first) for the host, and
 * Sign in / Sign out when sign-in is on. Link-only pages get no
 * account entries and, off a board, nothing at all.
 */
export function You(props: { board?: YouBoard; offerSignIn?: boolean; className?: string }) {
  const auth = useAuth();
  return <YouView auth={auth} {...props} />;
}

/** `You` with the sign-in state passed in (render tests, previews). */
export function YouView({
  auth,
  board,
  offerSignIn = true,
  initialOpen = false,
  className,
}: {
  auth: AuthContextValue;
  board?: YouBoard;
  /** False on pages that are themselves the sign-in prompt (no second "Sign in"). */
  offerSignIn?: boolean;
  initialOpen?: boolean;
  /** Placement on the page (the root renders nothing when there is nothing to show). */
  className?: string;
}) {
  const [open, setOpen] = useState(initialOpen);
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useMenuKeys(open, setOpen, rootRef, buttonRef);

  const onBoard = board !== undefined;
  // A failed sign-in (from this menu or the board's nudge) opens the
  // menu again with the reason on top and "Sign in with Google" below.
  useEffect(() => {
    if (auth.signInError && onBoard) setOpen(true);
  }, [auth.signInError, onBoard]);

  const state: YouState = {
    onBoard,
    joined: Boolean(board?.me),
    isHost: board?.isHost === true,
    authEnabled: auth.enabled,
    authStatus: auth.status,
  };
  const control = youControl(state, { offerSignIn });
  if (control === "none") return null;
  if (control === "loading") return <span className={cx("pn-you pn-you-skeleton", className)} aria-hidden="true" />;
  if (control === "signIn") {
    return (
      <span className={cx("pn-you", className)}>
        <SignInButton />
      </span>
    );
  }

  const who = { onBoard, me: board?.me ?? null, user: auth.enabled ? auth.user : null };
  const face = youFace(who);
  const name = youName(who);
  const label = name ? tf("en", "you.named", { name }) : t("en", "you.label");
  const entries = youMenuEntries(state);
  const failed = auth.enabled && auth.signInError && auth.status !== "signedIn";
  const note = failed
    ? t("en", "auth.failed")
    : entries.includes("joinedAs") && board?.me
      ? tf("en", "you.joinedAs", { name: board.me.displayName })
      : undefined;

  const close = () => setOpen(false);
  // Focus goes back to the button first, so a sheet opened from the
  // menu hands focus back to it when it closes.
  const act = (run: () => void) => () => {
    buttonRef.current?.focus({ preventScroll: true });
    setOpen(false);
    run();
  };
  const item = (entry: YouEntry) => {
    switch (entry) {
      case "joinedAs":
        return [];
      case "editName":
        return board ? [{ label: t("en", "you.editName"), onSelect: act(board.onEditName) }] : [];
      case "join":
        return board ? [{ label: t("en", "you.join"), onSelect: act(board.onJoin) }] : [];
      case "myBoards":
        return [{ label: t("en", "you.myBoards"), href: "/me/boards", onSelect: close }];
      case "myPins":
        return [{ label: t("en", "you.myPins"), href: "/me/pins", onSelect: close }];
      case "changeLook":
        return board ? [{ label: t("en", "you.changeLook"), onSelect: act(board.onChangeLook) }] : [];
      case "deleteBoard":
        return board
          ? [{ label: t("en", "you.deleteBoard"), danger: true, onSelect: act(board.onDeleteBoard) }]
          : [];
      case "signIn":
        return [{ label: t("en", "you.signIn"), onSelect: act(() => void auth.signIn()) }];
      case "signOut":
        return [{ label: t("en", "you.signOut"), onSelect: act(() => void auth.signOut()) }];
    }
  };

  return (
    <span className={cx("pn-you", className)} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="pn-you-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {face.kind === "icon" ? (
          <span className="pn-you-icon">
            <Icon name="person" size={22} />
          </span>
        ) : (
          <Avatar id={face.id} name={face.name} src={face.kind === "photo" ? face.src : undefined} size="lg" />
        )}
      </button>
      {open ? <Menu label={label} note={note} className="pn-you-menu" items={entries.flatMap(item)} /> : null}
      {auth.enabled ? (
        <span className="pn-sr" role="alert">
          {failed ? t("en", "auth.failed") : ""}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Menu keyboard and dismissal (from the PIN-84 account menu): focus
 * the first item on open; Escape closes and returns to the button;
 * arrows move only while focus is inside; a tap outside or Tab out
 * closes.
 */
function useMenuKeys(
  open: boolean,
  setOpen: (open: boolean) => void,
  rootRef: RefObject<HTMLSpanElement | null>,
  buttonRef: RefObject<HTMLButtonElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const items = () =>
      Array.from(rootRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    items()[0]?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!rootRef.current?.contains(document.activeElement)) return;
      const list = items();
      if (list.length === 0) return;
      event.preventDefault();
      const at = list.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "ArrowDown" ? (at + 1) % list.length : (at - 1 + list.length) % list.length;
      list[next].focus({ preventScroll: true });
    };
    const onFocus = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
    };
  }, [open, setOpen, rootRef, buttonRef]);
}
