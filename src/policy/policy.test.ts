import { describe, expect, it } from "vitest";
import { CATALOG_ITEMS } from "../billing/catalog";
import {
  DEFAULT_POLICY,
  parsePolicyOverridesJson,
  resolvePolicy,
} from "./policy";

describe("Policy (PIN-59, docs/11 §5.1)", () => {
  it("defaults carry the PIN-50 locks", () => {
    expect(DEFAULT_POLICY.sceneInputMode).toBe("flattened");
    expect(DEFAULT_POLICY.sceneSize).toBe("1024x1536");
    // PIN-129: prints fall back to this shape, so a malformed size fails closed.
    expect(resolvePolicy(null, { sceneSize: " 1536x1024 " }).sceneSize).toBe("1536x1024");
    for (const bad of ["portrait", "0x1536", "1024×1536", "auto"]) {
      expect(() => resolvePolicy({ sceneSize: bad })).toThrow();
      expect(() => resolvePolicy(null, { sceneSize: bad })).toThrow();
    }
    expect(DEFAULT_POLICY.sceneStore).toBe(false);
    expect(DEFAULT_POLICY.timeoutsMs).toEqual({
      spark: 30_000,
      sam: 20_000,
      scene: 120_000,
      voice: 60_000,
    });
    expect(DEFAULT_POLICY.maxTokens.sparkElements).toBe(4000);
    expect(DEFAULT_POLICY.faces).toBe("note");
    expect(DEFAULT_POLICY.retries).toBe(1);
    expect(DEFAULT_POLICY.retryBackoffMs).toBe(500);
    expect(resolvePolicy({ retryBackoffMs: 0 }).retryBackoffMs).toBe(0);
    expect(DEFAULT_POLICY.elementsPerPhoto).toEqual({ min: 1, max: 6 });
    // Batch upload + decompose braking defaults (all Policy-owned).
    expect(DEFAULT_POLICY.photosPerBatch).toBe(5);
    expect(DEFAULT_POLICY.batchUploadConcurrency).toBe(1);
    expect(DEFAULT_POLICY.uploadRetryMaxAttempts).toBe(3);
    expect(DEFAULT_POLICY.maxConcurrentDecomposeJobs).toBe(2);
    expect(DEFAULT_POLICY.samMinConfidence).toBe(0);
    expect(DEFAULT_POLICY.dailyBudgetUsd).toBe(5);
    expect(DEFAULT_POLICY.dailyCallLimit).toBe(500);
    expect(DEFAULT_POLICY.pinsPerScene).toEqual({ min: 1, max: 4 });
    expect(DEFAULT_POLICY.boardPollIntervalMs).toBe(5_000);
    expect(DEFAULT_POLICY.activityStripMax).toBe(5);
    // PIN-121 Add sheet strip cap; 0 turns the strip off, negatives fail closed.
    expect(DEFAULT_POLICY.libraryStripMax).toBe(12);
    expect(resolvePolicy({ libraryStripMax: 0 }).libraryStripMax).toBe(0);
    expect(resolvePolicy(null, { libraryStripMax: 6 }).libraryStripMax).toBe(6);
    expect(() => resolvePolicy({ libraryStripMax: -1 })).toThrow();
    // PIN-155 thing label cap: env and board layers override; 0 or a fraction fails closed.
    expect(DEFAULT_POLICY.elementLabelMaxChars).toBe(60);
    expect(resolvePolicy({ elementLabelMaxChars: 40 }).elementLabelMaxChars).toBe(40);
    expect(resolvePolicy({ elementLabelMaxChars: 40 }, { elementLabelMaxChars: 24 }).elementLabelMaxChars).toBe(24);
    for (const bad of [0, -1, 2.5]) {
      expect(() => resolvePolicy({ elementLabelMaxChars: bad })).toThrow();
      expect(() => resolvePolicy(null, { elementLabelMaxChars: bad })).toThrow();
    }
    // PIN-156 rename body cap: same layering, fails closed below 1 byte.
    expect(DEFAULT_POLICY.elementRenameMaxBytes).toBe(1024);
    expect(resolvePolicy({ elementRenameMaxBytes: 512 }).elementRenameMaxBytes).toBe(512);
    expect(resolvePolicy(null, { elementRenameMaxBytes: 256 }).elementRenameMaxBytes).toBe(256);
    for (const bad of [0, 1.5]) expect(() => resolvePolicy({ elementRenameMaxBytes: bad })).toThrow();
    // PIN-75 generated chips: TTL/cap/token budget/prompt version.
    expect(DEFAULT_POLICY.chipsCacheTtlHours).toBe(24);
    expect(DEFAULT_POLICY.chipsMax).toBe(4);
    expect(DEFAULT_POLICY.maxTokens.sparkChips).toBe(1200);
    expect(DEFAULT_POLICY.promptVersions.chips).toBe("chips.v2");
    // PIN-214 fixed idea chips: Policy keeps the count, the text is i18n.
    expect(DEFAULT_POLICY.sceneChipsCount).toBe(4);
    expect(DEFAULT_POLICY).not.toHaveProperty("sceneChips");
    expect(resolvePolicy(null, { sceneChipsCount: 2 }).sceneChipsCount).toBe(2);
    expect(resolvePolicy({ sceneChipsCount: 0 }).sceneChipsCount).toBe(0);
    for (const bad of [-1, 1.5]) expect(() => resolvePolicy({ sceneChipsCount: bad })).toThrow();
    // PIN-117 tap-name crop pass: own counter, token budget, prompt.
    expect(DEFAULT_POLICY.tapNamesPerParticipantPerDay).toBe(100);
    expect(DEFAULT_POLICY.maxTokens.sparkTapName).toBe(1200);
    expect(DEFAULT_POLICY.promptVersions.tapName).toBe("tap-name.v1");
    expect(resolvePolicy({ tapNamesPerParticipantPerDay: 3 }).tapNamesPerParticipantPerDay).toBe(3);
    // PIN-119 dictation: own counter, clip caps, voice model + timeout.
    expect(DEFAULT_POLICY.dictationsPerParticipantPerDay).toBe(50);
    expect(DEFAULT_POLICY.dictationMaxSeconds).toBe(30);
    expect(DEFAULT_POLICY.dictationMaxBytes).toBe(1_048_576);
    expect(DEFAULT_POLICY.models.voice).toBe("muse-voice-transcribe-1.0");
    expect(DEFAULT_POLICY.timeoutsMs.voice).toBe(60_000);
    expect(resolvePolicy({ dictationsPerParticipantPerDay: 0 }).dictationsPerParticipantPerDay).toBe(0);
    expect(resolvePolicy({ dictationMaxSeconds: 10 }).dictationMaxSeconds).toBe(10);
    expect(resolvePolicy({ models: { voice: "other-voice" } }).models.voice).toBe("other-voice");
    expect(() => resolvePolicy({ dictationMaxSeconds: 0 })).toThrow();
    // PIN-83 signed-in user cookie life.
    expect(DEFAULT_POLICY.userSessionDays).toBe(30);
    // PIN-94 provider pin + claim/restore freshness window.
    expect(DEFAULT_POLICY.authAllowedProviders).toEqual(["google.com"]);
    expect(DEFAULT_POLICY.authFreshWindowMs).toBe(3_600_000);
    expect(resolvePolicy({ authFreshWindowMs: 60_000 }).authFreshWindowMs).toBe(60_000);
    expect(
      resolvePolicy({ authAllowedProviders: ["google.com", "apple.com"] })
        .authAllowedProviders,
    ).toEqual(["google.com", "apple.com"]);
    expect(() => resolvePolicy({ authAllowedProviders: [] })).toThrow();
    expect(() => resolvePolicy({ authFreshWindowMs: 0 })).toThrow();
    // PIN-166 My boards "Remove" brake: deep-overridable, fails closed.
    expect(DEFAULT_POLICY.myBoardsRemovePerIp).toEqual({ limit: 60, windowMs: 600_000 });
    expect(
      resolvePolicy({ myBoardsRemovePerIp: { limit: 5 } }).myBoardsRemovePerIp,
    ).toEqual({ limit: 5, windowMs: 600_000 });
    expect(() => resolvePolicy({ myBoardsRemovePerIp: { limit: 0 } })).toThrow();
    // PIN-167 board delete brake: same shape, same fail-closed floor.
    expect(DEFAULT_POLICY.boardDeletePerIp).toEqual({ limit: 60, windowMs: 600_000 });
    expect(resolvePolicy({ boardDeletePerIp: { limit: 5 } }).boardDeletePerIp).toEqual({ limit: 5, windowMs: 600_000 });
    expect(() => resolvePolicy({ boardDeletePerIp: { windowMs: 0 } })).toThrow();
    // PIN-205: the board-create brake moved here from RATE_LIMITS, same values.
    expect(DEFAULT_POLICY.boardCreatePerIp).toEqual({ limit: 10, windowMs: 3_600_000 });
    expect(resolvePolicy({ boardCreatePerIp: { limit: 50 } }).boardCreatePerIp).toEqual({ limit: 50, windowMs: 3_600_000 });
    expect(() => resolvePolicy({ boardCreatePerIp: { limit: 0 } })).toThrow();
    // PIN-212 HSTS life: a year by default, the env layer can change it, 0 fails closed.
    expect(DEFAULT_POLICY.hstsMaxAgeDays).toBe(365);
    expect(resolvePolicy({ hstsMaxAgeDays: 30 }).hstsMaxAgeDays).toBe(30);
    expect(() => resolvePolicy({ hstsMaxAgeDays: 0 })).toThrow();
    expect(resolvePolicy({ userSessionDays: 7 }).userSessionDays).toBe(7);
    expect(() => resolvePolicy({ userSessionDays: 0 })).toThrow();
    expect(resolvePolicy({ chipsMax: 2, chipsCacheTtlHours: 1 }).chipsMax).toBe(2);
    expect(resolvePolicy({ maxTokens: { sparkChips: 800 } }).maxTokens).toEqual({
      sparkElements: 4000,
      sparkChips: 800,
      sparkTapName: 1200,
    });
    expect(resolvePolicy({ boardPollIntervalMs: 1_000 }).boardPollIntervalMs).toBe(1_000);
    // PIN-90 reclaim-PIN lockout thresholds.
    expect(DEFAULT_POLICY.reclaimMaxFailuresPerName).toBe(5);
    expect(DEFAULT_POLICY.reclaimMaxFailuresPerIp).toBe(20);
    expect(DEFAULT_POLICY.reclaimFailureWindowMs).toBe(900_000);
    expect(DEFAULT_POLICY.reclaimLockoutBaseMs).toBe(60_000);
    expect(DEFAULT_POLICY.reclaimLockoutMaxMs).toBe(3_600_000);
    expect(resolvePolicy({ reclaimMaxFailuresPerName: 2 }).reclaimMaxFailuresPerName).toBe(2);
    expect(() => resolvePolicy({ reclaimMaxFailuresPerName: 0 })).toThrow();
    expect(() =>
      resolvePolicy({ reclaimLockoutBaseMs: 2_000, reclaimLockoutMaxMs: 1_000 }),
    ).toThrow();
    expect(() => resolvePolicy({ boardPollIntervalMs: 10 })).toThrow();
    // PIN-50 usable-mask window + flattened bounds (PIN-64).
    expect(DEFAULT_POLICY.usableMaskFrameFraction).toEqual({ min: 0.005, max: 0.6 });
    expect(DEFAULT_POLICY.flattenedMaxPx).toBe(1024);
    expect(DEFAULT_POLICY.flattenedPaddingFraction).toBe(0.08);
    expect(
      resolvePolicy({ usableMaskFrameFraction: { max: 0.5 } }).usableMaskFrameFraction,
    ).toEqual({ min: 0.005, max: 0.5 });
    expect(() =>
      resolvePolicy({ usableMaskFrameFraction: { min: 0.7, max: 0.6 } }),
    ).toThrow();
  });

  it("samStore (PIN-213): default omits the field; env and board layers flip it; bad types fail closed", () => {
    // Default = today's wire format: the key is absent, not false.
    expect(DEFAULT_POLICY.samStore).toBeUndefined();
    expect(resolvePolicy(null).samStore).toBeUndefined();
    expect(resolvePolicy(null, {}).samStore).toBeUndefined();
    // Env layer (POLICY_OVERRIDES_JSON) sets it globally.
    const env = parsePolicyOverridesJson('{"samStore": false}');
    expect(resolvePolicy(env).samStore).toBe(false);
    // Per-board override works with no env layer (the dev probe path)...
    expect(resolvePolicy(null, { samStore: false }).samStore).toBe(false);
    // ...and beats the env layer in both directions.
    expect(resolvePolicy({ samStore: false }, { samStore: true }).samStore).toBe(true);
    expect(resolvePolicy({ samStore: true }, { samStore: false }).samStore).toBe(false);
    // A board override that omits the key leaves the env value alone.
    expect(resolvePolicy({ samStore: false }, { faces: "allow" }).samStore).toBe(false);
    // It is independent of the scene flag.
    expect(resolvePolicy(null, { samStore: false }).sceneStore).toBe(false);
    for (const bad of ["false", 0, null]) {
      expect(() => resolvePolicy({ samStore: bad as never })).toThrow();
      expect(() => resolvePolicy(null, { samStore: bad as never })).toThrow();
    }
  });

  it("merge order is defaults < env < board, deep for nested", () => {
    const p = resolvePolicy(
      { elementsPerPhoto: { max: 4 }, timeoutsMs: { sam: 9_000 } },
      { elementsPerPhoto: { max: 2 } },
    );
    expect(p.elementsPerPhoto).toEqual({ min: 1, max: 2 });
    expect(p.timeoutsMs.sam).toBe(9_000);
    expect(p.timeoutsMs.spark).toBe(30_000);
  });

  it("plus: host cookie life, deep-overridable; no price labels (PIN-103, PIN-182)", () => {
    expect(DEFAULT_POLICY.plus).toEqual({
      hostCookieDays: 365,
      requestMaxBytes: 1024,
      hostRoutesPerIp: { limit: 60, windowMs: 600_000 },
    });
    const p = resolvePolicy(
      { plus: { hostRoutesPerIp: { limit: 5 } } },
      { plus: { hostCookieDays: 90 } },
    );
    expect(p.plus).toEqual({
      hostCookieDays: 90,
      requestMaxBytes: 1024,
      hostRoutesPerIp: { limit: 5, windowMs: 600_000 },
    });
    expect(() => resolvePolicy({ plus: { hostCookieDays: 0 } })).toThrow();
    expect(() => resolvePolicy({ plus: { requestMaxBytes: 0 } })).toThrow();
    expect(() => resolvePolicy({ plus: { hostRoutesPerIp: { limit: 0 } } })).toThrow();
    // An override saved before PIN-182 still parses; the retired key is dropped.
    const legacy = parsePolicyOverridesJson('{"plus":{"priceLabels":{"board":"$1"},"hostCookieDays":7}}');
    expect(legacy).toEqual({ plus: { hostCookieDays: 7 } });
    expect(resolvePolicy(legacy).plus).not.toHaveProperty("priceLabels");
  });

  it("scene preview size and WebP quality (PIN-133): defaults, env/board overrides, fail closed", () => {
    expect(DEFAULT_POLICY.scenePreviewMaxPx).toBe(1024);
    expect(DEFAULT_POLICY.scenePreviewQuality).toBe(80);
    const env = parsePolicyOverridesJson('{"scenePreviewMaxPx": 960, "scenePreviewQuality": 70}');
    const p = resolvePolicy(env, { scenePreviewQuality: 90 });
    expect([p.scenePreviewMaxPx, p.scenePreviewQuality]).toEqual([960, 90]);
    // Quality is sharp's integer 1-100 scale, never a 0.1-1 fraction.
    for (const bad of [{ scenePreviewMaxPx: 0 }, { scenePreviewMaxPx: 512.5 }, { scenePreviewQuality: 0 }, { scenePreviewQuality: 101 }, { scenePreviewQuality: 0.8 }]) {
      expect(() => resolvePolicy(bad)).toThrow();
      expect(() => resolvePolicy(null, bad)).toThrow();
    }
  });

  it("cut-out cache max-age (PIN-217): one-day default, env/board overrides, fail closed", () => {
    expect(DEFAULT_POLICY.elementImageCacheSeconds).toBe(86_400);
    const env = parsePolicyOverridesJson('{"elementImageCacheSeconds": 3600}');
    expect(resolvePolicy(env).elementImageCacheSeconds).toBe(3_600);
    expect(resolvePolicy(env, { elementImageCacheSeconds: 0 }).elementImageCacheSeconds).toBe(0);
    for (const bad of [{ elementImageCacheSeconds: -1 }, { elementImageCacheSeconds: 60.5 }]) {
      expect(() => resolvePolicy(bad)).toThrow();
      expect(() => resolvePolicy(null, bad)).toThrow();
    }
  });

  it("credits: packs mirror the PIN-146 catalog, starter/intent defaults, deep-overridable (PIN-147)", () => {
    expect(DEFAULT_POLICY.credits).toEqual({
      enabled: false,
      // PIN-181: exactly one purchase, Board Plus + 20 creations.
      packs: [
        { lookupKey: "pinneds_plus_20", credits: 20, eurCents: 299, label: "20 creations · €2.99" },
      ],
      starterMakes: 5,
      // PIN-229: a creation is an AI scene; photos use no make.
      photosUseMakes: false,
      starterBoardsPerMaker: 3,
      starterMakerWindowMs: 604_800_000,
      lowMakesWarning: 2,
      plusOnPurchase: true,
      pendingIntentCapPerBoard: 3,
      intentTtlSeconds: 1_800,
      checkoutPerIp: { limit: 20, windowMs: 600_000 },
      webhookMaxBytes: 1_048_576,
    });
    // Parity with the catalog manifest: Policy can never offer a pack Stripe does not sell.
    const catalogPacks = CATALOG_ITEMS.filter(
      (item) => item.status === "live" && item.credits !== undefined,
    ).map((item) => ({
      lookupKey: item.lookupKey,
      credits: item.credits,
      eurCents: item.unitAmount,
    }));
    expect(
      DEFAULT_POLICY.credits.packs.map(({ lookupKey, credits, eurCents }) => ({
        lookupKey,
        credits,
        eurCents,
      })),
    ).toEqual(catalogPacks);
    // PIN-181 plusOnPurchase: on by default, both layers can turn it off, kept by the overrides parser.
    expect(resolvePolicy({ credits: { plusOnPurchase: false } }).credits.plusOnPurchase).toBe(false);
    expect(
      resolvePolicy({ credits: { plusOnPurchase: false } }, { credits: { plusOnPurchase: true } }).credits
        .plusOnPurchase,
    ).toBe(true);
    expect(parsePolicyOverridesJson('{"credits":{"plusOnPurchase":false}}')).toEqual({
      credits: { plusOnPurchase: false },
    });
    expect(() => resolvePolicy({ credits: { plusOnPurchase: "yes" } } as never)).toThrow();
    const p = resolvePolicy(
      { credits: { starterMakes: 8, intentTtlSeconds: 900 } },
      { credits: { pendingIntentCapPerBoard: 1 } },
    );
    expect([p.credits.starterMakes, p.credits.intentTtlSeconds, p.credits.pendingIntentCapPerBoard]).toEqual([8, 900, 1]);
    expect(p.credits.packs).toEqual(DEFAULT_POLICY.credits.packs);
    expect(resolvePolicy({ credits: { starterMakes: 0 } }).credits.starterMakes).toBe(0);
    // PIN-229: a creation is an AI scene by default; photos use a make only when switched on.
    expect(DEFAULT_POLICY.credits.photosUseMakes).toBe(false);
    expect(resolvePolicy(null, { credits: { photosUseMakes: true } }).credits.photosUseMakes).toBe(true);
    expect(parsePolicyOverridesJson('{"credits":{"photosUseMakes":true}}')).toEqual({
      credits: { photosUseMakes: true },
    });
    expect(() => resolvePolicy({ credits: { photosUseMakes: 1 } } as never)).toThrow();
    // PIN-204 free creations per maker: deep-overridable, 0 boards allowed, window at least 1 ms.
    expect(
      resolvePolicy({ credits: { starterBoardsPerMaker: 10 } }, { credits: { starterMakerWindowMs: 60_000 } })
        .credits,
    ).toMatchObject({ starterBoardsPerMaker: 10, starterMakerWindowMs: 60_000 });
    expect(resolvePolicy({ credits: { starterBoardsPerMaker: 0 } }).credits.starterBoardsPerMaker).toBe(0);
    expect(parsePolicyOverridesJson('{"credits":{"starterBoardsPerMaker":5}}')).toEqual({
      credits: { starterBoardsPerMaker: 5 },
    });
    // PIN-152 low-makes threshold: deep-overridable like the rest, 0 disables it.
    expect(resolvePolicy({ credits: { lowMakesWarning: 4 } }).credits.lowMakesWarning).toBe(4);
    expect(resolvePolicy(null, { credits: { lowMakesWarning: 0 } }).credits.lowMakesWarning).toBe(0);
    expect(parsePolicyOverridesJson('{"credits":{"lowMakesWarning":3}}')).toEqual({
      credits: { lowMakesWarning: 3 },
    });
    // PIN-151 kill flag: env and per-board layers both flip it, board wins.
    expect(resolvePolicy({ credits: { enabled: true } }).credits.enabled).toBe(true);
    expect(resolvePolicy(null, { credits: { enabled: true } }).credits.enabled).toBe(true);
    expect(
      resolvePolicy({ credits: { enabled: true } }, { credits: { enabled: false } }).credits.enabled,
    ).toBe(false);
    expect(parsePolicyOverridesJson('{"credits":{"enabled":true}}')).toEqual({
      credits: { enabled: true },
    });
    const pack = DEFAULT_POLICY.credits.packs[0];
    expect(
      resolvePolicy({ credits: { packs: [{ ...pack, label: "Starter pack" }] } }).credits.packs,
    ).toEqual([{ ...pack, label: "Starter pack" }]);
    for (const bad of [
      { credits: { starterMakes: -1 } },
      { credits: { lowMakesWarning: -1 } },
      { credits: { starterBoardsPerMaker: -1 } },
      { credits: { starterBoardsPerMaker: 1.5 } },
      { credits: { starterMakerWindowMs: 0 } },
      { credits: { pendingIntentCapPerBoard: 0 } },
      { credits: { intentTtlSeconds: 0 } },
      { credits: { packs: [] } },
      { credits: { packs: [{ ...pack, credits: 0 }] } },
      { credits: { packs: [{ ...pack, eurCents: -1 }] } },
      { credits: { packs: [{ ...pack, label: "" }] } },
      { credits: { packs: [pack, { ...pack, credits: 60 }] } },
    ]) {
      expect(() => resolvePolicy(bad)).toThrow();
      expect(() => resolvePolicy(null, bad)).toThrow();
    }
    expect(
      resolvePolicy({ credits: { checkoutPerIp: { limit: 2 } } }).credits.checkoutPerIp,
    ).toEqual({ limit: 2, windowMs: 600_000 });
    expect(() => resolvePolicy({ credits: { checkoutPerIp: { limit: 0 } } })).toThrow();
    expect(parsePolicyOverridesJson('{"credits":{"starterMakes":10}}')).toEqual({
      credits: { starterMakes: 10 },
    });
  });

  it("dailyBudgetUsd 0 means off and survives resolution", () => {
    expect(resolvePolicy({ dailyBudgetUsd: 0 }).dailyBudgetUsd).toBe(0);
  });

  it("rejects inverted ranges and unknown faces mode", () => {
    expect(() =>
      resolvePolicy({ elementsPerPhoto: { min: 5, max: 2 } }),
    ).toThrow();
    expect(() =>
      // @ts-expect-error invalid enum on purpose
      resolvePolicy({ faces: "sometimes" }),
    ).toThrow();
  });

  it("parses POLICY_OVERRIDES_JSON and fails closed on garbage", () => {
    expect(parsePolicyOverridesJson(null)).toBeNull();
    expect(parsePolicyOverridesJson(" ")).toBeNull();
    expect(
      parsePolicyOverridesJson('{"scenesPerBoardPerDay": 5}'),
    ).toEqual({ scenesPerBoardPerDay: 5 });
    expect(() => parsePolicyOverridesJson("{nope")).toThrow(/not valid JSON/);
    expect(() => parsePolicyOverridesJson('{"faces": "x"}')).toThrow();
  });
});
