import { describe, expect, it } from "vitest";
import { youControl, youFace, youMenuEntries, youName, type YouState } from "./you-menu";

const state = (over: Partial<YouState> = {}): YouState => ({
  onBoard: true,
  joined: false,
  isHost: false,
  canChangeLook: false,
  hasCredits: false,
  authEnabled: false,
  authStatus: "signedOut",
  languageCount: 1,
  ...over,
});

describe("you menu entries (PIN-120)", () => {
  it("offers Join to a guest and Edit name once joined, with no account entries in link-only", () => {
    expect(youMenuEntries(state())).toEqual(["join"]);
    expect(youMenuEntries(state({ joined: true }))).toEqual(["joinedAs", "editName"]);
  });

  it("adds the library when signed in and Sign in / Sign out when sign-in is on", () => {
    expect(youMenuEntries(state({ authEnabled: true }))).toEqual(["join", "signIn"]);
    expect(youMenuEntries(state({ joined: true, authEnabled: true, authStatus: "signedIn" }))).toEqual([
      "joinedAs",
      "editName",
      "myBoards",
      "myPins",
      "signOut",
    ]);
  });

  it("gives the host Change look and Delete board before the account line (PIN-168)", () => {
    expect(youMenuEntries(state({ joined: true, isHost: true }))).toEqual([
      "joinedAs",
      "editName",
      "changeLook",
      "deleteBoard",
    ]);
    expect(youMenuEntries(state({ joined: true, isHost: true, authEnabled: true }))).toEqual([
      "joinedAs",
      "editName",
      "changeLook",
      "deleteBoard",
      "signIn",
    ]);
  });

  it("never offers Delete board to a non-host, or off a board (PIN-168)", () => {
    expect(youMenuEntries(state({ joined: true }))).not.toContain("deleteBoard");
    expect(youMenuEntries(state({ joined: true, authEnabled: true, authStatus: "signedIn" }))).not.toContain(
      "deleteBoard",
    );
    expect(youMenuEntries(state({ onBoard: false, isHost: true }))).not.toContain("deleteBoard");
  });

  it("shows nothing account-shaped while sign-in state loads", () => {
    expect(youMenuEntries(state({ authEnabled: true, authStatus: "loading" }))).toEqual(["join"]);
  });

  it("keeps board entries off other pages", () => {
    expect(youMenuEntries(state({ onBoard: false, isHost: true, authEnabled: true, authStatus: "signedIn" }))).toEqual([
      "myBoards",
      "myPins",
      "signOut",
    ]);
  });

  it("ignores a stale signed-in status when sign-in is off", () => {
    expect(youMenuEntries(state({ authEnabled: false, authStatus: "signedIn" }))).toEqual(["join"]);
  });
});

describe("Board Plus and Change look entries (PIN-183)", () => {
  const withCredits = { joined: true, hasCredits: true };

  it("shows Board Plus to everyone on a board with creations, a guest included", () => {
    expect(youMenuEntries(state({ hasCredits: true }))).toEqual(["join", "boardPlus"]);
    expect(youMenuEntries(state(withCredits))).toEqual(["joinedAs", "editName", "boardPlus"]);
  });

  it("leaves Board Plus out without creations, and off a board", () => {
    expect(youMenuEntries(state({ joined: true }))).not.toContain("boardPlus");
    expect(youMenuEntries(state({ onBoard: false, hasCredits: true }))).not.toContain("boardPlus");
  });

  it("puts Board Plus after the library and before Change look", () => {
    expect(
      youMenuEntries(
        state({ ...withCredits, isHost: true, canChangeLook: true, authEnabled: true, authStatus: "signedIn", languageCount: 2 }),
      ),
    ).toEqual(["joinedAs", "editName", "myBoards", "myPins", "boardPlus", "changeLook", "deleteBoard", "language", "signOut"]);
  });

  it("gives a member Change look once the board has Plus, but never Delete board", () => {
    const member = youMenuEntries(state({ ...withCredits, canChangeLook: true }));
    expect(member).toEqual(["joinedAs", "editName", "boardPlus", "changeLook"]);
    expect(member).not.toContain("deleteBoard");
    // A member on a board without Plus has no Change look.
    expect(youMenuEntries(state(withCredits))).not.toContain("changeLook");
  });

  it("keeps the host's Change look and Delete board whatever the view says about Plus", () => {
    expect(youMenuEntries(state({ joined: true, isHost: true }))).toEqual(["joinedAs", "editName", "changeLook", "deleteBoard"]);
    expect(youMenuEntries(state({ joined: true, isHost: true, canChangeLook: true }))).toEqual([
      "joinedAs",
      "editName",
      "changeLook",
      "deleteBoard",
    ]);
  });

  it("keeps Change look off other pages", () => {
    expect(youMenuEntries(state({ canChangeLook: true, onBoard: false }))).not.toContain("changeLook");
  });
});

