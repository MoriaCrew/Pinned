import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";

describe("parseConfig (FR8 fail-closed defaults)", () => {
  it("defaults to link-only auth and mock AI with empty env", () => {
    const cfg = parseConfig({});
    expect(cfg.authMode).toBe("link-only");
    expect(cfg.aiMock).toBe(true);
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
