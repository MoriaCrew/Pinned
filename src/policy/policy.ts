/**
 * Policy — every Studio limit lives here (docs/11 §5.1, PIN-59).
 * Pure module (client-safe): no env reads, no server imports.
 * Resolution order: code defaults < env layer < per-board overrides.
 * Env access stays in src/config.ts; see src/policy/server.ts.
 */
import { z } from "zod";
import { parseSceneSize } from "../domain/scene-ratio";

const Range = z.object({
  min: z.number().int().min(0),
  max: z.number().int().min(0),
});

/** "WIDTHxHEIGHT" with positive sides (PIN-129): prints take this shape until a scene records its own, so a malformed value fails closed. */
const SceneSize = z
  .string()
  .trim()
  .refine((size) => parseSceneSize(size) !== null, { message: "sceneSize must look like 1024x1536" });

const FractionRange = z.object({
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
});

/** One purchasable makes pack (PIN-147). `lookupKey` is the Stripe price lookup key from the PIN-146 catalog manifest (`src/billing/catalog.ts`); a policy test pins the defaults below to that manifest's live items so the two cannot drift. `eurCents`/`label` are display + offer data — the Stripe price remains the charging truth; a buy stores the pack's `credits` + `eurCents` on its intent (PIN-181), so later price changes never reprice it. */
const CreditPack = z.object({
  lookupKey: z.string().min(1),
  credits: z.number().int().positive(),
  eurCents: z.number().int().positive(),
  label: z.string().min(1),
});

/** PIN-181: one purchase, Board Plus for the board + 20 creations ("creations" is the user-facing word for makes). */
const DEFAULT_CREDIT_PACKS = [
  { lookupKey: "pinneds_plus_20", credits: 20, eurCents: 299, label: "20 creations · €2.99" },
];

