import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../policy/policy";
import { parseSceneSize, sceneRatio, validSceneSize } from "./scene-ratio";

const POLICY_SIZE = DEFAULT_POLICY.sceneSize; // "1024x1536"

describe("parseSceneSize (Policy.sceneSize, PIN-129)", () => {
  it("parses the Policy default and rejects junk", () => {
    expect(parseSceneSize("1024x1536")).toEqual({ width: 1024, height: 1536 });
    expect(parseSceneSize(" 1536x1024 ")).toEqual({ width: 1536, height: 1024 });
    expect(parseSceneSize("portrait")).toBeNull();
    expect(parseSceneSize("0x10")).toBeNull();
    expect(parseSceneSize("1024×1536")).toBeNull();
    expect(parseSceneSize("99999999999999999999x10")).toBeNull();
  });
});

describe("sceneRatio (PIN-129)", () => {
  it("uses the scene's stored pixel size", () => {
    expect(sceneRatio({ width: 1280, height: 1920 }, POLICY_SIZE)).toBe("1280 / 1920");
    expect(sceneRatio({ width: 1536, height: 1024 }, POLICY_SIZE)).toBe("1536 / 1024");
  });

  it("falls back to Policy.sceneSize for older scenes and slots with no image", () => {
    expect(sceneRatio(undefined, POLICY_SIZE)).toBe("1024 / 1536");
    expect(sceneRatio(null, POLICY_SIZE)).toBe("1024 / 1536");
    expect(sceneRatio({}, POLICY_SIZE)).toBe("1024 / 1536");
    expect(sceneRatio({ width: 1280 }, POLICY_SIZE)).toBe("1024 / 1536");
    expect(sceneRatio({}, "800x600")).toBe("800 / 600");
  });

  it("treats zero, negative, NaN, fractional and non-number sides as no size", () => {
    for (const bad of [
      { width: 0, height: 1920 },
      { width: 1280, height: 0 },
      { width: -1280, height: 1920 },
      { width: Number.NaN, height: 1920 },
      { width: 1280, height: Number.POSITIVE_INFINITY },
      { width: 1280.5, height: 1920 },
      { width: "1280", height: "1920" },
    ]) {
      expect(validSceneSize(bad)).toBeNull();
      expect(sceneRatio(bad, POLICY_SIZE)).toBe("1024 / 1536");
    }
  });

  it("never invents a ratio: a malformed Policy size (schema-rejected) leaves the frame auto", () => {
    expect(sceneRatio(undefined, "portrait")).toBe("auto");
  });
});
