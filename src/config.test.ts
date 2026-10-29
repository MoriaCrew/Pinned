import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig (FR8 fail-closed defaults)", () => {
  it("defaults to link-only auth and mock AI with empty env", () => {
    const cfg = parseConfig({});
    expect(cfg.authMode).toBe("link-only");
    expect(cfg.aiMock).toBe(true);
  });

  it("demo board slug: valid slug kept, anything else fails closed to null (PIN-73)", () => {
    expect(parseConfig({}).demoBoardSlug).toBeNull();
    expect(parseConfig({ DEMO_BOARD_SLUG: "" }).demoBoardSlug).toBeNull();
    expect(
      parseConfig({ DEMO_BOARD_SLUG: "AAAAAAAAAAAAAAAAAAAAAA" }).demoBoardSlug,
    ).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(
      parseConfig({ DEMO_BOARD_SLUG: " AAAAAAAAAAAAAAAAAAAAAA " }).demoBoardSlug,
    ).toBe("AAAAAAAAAAAAAAAAAAAAAA");
    expect(parseConfig({ DEMO_BOARD_SLUG: "short" }).demoBoardSlug).toBeNull();
    expect(
      parseConfig({ DEMO_BOARD_SLUG: "../../etc/passwd-padding" }).demoBoardSlug,
    ).toBeNull();
  });

  it("honours optional + live AI only on exact values", () => {
    const cfg = parseConfig({ AUTH_MODE: "optional", AI_MOCK: "0" });
    expect(cfg.authMode).toBe("optional");
    expect(cfg.aiMock).toBe(false);
  });

  it("falls back to link-only on unknown AUTH_MODE", () => {
    expect(parseConfig({ AUTH_MODE: "required" }).authMode).toBe("link-only");
    expect(parseConfig({ AUTH_MODE: "OPTIONAL" }).authMode).toBe("link-only");
  });

  it("pins Meta Standard model IDs by default, key null when unset", () => {
    const cfg = parseConfig({});
    expect(cfg.meta.apiKey).toBeNull();
    expect(cfg.meta.baseUrl).toBe("https://api.meta.ai/v1");
    expect(cfg.meta.sparkModel).toBe("muse-spark-1.3");
    expect(cfg.meta.samModel).toBe("sam-3.1");
    expect(cfg.meta.imageModel).toBe("muse-image-1.0");
  });

  it("defaults persistence to memory and honours explicit Firestore config", () => {
    const empty = parseConfig({});
    expect(empty.dataBackend).toBe("memory");
    expect(empty.firebaseProjectId).toBeNull();
    expect(empty.firestoreEmulatorHost).toBeNull();

    const hosted = parseConfig({
      DATA_BACKEND: "firestore",
      FIREBASE_PROJECT_ID: " demo-project ",
      FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
    });
    expect(hosted.dataBackend).toBe("firestore");
    expect(hosted.firebaseProjectId).toBe("demo-project");
    expect(hosted.firestoreEmulatorHost).toBe("127.0.0.1:8080");
    expect(parseConfig({ DATA_BACKEND: "Firestore" }).dataBackend).toBe("memory");
  });

  it("defaults and overrides AI daily guardrails safely", () => {
    expect(parseConfig({}).aiDailyBudgetUsd).toBe(2);
    expect(parseConfig({}).aiDailyCallLimit).toBe(200);
    const cfg = parseConfig({ AI_DAILY_BUDGET_USD: "0.5", AI_DAILY_CALL_LIMIT: "25.9" });
    expect(cfg.aiDailyBudgetUsd).toBe(0.5);
    expect(cfg.aiDailyCallLimit).toBe(25);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "-1", AI_DAILY_CALL_LIMIT: "no" }).aiDailyCallLimit).toBe(200);
    expect(parseConfig({}).sessionSecret).toBeNull();
    expect(parseConfig({ SESSION_SECRET: " x " }).sessionSecret).toBe("x");
    expect(parseConfig({}).storageBucket).toBeNull();
    expect(parseConfig({ FIREBASE_PROJECT_ID: "demo" }).storageBucket).toBe(
      "demo.firebasestorage.app",
    );
    expect(
      parseConfig({ NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: " bkt ", FIREBASE_PROJECT_ID: "demo" })
        .storageBucket,
    ).toBe("bkt");
    expect(parseConfig({ STORAGE_BUCKET: "explicit" }).storageBucket).toBe("explicit");
  });

  it("treats AI_DAILY_BUDGET_USD=0 as off, junk as fallback (PIN-59)", () => {
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "0" }).aiDailyBudgetUsd).toBe(0);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "0.0" }).aiDailyBudgetUsd).toBe(0);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "-1" }).aiDailyBudgetUsd).toBe(2);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "no" }).aiDailyBudgetUsd).toBe(2);
    expect(parseConfig({}).policyOverridesJson).toBeNull();
    expect(parseConfig({ POLICY_OVERRIDES_JSON: " {} " }).policyOverridesJson).toBe("{}");
  });

  it("throws on unknown DATA_BACKEND in production only (PIN-59)", () => {
    expect(parseConfig({ DATA_BACKEND: "bogus" }).dataBackend).toBe("memory");
    expect(() =>
      parseConfig({ DATA_BACKEND: "bogus", NODE_ENV: "production" }),
    ).toThrow(/Unknown DATA_BACKEND/);
    expect(
      parseConfig({ DATA_BACKEND: "firestore", NODE_ENV: "production" }).dataBackend,
    ).toBe("firestore");
  });

  it("honours Meta env overrides and trims a trailing slash", () => {
    const cfg = parseConfig({
      META_API_KEY: " k ",
      META_API_BASE_URL: "https://example.test/v1/",
      META_MODEL_SPARK: "custom",
    });
    expect(cfg.meta.apiKey).toBe("k");
    expect(cfg.meta.baseUrl).toBe("https://example.test/v1");
    expect(cfg.meta.sparkModel).toBe("custom");
  });
});
