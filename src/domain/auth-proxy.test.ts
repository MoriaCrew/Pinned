import { describe, expect, it } from "vitest";
import {
  FIREBASE_AUTH_PROXY_SOURCE,
  firebaseAuthProxyRewrites,
  isFirebaseProjectId,
} from "./auth-proxy";

describe("firebaseAuthProxyRewrites (PIN-163)", () => {
  it("off: no rewrites, even with a valid project id", () => {
    expect(firebaseAuthProxyRewrites({ enabled: false, projectId: "demo-proj" })).toEqual([]);
  });

  it("on: exactly one /__/auth rule to the project's firebaseapp host", () => {
    expect(firebaseAuthProxyRewrites({ enabled: true, projectId: "demo-proj" })).toEqual([
      {
        source: "/__/auth/:path*",
        destination: "https://demo-proj.firebaseapp.com/__/auth/:path*",
      },
    ]);
    expect(FIREBASE_AUTH_PROXY_SOURCE).toBe("/__/auth/:path*");
  });

  it("missing or invalid project id: no rewrites", () => {
    for (const projectId of [
      null,
      "",
      " demo-proj",
      "Demo-Proj",
      "demo",
      "1demo-proj",
      "demo-proj-",
      "demo_proj",
      "demo.proj",
      "evil.example/x",
      "demo-proj.evil.example",
      "demo-proj@evil.example",
      "a".repeat(31),
    ]) {
      expect(firebaseAuthProxyRewrites({ enabled: true, projectId }), String(projectId)).toEqual(
        [],
      );
    }
  });
});

describe("isFirebaseProjectId", () => {
  it("accepts the GCP project id shape only", () => {
    expect(isFirebaseProjectId("moriacrew-pinned-dev")).toBe(true);
    expect(isFirebaseProjectId("abcdef")).toBe(true);
    expect(isFirebaseProjectId("a".repeat(30))).toBe(true);
    expect(isFirebaseProjectId("abcde")).toBe(false);
    expect(isFirebaseProjectId(undefined)).toBe(false);
  });
});