describe("you control (PIN-120)", () => {
  it("is always a button on a board, even in link-only", () => {
    expect(youControl(state())).toBe("button");
  });

  it("is nothing off a board when sign-in is off", () => {
    expect(youControl(state({ onBoard: false }))).toBe("none");
  });

  it("waits, then offers a quiet Sign in, unless the page is the sign-in prompt", () => {
    expect(youControl(state({ onBoard: false, authEnabled: true, authStatus: "loading" }))).toBe("loading");
    expect(youControl(state({ onBoard: false, authEnabled: true }))).toBe("signIn");
    expect(youControl(state({ onBoard: false, authEnabled: true }), { offerSignIn: false })).toBe("none");
    expect(youControl(state({ onBoard: false, authEnabled: true, authStatus: "signedIn" }))).toBe("button");
  });
});

describe("you face (PIN-120)", () => {
  const me = { id: "p1", displayName: "Sam" };
  const user = { uid: "u1", displayName: "Robin Elm", photoUrl: null };

  it("prefers the Google photo, then your name here, then the account name, then an icon", () => {
    expect(youFace({ onBoard: true, me, user: { ...user, photoUrl: "/robin.jpg" } })).toEqual({
      kind: "photo",
      id: "u1",
      name: "Robin Elm",
      src: "/robin.jpg",
    });
    expect(youFace({ onBoard: true, me, user })).toEqual({ kind: "initials", id: "p1", name: "Sam" });
    expect(youFace({ onBoard: true, me: null, user })).toEqual({ kind: "initials", id: "u1", name: "Robin Elm" });
    expect(youFace({ onBoard: false, me: null, user: null })).toEqual({ kind: "icon" });
  });

  it("speaks your name here first, else the account name", () => {
    expect(youName({ onBoard: true, me, user })).toBe("Sam");
    expect(youName({ onBoard: true, me: null, user })).toBe("Robin Elm");
    expect(youName({ onBoard: true, me: null, user: { ...user, displayName: " " } })).toBeNull();
    expect(youName({ onBoard: true, me: null, user: null })).toBeNull();
  });
});

describe("language entry (PIN-191)", () => {
  it("is hidden with one language, so the menu is exactly as before", () => {
    expect(youMenuEntries(state({ languageCount: 1 }))).toEqual(["join"]);
    expect(youMenuEntries(state({ languageCount: 1, authEnabled: true }))).toEqual(["join", "signIn"]);
  });

  it("is shown with two languages, before the account line", () => {
    expect(youMenuEntries(state({ languageCount: 2 }))).toEqual(["join", "language"]);
    expect(youMenuEntries(state({ joined: true, isHost: true, authEnabled: true, languageCount: 7 }))).toEqual([
      "joinedAs",
      "editName",
      "changeLook",
      "deleteBoard",
      "language",
      "signIn",
    ]);
  });

  it("gives the button off a board when there are several languages, even in link-only", () => {
    expect(youControl(state({ onBoard: false, languageCount: 1 }))).toBe("none");
    expect(youControl(state({ onBoard: false, languageCount: 2 }))).toBe("button");
    expect(youControl(state({ onBoard: false, authEnabled: true, languageCount: 2 }))).toBe("button");
    expect(youControl(state({ onBoard: false, authEnabled: true, authStatus: "loading", languageCount: 2 }))).toBe(
      "loading",
    );
  });
});