export const PolicySchema = z
  .object({
    elementsPerPhoto: Range.default({ min: 1, max: 6 }),
    /** Multi-photo pick (batch upload): most files one pick may queue, and how many of them the client uploads at once (serial by default: each in-request job holds sharp buffers; the App Hosting runConfig concurrency is the second line). */
    photosPerBatch: z.number().int().min(1).default(5),
    batchUploadConcurrency: z.number().int().min(1).default(1),
    /** Client upload retries for transient answers only (code-less 429 brakes, 503, network loss after a job check): attempts per file and the backoff step in ms (delay grows per attempt). Coded stops (pool-empty, per-day) never retry. */
    uploadRetryMaxAttempts: z.number().int().min(1).default(3),
    uploadRetryBackoffMs: z.number().int().min(0).default(2_000),
    /** In-process brake on simultaneously running decompose jobs (memory guard beside the runConfig concurrency; busy answers a code-less 429 the client backs off on). */
    maxConcurrentDecomposeJobs: z.number().int().min(1).default(2),
    /** Stale-job margin past the summed Policy timeouts (AI-only) bound: the runner fails itself at bound + margin before debiting (the margin covers its non-AI render/store/persist tail); only jobs still pending/running past bound + 2 x margin are swept to failed. */
    staleJobMarginMs: z.number().int().min(0).default(60_000),
    /** Minimum SAM confidence for a usable mask when the provider returns one (0 = keep today's behaviour: confidence only orders candidates). */
    samMinConfidence: z.number().min(0).max(1).default(0),
    conceptMaxWords: z.number().int().min(1).default(3),
    pinsPerScene: Range.default({ min: 1, max: 4 }),
    photosPerParticipantPerDay: z.number().int().min(0).default(20),
    /** Segmenter (SAM) caps (PIN-92): every segment invocation — concept, tap-add, retry attempt, failure and refusal alike — reserves against these before the provider call, so failing taps cannot burn the shared daily pool unbounded. Per photo 18 = 3x the 6-element cap (concepts + a retry each + tap misses); per participant 150 covers the legit worst case (20 photos x 6 concepts = 120, + retry/tap headroom) well under the 500 global daily call limit. */
    segmentsPerPhoto: z.number().int().min(0).default(18),
    segmentsPerParticipantPerDay: z.number().int().min(0).default(150),
    /** Tap-name (Spark crop pass) cap (PIN-117): one call per successful tap-add, counted in its own budget counter — never against photosPerParticipantPerDay. 100 covers the legit worst case (20 photos x up to 5 tap-adds) while failing/refusing names still consume the reservation, so a tap-loop cannot burn Spark spend unbounded. */
    tapNamesPerParticipantPerDay: z.number().int().min(0).default(100),
    /** Dictation caps (PIN-119): one Muse Voice file-transcription call per dictation, counted in its own budget counter. 30s of mono 16-bit 16kHz WAV is ~960KB, so the 1MiB byte cap and the seconds cap agree; audio is never persisted. 50/day at <=30s is <=25 audio-minutes (~$0.08 at list) worst case. */
    dictationsPerParticipantPerDay: z.number().int().min(0).default(50),
    dictationMaxSeconds: z.number().positive().default(30),
    dictationMaxBytes: z.number().int().min(1).default(1_048_576),
    scenesPerParticipantPerDay: z.number().int().min(0).default(10),
    scenesPerBoardPerDay: z.number().int().min(0).default(40),
    /** Scene prompt length cap (PIN-69). */
    /** Scene image Cache-Control max-age for chat crawlers (PIN-72). */
    sceneImageCacheMaxAgeSeconds: z.number().int().min(0).default(300),
    /** Strip previews (PIN-133): the WebP the board strip loads; the viewer and share keep the full image. Long side 1024 covers the tallest print (40svh, ~338 CSS px on an 844px phone) at DPR 3. Quality uses sharp's integer 1-100 scale (not uploadJpegQuality's 0.1-1 fraction). */
    scenePreviewMaxPx: z.number().int().positive().default(1024),
    scenePreviewQuality: z.number().int().min(1).max(100).default(80),
    scenePromptMaxChars: z.number().int().min(1).default(500),
    workingCopyTtlHours: z.number().positive().default(24),
    /** Board API caps (PIN-65): join roster, title length, cookie life. */
    participantsPerBoard: z.number().int().min(1).default(50),
    boardTitleMaxChars: z.number().int().min(1).default(80),
    /** Join display-name cap in code points (PIN-196: was a literal 30 in board-session). */
    displayNameMaxChars: z.number().int().min(1).default(30),
    /** Thing label cap in code points (PIN-155): the gateway normalizers and (PIN-156) rename read this one value. */
    elementLabelMaxChars: z.number().int().min(1).default(60),
    /** JSON body cap of the element rename PATCH (PIN-156); read from the env-level Policy before any board read. */
    elementRenameMaxBytes: z.number().int().min(1).default(1024),
    participantCookieDays: z.number().int().min(1).default(30),
    /** Reclaim-PIN brute-force lockout (PIN-90): failed attempts per
     * (board, name) and per (board, IP) counted in the board store
     * (shared across instances); reaching a threshold locks further
     * reclaims for an exponentially growing window. */
    reclaimMaxFailuresPerName: z.number().int().min(1).default(5),
    reclaimMaxFailuresPerIp: z.number().int().min(1).default(20),
    reclaimFailureWindowMs: z.number().int().min(1).default(900_000),
    reclaimLockoutBaseMs: z.number().int().min(0).default(60_000),
    reclaimLockoutMaxMs: z.number().int().min(0).default(3_600_000),
    /** New-join rate budget (PIN-91): fresh roster entries one
     * (board, IP) may mint per fixed window, counted in the board
     * store (shared across instances). Only creations count —
     * updates, reclaims and restores are free — and 20 new people
     * behind one household NAT in an hour stays well inside it
     * (matches the route's long-standing 20-per-10-min join brake,
     * which counts every join POST). */
    joinMaxNewPerIp: z.number().int().min(1).default(20),
    joinNewWindowMs: z.number().int().min(1).default(3_600_000),
    /** Signed-in user cookie life (PIN-83). Retention note: the
     * users/{uid} profile + board index persist until account
     * deletion lands (PIN-57c) — this TTL bounds the cookie only. */
    userSessionDays: z.number().int().min(1).default(30),
    /** Life of the cookie that remembers a language picked by hand (PIN-190, docs/18-i18n.md). */
    localeCookieDays: z.number().int().min(1).default(365),
    /** Sign-in provider pin + freshness (PIN-94): session exchange
     * only accepts these Firebase `sign_in_provider` values, so
     * enabling another provider (e.g. Anonymous) in a console can
     * never mint user sessions by itself. Claim/restore additionally
     * require the token's `auth_time` within authFreshWindowMs
     * (default 1h, the Firebase ID-token lifetime): an old session
     * still reads /api/me, but linking or restoring a board identity
     * needs a recent Google sign-in. */
    authAllowedProviders: z
      .array(z.string().min(1))
      .min(1)
      .default(["google.com"]),
    authFreshWindowMs: z.number().int().min(1).default(3_600_000),
    /** My boards "Remove" per-IP brake (PIN-166, in-process like plus.hostRoutesPerIp). */
    myBoardsRemovePerIp: z
      .object({
        limit: z.number().int().min(1).default(60),
        windowMs: z.number().int().min(1).default(600_000),
      })
      .default({ limit: 60, windowMs: 600_000 }),
    /** Board delete per-IP brake (PIN-167, in-process like plus.hostRoutesPerIp). */
    boardDeletePerIp: z
      .object({
        limit: z.number().int().min(1).default(60),
        windowMs: z.number().int().min(1).default(600_000),
      })
      .default({ limit: 60, windowMs: 600_000 }),
    /**
     * Board Plus (PIN-103, docs/15-board-plus.md). Since PIN-181
     * Plus is sold only inside the credits pack (any joined member
     * can buy it for the board, `credits.plusOnPurchase`); its
     * price lives in `credits.packs`. hostCookieDays is the host
     * credential's life: the server checks it against the stored
     * issue time with the board's effective Policy (so a per-board
     * override does apply there), while the cookie's Max-Age is
     * set once at create from the env-level Policy (browsers cap
     * cookie life at about 400 days regardless). requestMaxBytes
     * caps the JSON body of the host-only routes; hostRoutesPerIp
     * is their in-process per-IP brake.
     */
    plus: z
      .object({
        hostCookieDays: z.number().int().min(1).default(365),
        requestMaxBytes: z.number().int().min(1).default(1024),
        hostRoutesPerIp: z
          .object({
            limit: z.number().int().min(1).default(60),
            windowMs: z.number().int().min(1).default(600_000),
          })
          .default({ limit: 60, windowMs: 600_000 }),
      })
      .default({
        hostCookieDays: 365,
        requestMaxBytes: 1024,
        hostRoutesPerIp: { limit: 60, windowMs: 600_000 },
      }),
    /**
     * Board makes credits (PIN-147, docs/15-board-plus.md). Pure
     * offer + ledger parameters only: nothing here charges or
     * grants by itself (the ledger domain is
     * `src/domain/credit-ledger.ts`; the buy route and webhook
     * read these). `packs` is the one Board Plus purchase since
     * PIN-181 (UI calls makes "creations"). `starterMakes` is the
     * free pool each new board is granted once; paid makes never
     * expire (no TTL knob on purpose). `plusOnPurchase` makes the
     * webhook grant also give the board Plus (PIN-181).
     * `pendingIntentCapPerBoard` bounds concurrent
     * not-yet-paid purchase intents one board may hold, and
     * `intentTtlSeconds` is how long such an intent holds one of
     * those cap slots (30 min, matching a hosted checkout sitting
     * open in a tab). Since PIN-178 it no longer decides whether a
     * paid session grants: only a terminal Stripe event closes the
     * purchase.
     */
    credits: z
      .object({
        /** Kill/enable flag for pool debit (PIN-151): false (default) keeps the credits loop inert in the board flow — no starter grants, no debits, no pool gate, no balance in the board view. Ships disabled; activation is a later operator flip (env/per-board override), never a deploy. */
        enabled: z.boolean().default(false),
        packs: z.array(CreditPack).min(1).default(DEFAULT_CREDIT_PACKS),
        starterMakes: z.number().int().min(0).default(5),
        /** Free creations per maker (PIN-204): only a maker's first `starterBoardsPerMaker` new boards per `starterMakerWindowMs` get the starter pool; later boards start at 0. 0 = no new board gets a pool. A maker is a signed-in user, else the client address (docs/15, "Free creations rule"). */
        starterBoardsPerMaker: z.number().int().min(0).default(3),
        /** Fixed window for starterBoardsPerMaker in ms (default 7 days), anchored at the maker's first counted board. */
        starterMakerWindowMs: z.number().int().min(1).default(604_800_000),
        /** Makes indicator low state (PIN-152): at or under this many makes left the board warns it is running low; 0 disables the low state. */
        lowMakesWarning: z.number().int().min(0).default(2),
        /** PIN-181: a webhook-granted purchase also grants the board Plus (`source: "stripe"`). Off = makes only. */
        plusOnPurchase: z.boolean().default(true),
        pendingIntentCapPerBoard: z.number().int().min(1).default(3),
        intentTtlSeconds: z.number().int().min(1).default(1_800),
        /** Buy-route per-IP brake (PIN-149, in-process like plus.hostRoutesPerIp): bounds checkout-session creation attempts before any Stripe call. */
        checkoutPerIp: z
          .object({
            limit: z.number().int().min(1).default(20),
            windowMs: z.number().int().min(1).default(600_000),
          })
          .default({ limit: 20, windowMs: 600_000 }),
        /** Stripe webhook body cap (PIN-178): a declared content-length above it answers 413 before the body is read. Read from the env-level Policy. */
        webhookMaxBytes: z.number().int().min(1).default(1_048_576),
      })
      .default({
        enabled: false,
        packs: DEFAULT_CREDIT_PACKS,
        starterMakes: 5,
        starterBoardsPerMaker: 3,
        starterMakerWindowMs: 604_800_000,
        lowMakesWarning: 2,
        plusOnPurchase: true,
        pendingIntentCapPerBoard: 3,
        intentTtlSeconds: 1_800,
        checkoutPerIp: { limit: 20, windowMs: 600_000 },
        webhookMaxBytes: 1_048_576,
      }),
    /** One-time "sign in to keep your pins" nudge after the first
     * pinned pin (PIN-84). Only ever renders when sign-in is on. */
    signInNudge: z.boolean().default(true),
    /** My pins library page size: newest elements kept per GET (PIN-85). */
    libraryPageSize: z.number().int().min(1).default(60),
    /** Add sheet "From your other boards" strip: stickers shown before "See all" (PIN-121); 0 hides the strip. */
    libraryStripMax: z.number().int().min(0).default(12),
    /** Activity strip: latest BoardEvent lines shown (PIN-74). */
    activityStripMax: z.number().int().min(0).default(5),
    /** Generated-chips cache: hours a label-set entry stays fresh (PIN-75). */
    chipsCacheTtlHours: z.number().positive().default(24),
    /** Generated suggestion chips kept per label set (PIN-75). */
    chipsMax: z.number().int().min(0).default(4),
    /** Board page poll cadence (docs/11 section 5.8, PIN-66). */
    boardPollIntervalMs: z.number().int().min(250).default(5_000),
    /** Add-sheet job poll cadence while SAM lands (PIN-67). */
    jobPollIntervalMs: z.number().int().min(250).default(1_500),
    /** Client downscale before upload (docs/11 section 5.8, PIN-67). */
    uploadMaxPx: z.number().int().positive().default(1600),
    uploadJpegQuality: z.number().min(0.1).max(1).default(0.85),
    faces: z.enum(["allow", "note", "block"]).default("note"),
    // PIN-50 locks: flattened won T2; portrait verified; store=false ok.
    sceneInputMode: z
      .enum(["flattened", "transparent", "whole"])
      .default("flattened"),
    sceneSize: SceneSize.default("1024x1536"),
    sceneStore: z.boolean().default(false),
    /**
     * SAM `/v1/responses` `store` flag (PIN-213). docs/11 decided
     * `store: false` everywhere, but the SAM call has never sent
     * the field. Undefined (the default) omits it: the wire body is
     * byte-identical to before. `false` sends `store: false`; `true`
     * sends `store: true`. Flip per board (policyOverrides) after one
     * live probe proves SAM accepts the field, then globally via
     * POLICY_OVERRIDES_JSON.
     */
    samStore: z.boolean().optional(),
    timeoutsMs: z
      .object({
        spark: z.number().int().positive().default(30_000),
        sam: z.number().int().positive().default(20_000),
        scene: z.number().int().positive().default(120_000),
        voice: z.number().int().positive().default(60_000),
      })
      .default({ spark: 30_000, sam: 20_000, scene: 120_000, voice: 60_000 }),
    retries: z.number().int().min(0).default(1),
    /** Backoff before the single 429/5xx retry (PIN-61). */
    retryBackoffMs: z.number().int().min(0).default(500),
    samConcurrency: z.number().int().min(1).default(4),
    /** Usable-mask window, share of frame (PIN-50 lock: 0.5%-60%). */
    usableMaskFrameFraction: FractionRange.default({ min: 0.005, max: 0.6 }),
    /** Flattened scene-input bounds (docs/11 section 5.6, PIN-50 spike). */
    flattenedMaxPx: z.number().int().positive().default(1024),
    flattenedPaddingFraction: z.number().min(0).max(1).default(0.08),
    maxTokens: z
      .object({
        // Spike: 1500 starved Spark reasoning; 4000 required.
        sparkElements: z.number().int().positive().default(4000),
        // PIN-75: text-only chips JSON is tiny; 1200 leaves Spark
        // reasoning headroom while the reserve stays under $0.01.
        sparkChips: z.number().int().positive().default(1200),
        // PIN-117: one tiny single-object JSON; same headroom logic
        // as chips — Spark reasoning room, reserve stays under $0.01.
        sparkTapName: z.number().int().positive().default(1200),
      })
      .default({ sparkElements: 4000, sparkChips: 1200, sparkTapName: 1200 }),
    /** 0 means OFF (PIN-59); never a silent fallback. */
    aiCallLogRetentionDays: z.number().int().min(1).default(90),
    dailyBudgetUsd: z.number().min(0).default(5),
    dailyCallLimit: z.number().int().min(0).default(500),
    models: z
      .object({
        spark: z.string().min(1).default("muse-spark-1.3"),
        sam: z.string().min(1).default("sam-3.1"),
        image: z.string().min(1).default("muse-image-1.0"),
        voice: z.string().min(1).default("muse-voice-transcribe-1.0"),
      })
      .default({
        spark: "muse-spark-1.3",
        sam: "sam-3.1",
        image: "muse-image-1.0",
        voice: "muse-voice-transcribe-1.0",
      }),
    promptVersions: z
      .object({
        elements: z.string().min(1).default("elements.v1"),
        scene: z.string().min(1).default("scene.v1"),
        chips: z.string().min(1).default("chips.v1"),
        tapName: z.string().min(1).default("tap-name.v1"),
      })
      .default({ elements: "elements.v1", scene: "scene.v1", chips: "chips.v1", tapName: "tap-name.v1" }),
    /** Fixed suggestion chips: instant fallback while generated chips load or fail (docs/11 Q10, PIN-75). */
    sceneChips: z
      .array(z.string().min(1))
      .default([
        "on a sunny picnic blanket",
        "in a tiny museum",
        "floating in space",
        "at a birthday party",
      ]),
  })
  .superRefine((p, ctx) => {
    if (p.elementsPerPhoto.max < p.elementsPerPhoto.min) {
      ctx.addIssue({
        code: "custom",
        path: ["elementsPerPhoto"],
        message: "elementsPerPhoto.max < min",
      });
    }
    if (p.usableMaskFrameFraction.max < p.usableMaskFrameFraction.min) {
      ctx.addIssue({
        code: "custom",
        path: ["usableMaskFrameFraction"],
        message: "usableMaskFrameFraction.max < min",
      });
    }
    if (p.reclaimLockoutMaxMs < p.reclaimLockoutBaseMs) {
      ctx.addIssue({
        code: "custom",
        path: ["reclaimLockoutMaxMs"],
        message: "reclaimLockoutMaxMs < reclaimLockoutBaseMs",
      });
    }
    if (p.pinsPerScene.max < p.pinsPerScene.min) {
      ctx.addIssue({
        code: "custom",
        path: ["pinsPerScene"],
        message: "pinsPerScene.max < min",
      });
    }
    const packKeys = p.credits.packs.map((pack) => pack.lookupKey);
    if (new Set(packKeys).size !== packKeys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["credits", "packs"],
        message: "credits.packs lookupKey values must be unique",
      });
    }
  });

