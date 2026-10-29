import { describe, expect, it } from "vitest";
import {
  authInitials,
  resolveAuthUi,
  shouldShowSignInNudge,
} from "./auth-ui";
import { sortMyBoards, type MyBoardCard } from "./my-boards";

describe("resolveAuthUi (flag-off parity contract)", () => {
  const full = {
    authMode: "optional",
    apiKey: "synthetic-web-key",
    authDomain: "synthetic-proj.firebaseapp.com",
    projectId: "synthetic-proj",
  };

  it("link-only disables the UI even with full web config", () => {
    expect(resolveAuthUi({ ...full, authMode: "link-only" })).toEqual({
      enabled: false,
      config: null,
    });
  });

  it("optional without web config stays hidden, honestly", () => {
    expect(resolveAuthUi({ ...full, apiKey: null }).enabled).toBe(false);
    expect(resolveAuthUi({ ...full, apiKey: "  " }).enabled).toBe(false);
    expect(resolveAuthUi({ ...full, authDomain: null }).enabled).toBe(false);
    expect(
      resolveAuthUi({ ...full, authDomain: "auth.example.test", projectId: null })
        .enabled,
    ).toBe(false);
  });

  it("optional + full config enables; project id derives from authDomain", () => {
    expect(resolveAuthUi(full)).toEqual({
      enabled: true,
      config: {
        apiKey: "synthetic-web-key",
        authDomain: "synthetic-proj.firebaseapp.com",
        projectId: "synthetic-proj",
      },
    });
    const derived = resolveAuthUi({ ...full, projectId: null });
    expect(derived.config?.projectId).toBe("synthetic-proj");
  });
});

describe("authInitials", () => {
  it("first + last initials, uppercased; ? when unnamed", () => {
    expect(authInitials("Alice A")).toBe("AA");
    expect(authInitials("bob")).toBe("B");
    expect(authInitials("  Jo  van Der Berg ")).toBe("JB");
    expect(authInitials(null)).toBe("?");
    expect(authInitials("")).toBe("?");
  });
});

describe("shouldShowSignInNudge", () => {
  const base = {
    authEnabled: true,
    policyNudge: true,
    signedIn: false,
    joined: true,
    myPinnedCount: 1,
    seenBefore: false,
  };

  it("shows after the first pinned pin when every gate passes", () => {
    expect(shouldShowSignInNudge(base)).toBe(true);
  });

  it("each gate independently hides it", () => {
    expect(shouldShowSignInNudge({ ...base, authEnabled: false })).toBe(false);
    expect(shouldShowSignInNudge({ ...base, policyNudge: false })).toBe(false);
    expect(shouldShowSignInNudge({ ...base, signedIn: true })).toBe(false);
    expect(shouldShowSignInNudge({ ...base, joined: false })).toBe(false);
    expect(shouldShowSignInNudge({ ...base, myPinnedCount: 0 })).toBe(false);
    expect(shouldShowSignInNudge({ ...base, seenBefore: true })).toBe(false);
  });
});

describe("sortMyBoards", () => {
  const card = (slug: string, lastActivityAt: number, claimedAt = 0): MyBoardCard => ({
    slug,
    title: slug,
    themeId: null,
    themeLabel: null,
    themeMotif: null,
    myPinCount: 0,
    latestSceneImageUrl: null,
    lastActivityAt,
    claimedAt,
  });

  it("newest activity first, stable tie-breaks, input untouched", () => {
    const input = [card("b", 100, 5), card("a", 200, 1), card("c", 100, 9), card("d", 100, 5)];
    const sorted = sortMyBoards(input);
    expect(sorted.map((c) => c.slug)).toEqual(["a", "c", "b", "d"]);
    expect(input.map((c) => c.slug)).toEqual(["b", "a", "c", "d"]);
  });
});
