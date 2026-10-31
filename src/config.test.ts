import { describe, expect, it } from "vitest";
import { STRIPE_API_VERSION, parseConfig } from "./config";

describe("parseConfig (FR8 fail-closed defaults)", () => {
  it("defaults to link-only auth and mock AI with empty env", () => {
    const cfg = parseConfig({});
    expect(cfg.authMode).toBe("link-only");
    expect(cfg.aiMock).toBe(true);
  });

  it("UI_LOCALES: English only by default; known codes on, unknown dropped (PIN-190)", () => {
    expect(parseConfig({}).uiLocales).toEqual(["en"]);
    expect(parseConfig({ UI_LOCALES: "" }).uiLocales).toEqual(["en"]);
    expect(parseConfig({ UI_LOCALES: "fr,es,xx" }).uiLocales).toEqual(["en", "fr", "es"]);
    expect(parseConfig({ UI_LOCALES: "en,fr,es,pt-BR,de,it,id" }).uiLocales).toHaveLength(7);
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

  it("legal contact email: env only, junk fails closed to null (PIN-26)", () => {
    expect(parseConfig({}).legalContactEmail).toBeNull();
    expect(parseConfig({ LEGAL_CONTACT_EMAIL: " " }).legalContactEmail).toBeNull();
    expect(parseConfig({ LEGAL_CONTACT_EMAIL: " hello@example.org " }).legalContactEmail).toBe("hello@example.org");
    for (const junk of ["not-an-address", "a@b", "a b@example.org", "<a@example.org>", "a@example.org?subject=x"]) {
      expect(parseConfig({ LEGAL_CONTACT_EMAIL: junk }).legalContactEmail, junk).toBeNull();
    }
  });

  it("PLUS_MODE: off by default, mock only on the exact value (PIN-103)", () => {
    expect(parseConfig({}).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "" }).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "off" }).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "MOCK" }).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "stripe" }).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "STRIPE", STRIPE_SECRET_KEY: "rk_test_x" }).plusMode).toBe("off");
    expect(parseConfig({ PLUS_MODE: "mock" }).plusMode).toBe("mock");
  });

  it("PLUS_MODE=stripe requires STRIPE_SECRET_KEY, else fails closed to off (PIN-149)", () => {
    expect(parseConfig({}).stripeSecretKey).toBeNull();
    expect(
      parseConfig({ PLUS_MODE: "stripe", STRIPE_SECRET_KEY: "   " }).plusMode,
    ).toBe("off");
    const cfg = parseConfig({ PLUS_MODE: "stripe", STRIPE_SECRET_KEY: " rk_test_x " });
    expect(cfg.plusMode).toBe("stripe");
    expect(cfg.stripeSecretKey).toBe("rk_test_x");
    expect(cfg.stripeApiVersion).toBe(STRIPE_API_VERSION);
    expect(STRIPE_API_VERSION).toBe("2026-10-28.endive");
    // Webhook signing secret (PIN-150): trimmed passthrough,
    // null when unset/empty, and never enables stripe by itself.
    expect(cfg.stripeWebhookSecret).toBeNull();
    expect(
      parseConfig({ STRIPE_WEBHOOK_SECRET: " whsec_test_x " }).stripeWebhookSecret,
    ).toBe("whsec_test_x");
    expect(parseConfig({ STRIPE_WEBHOOK_SECRET: "  " }).stripeWebhookSecret).toBeNull();
    expect(parseConfig({ STRIPE_WEBHOOK_SECRET: "whsec_test_x" }).plusMode).toBe("off");
    // The key alone never enables billing without the mode.
    expect(parseConfig({ STRIPE_SECRET_KEY: "rk_test_x" }).plusMode).toBe("off");
  });

  it("passes Firebase web config through, empty fails to null (PIN-83)", () => {
    expect(parseConfig({}).firebaseWebApiKey).toBeNull();
    expect(parseConfig({}).firebaseWebAuthDomain).toBeNull();
    expect(
      parseConfig({ NEXT_PUBLIC_FIREBASE_API_KEY: "  " }).firebaseWebApiKey,
    ).toBeNull();
    const cfg = parseConfig({
      NEXT_PUBLIC_FIREBASE_API_KEY: " public-web-key ",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "demo.firebaseapp.com",
    });
    expect(cfg.firebaseWebApiKey).toBe("public-web-key");
    expect(cfg.firebaseWebAuthDomain).toBe("demo.firebaseapp.com");
  });

  describe("same-origin auth domain (PIN-163)", () => {
    const configured = "demo-proj.firebaseapp.com";
    const optionalOn = {
      AUTH_MODE: "optional",
      AUTH_SAME_ORIGIN: "1",
      APP_BASE_URL: "https://app.example.test",
      FIREBASE_PROJECT_ID: "demo-proj",
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: configured,
    };

    it("flag off: today's authDomain, nothing proxied", () => {
      const cfg = parseConfig({ ...optionalOn, AUTH_SAME_ORIGIN: undefined });
      expect(cfg.authSameOrigin).toBe(false);
      expect(cfg.firebaseWebAuthDomain).toBe(configured);
      expect(parseConfig({ ...optionalOn, AUTH_SAME_ORIGIN: "true" }).authSameOrigin).toBe(false);
      expect(parseConfig({}).authSameOrigin).toBe(false);
    });

    it("flag on + optional + https APP_BASE_URL: the app host", () => {
      const cfg = parseConfig(optionalOn);
      expect(cfg.authSameOrigin).toBe(true);
      expect(cfg.firebaseWebAuthDomain).toBe("app.example.test");
      expect(cfg.firebaseProjectId).toBe("demo-proj");
      expect(
        parseConfig({ ...optionalOn, APP_BASE_URL: "https://app.example.test:8443/x" })
          .firebaseWebAuthDomain,
      ).toBe("app.example.test:8443");
    });

    it("flag on + link-only: unchanged, nothing proxied", () => {
      const cfg = parseConfig({ ...optionalOn, AUTH_MODE: "link-only" });
      expect(cfg.authSameOrigin).toBe(false);
      expect(cfg.firebaseWebAuthDomain).toBe(configured);
    });

    it("flag on + non-https, missing or junk APP_BASE_URL: today's value", () => {
      for (const APP_BASE_URL of ["http://app.example.test", "not a url", "", undefined]) {
        expect(
          parseConfig({ ...optionalOn, APP_BASE_URL }).firebaseWebAuthDomain,
          String(APP_BASE_URL),
        ).toBe(configured);
      }
    });

    it("flag on without a valid project id: today's value (no proxy to serve it)", () => {
      expect(
        parseConfig({ ...optionalOn, FIREBASE_PROJECT_ID: "Bad.Id" }).firebaseWebAuthDomain,
      ).toBe(configured);
      expect(
        parseConfig({ ...optionalOn, FIREBASE_PROJECT_ID: undefined }).firebaseWebAuthDomain,
      ).toBe(configured);
    });
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
    expect(parseConfig({}).aiDailyBudgetUsd).toBe(5);
    expect(parseConfig({}).aiDailyCallLimit).toBe(500);
    const cfg = parseConfig({ AI_DAILY_BUDGET_USD: "0.5", AI_DAILY_CALL_LIMIT: "25.9" });
    expect(cfg.aiDailyBudgetUsd).toBe(0.5);
    expect(cfg.aiDailyCallLimit).toBe(25);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "-1", AI_DAILY_CALL_LIMIT: "no" }).aiDailyCallLimit).toBe(500);
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
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "-1" }).aiDailyBudgetUsd).toBe(5);
    expect(parseConfig({ AI_DAILY_BUDGET_USD: "no" }).aiDailyBudgetUsd).toBe(5);
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
