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
});
