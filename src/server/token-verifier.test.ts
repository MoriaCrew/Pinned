import { describe, expect, it } from "vitest";
import {
  FakeTokenVerifier,
  FirebaseAdminTokenVerifier,
  identityFromDecodedToken,
} from "./token-verifier";

/**
 * TokenVerifier contract (PIN-94): the port surfaces the Firebase
 * provider + auth_time claims, revocation checking is passed
 * through to the Admin SDK, and the Fake mirrors both so route
 * and service tests exercise the same rules. Synthetic only.
 */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

describe("FakeTokenVerifier (PIN-94 mirror)", () => {
  const fake = new FakeTokenVerifier(
    {
      "tok-fresh": { uid: "synthetic-fresh" },
      "tok-anon": { uid: "synthetic-anon", signInProvider: "anonymous" },
      "tok-stale": { uid: "synthetic-stale", authTimeMs: NOW - 7_200_000 },
      "tok-revoked": { uid: "synthetic-revoked", revoked: true },
    },
    () => NOW,
  );

  it("defaults to a fresh Google sign-in at the fake clock", async () => {
    expect(await fake.verifyIdToken("tok-fresh")).toEqual({
      uid: "synthetic-fresh",
      signInProvider: "google.com",
      authTimeMs: NOW,
    });
  });

  it("surfaces explicit provider and auth_time overrides", async () => {
    expect((await fake.verifyIdToken("tok-anon"))?.signInProvider).toBe(
      "anonymous",
    );
    expect((await fake.verifyIdToken("tok-stale"))?.authTimeMs).toBe(
      NOW - 7_200_000,
    );
  });

  it("revoked entries fail only when the caller checks revocation", async () => {
    expect(
      (await fake.verifyIdToken("tok-revoked"))?.uid,
    ).toBe("synthetic-revoked");
    expect(
      await fake.verifyIdToken("tok-revoked", { checkRevoked: true }),
    ).toBeNull();
    // The revoked flag itself never leaks into the identity.
    expect(await fake.verifyIdToken("tok-revoked")).not.toHaveProperty(
      "revoked",
    );
  });

  it("unknown tokens are null", async () => {
    expect(await fake.verifyIdToken("nope", { checkRevoked: true })).toBeNull();
  });
});

describe("identityFromDecodedToken (PIN-94 claim extraction)", () => {
  it("maps provider + auth_time seconds and keeps name/photo", () => {
    expect(
      identityFromDecodedToken({
        uid: "synthetic-1",
        name: "Syn Thetic",
        picture: "https://example.test/p.png",
        auth_time: 1_700_000_000,
        firebase: { sign_in_provider: "google.com" },
      }),
    ).toEqual({
      uid: "synthetic-1",
      displayName: "Syn Thetic",
      photoUrl: "https://example.test/p.png",
      signInProvider: "google.com",
      authTimeMs: 1_700_000_000_000,
    });
  });

  it("omits malformed provider/auth_time instead of inventing them", () => {
    expect(
      identityFromDecodedToken({
        uid: "synthetic-1",
        auth_time: "1700000000",
        firebase: { sign_in_provider: 42 },
      }),
    ).toEqual({ uid: "synthetic-1" });
    expect(identityFromDecodedToken({ uid: "synthetic-1", firebase: null })).toEqual({
      uid: "synthetic-1",
    });
  });

  it("is null without a uid", () => {
    expect(identityFromDecodedToken({})).toBeNull();
    expect(identityFromDecodedToken({ uid: "" })).toBeNull();
    expect(identityFromDecodedToken({ uid: 7 })).toBeNull();
  });
});

describe("FirebaseAdminTokenVerifier (injected Admin Auth)", () => {
  it("passes checkRevoked through and fails closed when Firebase throws revoked", async () => {
    const seen: boolean[] = [];
    const verifier = new FirebaseAdminTokenVerifier("synthetic-project", async () => ({
      verifyIdToken: async (_idToken: string, checkRevoked?: boolean) => {
        seen.push(checkRevoked ?? false);
        if (checkRevoked) throw new Error("auth/id-token-revoked");
        return {
          uid: "synthetic-1",
          auth_time: 1_700_000_000,
          firebase: { sign_in_provider: "google.com" },
        };
      },
    }));

    expect((await verifier.verifyIdToken("tok"))?.signInProvider).toBe(
      "google.com",
    );
    expect(await verifier.verifyIdToken("tok", { checkRevoked: true })).toBeNull();
    expect(seen).toEqual([false, true]);
  });

  it("fails closed without a project id or when the loader fails", async () => {
    const noProject = new FirebaseAdminTokenVerifier(null, async () => ({
      verifyIdToken: async () => ({ uid: "synthetic-1" }),
    }));
    expect(await noProject.verifyIdToken("tok", { checkRevoked: true })).toBeNull();

    const broken = new FirebaseAdminTokenVerifier("synthetic-project", async () => {
      throw new Error("no credentials");
    });
    expect(await broken.verifyIdToken("tok", { checkRevoked: true })).toBeNull();
    expect(await broken.verifyIdToken("", { checkRevoked: true })).toBeNull();
  });
});
