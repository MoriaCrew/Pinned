/**
 * The "you" button (PIN-120): one control in every page's own header
 * for who you are here: your name on this board and, when sign-in
 * is on, your Google account. Pure decisions, client-safe, so every
 * state is unit-testable without a DOM.
 */

export type AuthStatus = "loading" | "signedOut" | "signedIn";

export interface YouState {
  /** On a board page: the board identity entries apply. */
  onBoard: boolean;
  /** Joined this board (has a participant). */
  joined: boolean;
  /** The board's host (`viewer.isHost`). */
  isHost: boolean;
  /** Sign-in UI is on (AUTH_MODE=optional with the web config). */
  authEnabled: boolean;
  authStatus: AuthStatus;
}

/** One menu line, in display order. `joinedAs` is the quiet header line, not an item. */
export type YouEntry =
  | "joinedAs"
  | "editName"
  | "join"
  | "myBoards"
  | "myPins"
  | "changeLook"
  | "deleteBoard"
  | "signIn"
  | "signOut";

/**
 * What the menu offers, in order, each only when it applies: your
 * name here (or Join), your library when signed in, Change look and
 * Delete board for the host (PIN-168), then Sign in / Sign out.
 * Link-only (auth off) never gets an account entry; nothing
 * account-shaped shows while auth loads.
 */
export function youMenuEntries(state: YouState): YouEntry[] {
  const entries: YouEntry[] = [];
  if (state.onBoard) {
    if (state.joined) entries.push("joinedAs", "editName");
    else entries.push("join");
  }
  const signedIn = state.authEnabled && state.authStatus === "signedIn";
  if (signedIn) entries.push("myBoards", "myPins");
  if (state.onBoard && state.isHost) entries.push("changeLook", "deleteBoard");
  if (state.authEnabled && state.authStatus !== "loading") {
    entries.push(signedIn ? "signOut" : "signIn");
  }
  return entries;
}

/**
 * Which control the header shows. On a board there is always the
 * button (your name here works without sign-in). Elsewhere it is
 * account-only: nothing when sign-in is off, a placeholder while it
 * loads, a quiet "Sign in" (unless the page itself is the sign-in
 * prompt), and the button once signed in.
 */
export function youControl(
  state: Pick<YouState, "onBoard" | "authEnabled" | "authStatus">,
  options: { offerSignIn?: boolean } = {},
): "none" | "loading" | "signIn" | "button" {
  if (state.onBoard) return "button";
  if (!state.authEnabled) return "none";
  if (state.authStatus === "loading") return "loading";
  if (state.authStatus === "signedOut") return options.offerSignIn === false ? "none" : "signIn";
  return "button";
}

export interface YouFaceInput {
  onBoard: boolean;
  me: { id: string; displayName: string } | null;
  user: { uid: string; displayName: string | null; photoUrl: string | null } | null;
}

export type YouFace =
  | { kind: "photo"; id: string; name: string; src: string }
  | { kind: "initials"; id: string; name: string }
  | { kind: "icon" };

/**
 * What the button shows: the Google photo when signed in; else, on a
 * board you joined, your initials in your person colour; else the
 * signed-in name's initials; else a person icon.
 */
export function youFace({ onBoard, me, user }: YouFaceInput): YouFace {
  if (user?.photoUrl) {
    return { kind: "photo", id: user.uid, name: user.displayName ?? "", src: user.photoUrl };
  }
  if (onBoard && me) return { kind: "initials", id: me.id, name: me.displayName };
  if (user) return { kind: "initials", id: user.uid, name: user.displayName ?? "" };
  return { kind: "icon" };
}

/** The name the button speaks: your name on this board, else your account name. */
export function youName({ onBoard, me, user }: YouFaceInput): string | null {
  if (onBoard && me) return me.displayName;
  const name = user?.displayName?.trim();
  return name ? name : null;
}
