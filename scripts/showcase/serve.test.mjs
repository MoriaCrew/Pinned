import { describe, expect, it } from "vitest";
import { LIVE_TIMEOUTS_MS, serveEnv } from "./serve.mjs";

const operatorEnv = {
  PATH: "/bin",
  META_API_KEY: "key-from-the-operators-env-file",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_API_VERSION: "2099-01-01",
  DEMO_BOARD_SLUG: "slug",
  FIRESTORE_EMULATOR_HOST: "localhost:8080",
  DATA_BACKEND: "firestore",
  AI_MOCK: "0",
  AUTH_MODE: "firebase",
  PLUS_MODE: "on",
};

describe("serveEnv", () => {
  it("is a mock server by default, so nothing paid can start by accident", () => {
    const env = serveEnv(operatorEnv);
    expect(env.AI_MOCK).toBe("1");
    expect(env.POLICY_OVERRIDES_JSON).toBeUndefined();
  });

  it("forces the local-only overrides on a live server", () => {
    const env = serveEnv(operatorEnv, { live: true, port: 3100 });
    expect(env).toMatchObject({
      AI_MOCK: "0",
      DATA_BACKEND: "memory",
      AUTH_MODE: "link-only",
      PLUS_MODE: "off",
      APP_BASE_URL: "http://localhost:3100",
      AI_DAILY_BUDGET_USD: "10",
      AI_DAILY_CALL_LIMIT: "2000",
    });
    expect(JSON.parse(env.POLICY_OVERRIDES_JSON)).toEqual({ timeoutsMs: LIVE_TIMEOUTS_MS });
  });

  it("clears Stripe, the demo board and the Firestore emulator, and keeps the rest", () => {
    const env = serveEnv(operatorEnv, { live: true });
    expect(Object.keys(env).filter((k) => /^STRIPE_|DEMO_BOARD_SLUG|FIRESTORE_EMULATOR_HOST/.test(k))).toEqual([]);
    expect(env.META_API_KEY).toBe(operatorEnv.META_API_KEY);
    expect(env.PATH).toBe("/bin");
  });

  it("signs sessions with a throwaway secret unless the environment has one", () => {
    expect(serveEnv({}, { newSecret: () => "throwaway" }).SESSION_SECRET).toBe("throwaway");
    expect(serveEnv({ SESSION_SECRET: "from-the-env-file" }, { newSecret: () => "throwaway" }).SESSION_SECRET).toBe("from-the-env-file");
    const [a, b] = [serveEnv({}).SESSION_SECRET, serveEnv({}).SESSION_SECRET];
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it("leaves the caller's environment alone", () => {
    const before = JSON.stringify(operatorEnv);
    serveEnv(operatorEnv, { live: true });
    expect(JSON.stringify(operatorEnv)).toBe(before);
  });

  it("keeps the other policy overrides and the longer timeouts of the env file", () => {
    const env = serveEnv({ POLICY_OVERRIDES_JSON: JSON.stringify({ scenesPerBoardDay: 1, timeoutsMs: { spark: 200_000, sam: 5_000, voice: 1000 } }) }, { live: true });
    expect(JSON.parse(env.POLICY_OVERRIDES_JSON)).toEqual({
      scenesPerBoardDay: 1,
      timeoutsMs: { spark: 200_000, sam: 60_000, scene: 180_000, voice: 1000 },
    });
  });

  it("refuses overrides that are not JSON", () => {
    expect(() => serveEnv({ POLICY_OVERRIDES_JSON: "{nope" }, { live: true })).toThrow("POLICY_OVERRIDES_JSON is not valid JSON");
  });
});
