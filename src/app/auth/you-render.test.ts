import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocaleProvider } from "../../i18n/client";
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
  canChangeLook: false,
  plus: null,
  onJoin: noop,
  onEditName: noop,
  onChangeLook: noop,
  onBoardPlus: noop,
  onDeleteBoard: noop,
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

  it("gives the host Change look and a danger Delete board; a non-host never sees it (PIN-168)", () => {
    const out = html(h(YouView, { auth: linkOnly, board: board({ me: sam, isHost: true }), initialOpen: true }));
    expect(items(out)).toEqual(["Edit name", "Change look", "Delete board"]);
    expect(out).toMatch(/<button[^>]*data-danger=""[^>]*>Delete board</);
    expect(out.match(/data-danger/g)).toHaveLength(1);
    const guest = html(h(YouView, { auth: linkOnly, board: board({ me: sam }), initialOpen: true }));
    expect(guest).not.toContain("Delete board");
    expect(guest).not.toContain("data-danger");
  });

  it("offers Sign in with Google when sign-in is on and you are signed out", () => {
    const out = html(h(YouView, { auth: signedOut, board: board({ me: sam }), initialOpen: true }));
    expect(items(out)).toEqual(["Edit name", "Sign in with Google"]);
  });

  it("signed in: the Google photo, the library links, and Sign out last", () => {
    const out = html(h(YouView, { auth: signedIn, board: board({ me: sam, isHost: true }), initialOpen: true }));
    expect(out).toContain('src="https://example.test/robin.jpg"');
    expect(items(out)).toEqual(["Edit name", "My boards", "My pins", "Change look", "Delete board", "Sign out"]);
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

describe("Board Plus and Change look in the menu (PIN-183)", () => {
  const credits = (over: { active?: boolean; availableMakes?: number } = {}) => ({
    active: false,
    availableMakes: 4,
    ...over,
  });
  const open = (over: Partial<YouBoard>) => html(h(YouView, { auth: linkOnly, board: board(over), initialOpen: true }));
  /** The Board Plus line: its label and the quiet subline under it. */
  const boardPlus = (markup: string) =>
    /role="menuitem"[^>]*>Board Plus<span class="pn-menu-detail">([^<]*)<\/span>/.exec(markup)?.[1];

  it("shows a guest the entry under Join, with the count, and no Change look", () => {
    const out = open({ plus: credits() });
    expect(items(out)).toEqual(["Join this board", "Board Plus"]);
    expect(boardPlus(out)).toBe("4 creations left");
  });

  it("reads one left in the singular", () => {
    expect(boardPlus(open({ me: sam, plus: credits({ availableMakes: 1 }) }))).toBe("1 creation left");
    expect(boardPlus(open({ me: sam, plus: credits({ availableMakes: 0 }) }))).toBe("0 creations left");
    expect(boardPlus(open({ me: sam, plus: credits({ active: true, availableMakes: 1 }) }))).toBe("Plus is on · 1 creation left");
  });

  it("reads the subline in the language of the page, as whole sentences", () => {
    const fr = html(
      h(LocaleProvider, {
        locale: "fr",
        enabled: ["en", "fr"],
        cookieMaxAgeSeconds: 1,
        children: h(YouView, { auth: linkOnly, board: board({ me: sam, plus: credits({ availableMakes: 4 }) }), initialOpen: true }),
      }),
    );
    expect(boardPlus(fr)).toBe("4 créations restantes");
    const frPlus = html(
      h(LocaleProvider, {
        locale: "fr",
        enabled: ["en", "fr"],
        cookieMaxAgeSeconds: 1,
        children: h(YouView, {
          auth: linkOnly,
          board: board({ me: sam, plus: credits({ active: true, availableMakes: 1 }) }),
          initialOpen: true,
        }),
      }),
    );
    expect(boardPlus(frPlus)).toBe("Plus est activé · 1 création restante");
  });

  it("gives a member Board Plus but no Change look while the board has no Plus", () => {
    const out = open({ me: sam, plus: credits() });
    expect(items(out)).toEqual(["Edit name", "Board Plus"]);
    expect(out).not.toContain("Change look");
  });

  it("says Plus is on in the subline, and gives that member Change look, not Delete board", () => {
    const out = open({ me: sam, canChangeLook: true, plus: credits({ active: true, availableMakes: 18 }) });
    expect(boardPlus(out)).toBe("Plus is on · 18 creations left");
    expect(items(out)).toEqual(["Edit name", "Board Plus", "Change look"]);
    expect(out).not.toContain("Delete board");
    expect(out).not.toContain("data-danger");
  });

  it("gives the host Board Plus, Change look and Delete board in that order", () => {
    const out = open({ me: sam, isHost: true, canChangeLook: true, plus: credits() });
    expect(items(out)).toEqual(["Edit name", "Board Plus", "Change look", "Delete board"]);
    expect(out.match(/data-danger/g)).toHaveLength(1);
  });

  it("leaves Board Plus out of a board without creations, so the menu is as before", () => {
    const out = open({ me: sam, plus: null });
    expect(items(out)).toEqual(["Edit name"]);
    expect(out).not.toContain("data-detail");
    expect(out).not.toContain("pn-menu-detail");
  });

  it("is a menu item that opens the Plus sheet, after My pins when signed in", () => {
    const out = html(
      h(YouView, { auth: signedIn, board: board({ me: sam, plus: credits() }), initialOpen: true }),
    );
    expect(items(out)).toEqual(["Edit name", "My boards", "My pins", "Board Plus", "Sign out"]);
    expect(out).toMatch(/<button[^>]*role="menuitem"[^>]*data-detail=""/);
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
