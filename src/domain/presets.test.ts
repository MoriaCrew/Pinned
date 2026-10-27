import { describe, expect, it, vi } from "vitest";
import { InMemoryGameRepository } from "./repository";
import {
  HOST_PRESETS,
  getPreset,
  isPresetId,
  pickPresetChallenge,
  playerColorFor,
  themeForCustomGame,
} from "./presets";
import { mockGateway } from "../gateway/mock-gateway";
import { createGame, parseCreateGameInput } from "../server/create-game";

describe("host presets (PIN-39)", () => {
  it("ships 8 unique, complete, policy-carrying presets", () => {
    expect(HOST_PRESETS).toHaveLength(8);
    expect(new Set(HOST_PRESETS.map((p) => p.id)).size).toBe(8);
    for (const preset of HOST_PRESETS) {
      expect(preset.persona.name.length).toBeGreaterThan(0);
      expect(preset.persona.voiceRules.some((r) => r.includes("never the person"))).toBe(true);
      expect(preset.challenges.length).toBeGreaterThanOrEqual(3);
      expect(preset.theme.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.theme.paper).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.catchline.length).toBeGreaterThan(0);
      expect(isPresetId(preset.id)).toBe(true);
      expect(getPreset(preset.id)).toBe(preset);
    }
    expect(getPreset("nope")).toBeNull();
  });

  it("picks challenges deterministically and colors players stably", () => {
    const preset = HOST_PRESETS[0];
    expect(pickPresetChallenge(preset, "seed-a")).toBe(pickPresetChallenge(preset, "seed-a"));
    expect(preset.challenges).toContain(pickPresetChallenge(preset, "seed-b"));
    expect(playerColorFor("player-1")).toBe(playerColorFor("player-1"));
    expect(playerColorFor("player-1")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(themeForCustomGame("seed").motif).toBe("✨");
  });

  it("preset create needs no brief and never calls the gateway", async () => {
    const generatePersona = vi.fn(async () => {
      throw new Error("must not be called for presets");
    });
    const gateway = { ...mockGateway, generatePersona };
    const parsed = parseCreateGameInput({ presetId: "gran", deadlinePreset: "express" });
    expect(parsed.presetId).toBe("gran");
    expect(parsed.brief).toBeUndefined();

    const result = await createGame(parsed, {
      repository: new InMemoryGameRepository(),
      gateway,
      now: () => 1_800_000_000_000,
      createId: () => "chain-preset",
      createSlug: () => "slug-preset",
      createAdminToken: () => "t".repeat(32),
    });
    expect(generatePersona).not.toHaveBeenCalled();
    expect(result.game.presetId).toBe("gran");
    expect(result.game.persona.name).toBe("Gran Rose");
    expect(result.game.theme?.accent).toBe(getPreset("gran")?.theme.accent);
    expect(getPreset("gran")?.challenges).toContain(result.game.challenge);
    expect(result.game.personaPromptVersion).toBe("preset.v1");
  });

  it("rejects unknown presets and brief-less custom creates", () => {
    expect(() => parseCreateGameInput({ presetId: "wizard", deadlinePreset: "24h" })).toThrow(
      /preset/,
    );
    expect(() => parseCreateGameInput({ deadlinePreset: "24h" })).toThrow(/Describe your host/);
  });
});
