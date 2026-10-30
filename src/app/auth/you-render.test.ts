import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ICON_PATHS } from "../../ui";
import type { AuthContextValue, AuthUser } from "./AuthProvider";
import { YouView, type YouBoard } from "./You";

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);
const noop = () => {};

const linkOnly: AuthContextValue = {
  enabled: false,
  status: "signedOut",
  user: null,
  signInError: false,
  signIn: async () => {},
  signOut: async () => {},
};
const signedOut: AuthContextValue = { ...linkOnly, enabled: true };
const robin: AuthUser = { uid: "u-robin", displayName: "Robin Elm", photoUrl: "https://example.test/robin.jpg" };
const signedIn: AuthContextValue = { ...signedOut, status: "signedIn", user: robin };

const board = (over: Partial<YouBoard> = {}): YouBoard => ({
  me: null,
  isHost: false,
  onJoin: noop,
  onEditName: noop,
  onChangeLook: noop,
  ...over,
});
const sam = { id: "p-sam", displayName: "Sam" };

/** Menu item labels in order. */
const items = (markup: string) =>
  [...markup.matchAll(/role="menuitem"[^>]*>([^<]*)</g)].map((match) => match[1]);
const PERSON_ICON = ICON_PATHS.person[0];

describe('"you" button on a board (PIN-120)', () => {
  it("starts closed: a labelled menu button", () => {
    const out = html(h(YouView, { auth: linkOnly, board: board() }));
    expect(out).toContain('aria-haspopup="menu"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-label="You"');
    expect(out).not.toContain('role="menu"');
  });

  it("offers a guest only Join this board, under a person icon (link-only: no account DOM)", () => {
    const out = html(h(YouView, { auth: linkOnly, board: board(), initialOpen: true }));
    expect(items(out)).toEqual(["Join this board"]);
    expect(out).toContain(PERSON_ICON);
    expect(out).not.toContain("pn-menu-note");
    expect(out).not.toMatch(/Sign in|Sign out|My boards|My pins|role="alert"/);
  });

  it("shows a joined participant's initial and You're {name} here above Edit name", () => {
    const out = html(h(YouView, { auth: linkOnly, board: board({ me: sam }), initialOpen: true }));
    expect(out).toContain('aria-label="You: Sam"');
    expect(out).toMatch(/class="pn-avatar pn-avatar-lg"[^>]*>S</);
    expect(out).toContain("You&#x27;re Sam here");
    expect(items(out)).toEqual(["Edit name"]);
  });

  it("gives the host Change look", () => {
    const out = html(h(YouView, { auth: linkOnly, board: board({ me: sam, isHost: true }), initialOpen: true }));
    expect(items(out)).toEqual(["Edit name", "Change look"]);
  });

  it("offers Sign in with Google when sign-in is on and you are signed out", () => {
    const out = html(h(YouView, { auth: signedOut, board: board({ me: sam }), initialOpen: true }));
    expect(items(out)).toEqual(["Edit name", "Sign in with Google"]);
  });

  it("signed in: the Google photo, the library links, and Sign out last", () => {
    const out = html(h(YouView, { auth: signedIn, board: board({ me: sam, isHost: true }), initialOpen: true }));
    expect(out).toContain('src="https://example.test/robin.jpg"');
    expect(items(out)).toEqual(["Edit name", "My boards", "My pins", "Change look", "Sign out"]);
    expect(out).toContain('href="/me/boards"');
    expect(out).toContain('href="/me/pins"');
  });

  it("puts a failed sign-in on top of the menu and in a live region", () => {
    const out = html(
      h(YouView, { auth: { ...signedOut, signInError: true }, board: board({ me: sam }), initialOpen: true }),
    );
    expect(out).toContain('<p class="pn-menu-note" aria-hidden="true">Sign-in failed. Try again.</p>');
    expect(out).toMatch(/role="alert">Sign-in failed\. Try again\.</);
  });
});

describe('"you" button off a board (PIN-120)', () => {
  it("renders nothing at all in link-only", () => {
    expect(html(h(YouView, { auth: linkOnly }))).toBe("");
  });

  it("is a quiet Sign in when signed out, and nothing where the page is the sign-in prompt", () => {
    const out = html(h(YouView, { auth: signedOut }));
    expect(out).toMatch(/<button[^>]*>Sign in<\/button>/);
    expect(out).not.toContain('aria-haspopup="menu"');
    expect(html(h(YouView, { auth: signedOut, offerSignIn: false }))).toBe("");
  });

  it("holds the place while sign-in state loads", () => {
    expect(html(h(YouView, { auth: { ...signedOut, status: "loading" } }))).toContain("pn-you-skeleton");
  });

  it("signed in: the account menu only", () => {
    const out = html(h(YouView, { auth: signedIn, initialOpen: true }));
    expect(out).toContain('aria-label="You: Robin Elm"');
    expect(items(out)).toEqual(["My boards", "My pins", "Sign out"]);
  });
});