export type Policy = z.infer<typeof PolicySchema>;

export type PolicyCreditPack = z.infer<typeof CreditPack>;

export const DEFAULT_POLICY: Policy = PolicySchema.parse({});

const RangeOverride = Range.partial();
const FractionRangeOverride = FractionRange.partial();
export const PolicyOverridesSchema = z.object({
  elementsPerPhoto: RangeOverride.optional(),
  photosPerBatch: z.number().int().min(1).optional(),
  batchUploadConcurrency: z.number().int().min(1).optional(),
  uploadRetryMaxAttempts: z.number().int().min(1).optional(),
  uploadRetryBackoffMs: z.number().int().min(0).optional(),
  maxConcurrentDecomposeJobs: z.number().int().min(1).optional(),
  staleJobMarginMs: z.number().int().min(0).optional(),
  samMinConfidence: z.number().min(0).max(1).optional(),
  conceptMaxWords: z.number().int().min(1).optional(),
  pinsPerScene: RangeOverride.optional(),
  photosPerParticipantPerDay: z.number().int().min(0).optional(),
  segmentsPerPhoto: z.number().int().min(0).optional(),
  segmentsPerParticipantPerDay: z.number().int().min(0).optional(),
  tapNamesPerParticipantPerDay: z.number().int().min(0).optional(),
  dictationsPerParticipantPerDay: z.number().int().min(0).optional(),
  dictationMaxSeconds: z.number().positive().optional(),
  dictationMaxBytes: z.number().int().min(1).optional(),
  scenesPerParticipantPerDay: z.number().int().min(0).optional(),
  scenesPerBoardPerDay: z.number().int().min(0).optional(),
  scenePromptMaxChars: z.number().int().min(1).optional(),
  sceneImageCacheMaxAgeSeconds: z.number().int().min(0).optional(),
  scenePreviewMaxPx: z.number().int().positive().optional(),
  scenePreviewQuality: z.number().int().min(1).max(100).optional(),
  workingCopyTtlHours: z.number().positive().optional(),
  participantsPerBoard: z.number().int().min(1).optional(),
  activityStripMax: z.number().int().min(0).optional(),
  chipsCacheTtlHours: z.number().positive().optional(),
  chipsMax: z.number().int().min(0).optional(),
  boardTitleMaxChars: z.number().int().min(1).optional(),
  displayNameMaxChars: z.number().int().min(1).optional(),
  elementLabelMaxChars: z.number().int().min(1).optional(),
  elementRenameMaxBytes: z.number().int().min(1).optional(),
  participantCookieDays: z.number().int().min(1).optional(),
  reclaimMaxFailuresPerName: z.number().int().min(1).optional(),
  reclaimMaxFailuresPerIp: z.number().int().min(1).optional(),
  reclaimFailureWindowMs: z.number().int().min(1).optional(),
  reclaimLockoutBaseMs: z.number().int().min(0).optional(),
  reclaimLockoutMaxMs: z.number().int().min(0).optional(),
  joinMaxNewPerIp: z.number().int().min(1).optional(),
  joinNewWindowMs: z.number().int().min(1).optional(),
  userSessionDays: z.number().int().min(1).optional(),
  localeCookieDays: z.number().int().min(1).optional(),
  authAllowedProviders: z.array(z.string().min(1)).min(1).optional(),
  authFreshWindowMs: z.number().int().min(1).optional(),
  myBoardsRemovePerIp: z
    .object({
      limit: z.number().int().min(1).optional(),
      windowMs: z.number().int().min(1).optional(),
    })
    .optional(),
  boardDeletePerIp: z
    .object({
      limit: z.number().int().min(1).optional(),
      windowMs: z.number().int().min(1).optional(),
    })
    .optional(),
  signInNudge: z.boolean().optional(),
  plus: z
    .object({
      hostCookieDays: z.number().int().min(1).optional(),
      requestMaxBytes: z.number().int().min(1).optional(),
      hostRoutesPerIp: z
        .object({
          limit: z.number().int().min(1).optional(),
          windowMs: z.number().int().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
  credits: z
    .object({
      enabled: z.boolean().optional(),
      packs: z.array(CreditPack).min(1).optional(),
      starterMakes: z.number().int().min(0).optional(),
      starterBoardsPerMaker: z.number().int().min(0).optional(),
      starterMakerWindowMs: z.number().int().min(1).optional(),
      lowMakesWarning: z.number().int().min(0).optional(),
      plusOnPurchase: z.boolean().optional(),
      pendingIntentCapPerBoard: z.number().int().min(1).optional(),
      intentTtlSeconds: z.number().int().min(1).optional(),
      checkoutPerIp: z
        .object({
          limit: z.number().int().min(1).optional(),
          windowMs: z.number().int().min(1).optional(),
        })
        .optional(),
      webhookMaxBytes: z.number().int().min(1).optional(),
    })
    .optional(),
  libraryPageSize: z.number().int().min(1).optional(),
  libraryStripMax: z.number().int().min(0).optional(),
  boardPollIntervalMs: z.number().int().min(250).optional(),
  jobPollIntervalMs: z.number().int().min(250).optional(),
  uploadMaxPx: z.number().int().positive().optional(),
  uploadJpegQuality: z.number().min(0.1).max(1).optional(),
  faces: z.enum(["allow", "note", "block"]).optional(),
  sceneInputMode: z.enum(["flattened", "transparent", "whole"]).optional(),
  sceneSize: SceneSize.optional(),
  sceneStore: z.boolean().optional(),
  samStore: z.boolean().optional(),
  timeoutsMs: z
    .object({
      spark: z.number().int().positive().optional(),
      sam: z.number().int().positive().optional(),
      scene: z.number().int().positive().optional(),
      voice: z.number().int().positive().optional(),
    })
    .optional(),
  retries: z.number().int().min(0).optional(),
  retryBackoffMs: z.number().int().min(0).optional(),
  samConcurrency: z.number().int().min(1).optional(),
  usableMaskFrameFraction: FractionRangeOverride.optional(),
  flattenedMaxPx: z.number().int().positive().optional(),
  flattenedPaddingFraction: z.number().min(0).max(1).optional(),
  maxTokens: z
    .object({
      sparkElements: z.number().int().positive().optional(),
      sparkChips: z.number().int().positive().optional(),
      sparkTapName: z.number().int().positive().optional(),
    })
    .optional(),
  aiCallLogRetentionDays: z.number().int().min(1).optional(),
  dailyBudgetUsd: z.number().min(0).optional(),
  dailyCallLimit: z.number().int().min(0).optional(),
  models: z
    .object({
      spark: z.string().min(1).optional(),
      sam: z.string().min(1).optional(),
      image: z.string().min(1).optional(),
      voice: z.string().min(1).optional(),
    })
    .optional(),
  promptVersions: z
    .object({
      elements: z.string().min(1).optional(),
      scene: z.string().min(1).optional(),
      chips: z.string().min(1).optional(),
      tapName: z.string().min(1).optional(),
    })
    .optional(),
  sceneChips: z.array(z.string().min(1)).optional(),
});

export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and scalars replace. */
function deepMerge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] =
      isPlainObject(v) && isPlainObject(out[k])
        ? deepMerge(out[k] as Record<string, unknown>, v)
        : v;
  }
  return out;
}

/**
 * Resolve a Policy: defaults < envLayer < boardOverrides.
 * Throws (fail closed) on any invalid layer.
 */
export function resolvePolicy(
  envLayer?: PolicyOverrides | null,
  boardOverrides?: PolicyOverrides | null,
): Policy {
  let merged: Record<string, unknown> = {
    ...(DEFAULT_POLICY as unknown as Record<string, unknown>),
  };
  for (const layer of [envLayer, boardOverrides]) {
    if (!layer) continue;
    const parsed = PolicyOverridesSchema.parse(layer);
    merged = deepMerge(merged, parsed as Record<string, unknown>);
  }
  return PolicySchema.parse(merged);
}

/** Parse the POLICY_OVERRIDES_JSON env value. Throws on bad JSON/shape. */
export function parsePolicyOverridesJson(
  raw: string | null | undefined,
): PolicyOverrides | null {
  if (!raw || !raw.trim()) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("POLICY_OVERRIDES_JSON is not valid JSON");
  }
  return PolicyOverridesSchema.parse(json);
}
