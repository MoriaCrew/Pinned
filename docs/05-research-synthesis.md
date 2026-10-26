# Pinned — Deep Research Synthesis (PIN-21)

_Status: Day 1 (Oct 26, 2026) · Method: 6 parallel research streams +
completeness critic + synthesis (Muse workflow) · Decisions locked
before research: Firebase-first · AUTH_MODE link-only default ·
working-lite Stripe · demo-first · EN main, FR stub later._

> **Evidence note (read first):** child structured payloads exceeded the
> inline limit and were retained in workflow storage; this synthesis is
> built from the streams' complete notes + synthesis pass. Claims marked
> **UNVERIFIED** below must be opened in a real browser/docs before they
> appear in submission copy (tracked as source-closure issue). Do not
> quote prices/credits externally until closed.

## Top finding

The naive sum of all streams is **>13 solo-days against 9 remaining**
(freeze Nov 3). The reconciled plan below therefore has a hard cut line:
**~8.5–9 days to the stage-gate without full Stripe/auth builds.**
Working-lite (Stripe packs + Google auth, +1.5–2d lite) is spent only
from M3 slack if the gate passes. Everything else is seam, stub or skip.

## 1. What competitors teach us

- **Genuinely different:** only async-by-default (2h–24h) entry in the
  set (Jackbox/Gartic/Photo Roulette are synchronous; BeReal is 2-minute
  near-sync); zero-install capability link; host generated per group
  from one line + rubric judging + cross-game diary; one intentional
  photo + SAM cut-out + ephemeral original (vs Photo Roulette's whole
  camera roll).
- **Feature-not-product risks:** AI roast of one photo, guess-the-owner,
  photo prompts and poster cards are each copyable in a weekend. Pinned
  is a product only if rematch chains + host memory + scoreboard links
  accumulate — otherwise it is a chat-platform activity feature.
- **Steal:** one-payer/guests-free (Jackbox/Kahoot); post-to-unlock and
  late-counts (BeReal); shareable result artifact; anonymous-first play.
- **Avoid:** realtime, push/daily-random prompts, camera-roll access,
  host-authored content burden, single-loop with no return reason.

## 2. Conceptual model v2 — amendments to docs/01–02

Research requires these changes before PIN-2 scaffolds (apply via PIN-2
ADR + issue amendments; this doc is the record):

1. **Hosting:** replace Postgres/S3/queue with Firebase App Hosting
   (SSR) + Firestore + Cloud Storage + Cloud Tasks/onSchedule. Keep a
   `GameRepo` port + string IDs; accept lock-in explicitly (exit est.
   2–3d data-layer rewrite).
2. **Scores hidden pre-close:** private judgement shows prose only;
   numeric scores reveal at REVEAL. Kills resubmit score-fishing.
3. **Caps that make costs true:** max 2 judges/player (1 + 1 re-judge),
   1 segment + 1 tap-reselect, 1 poster/game. Unlimited resubmit is cut.
4. **One vision call:** fold safety scan into `judgePhoto` (returns
   objectLabel, scores, safetyFlags, altLabel). No separate safety op.
5. **Persona quality:** preview + 1 free reroll + prominent safe
   default; `persona.language` (BCP 47) from the brief.
6. **OG compromise:** pre-close `og:image` = generic branded card;
   poster becomes `og:image` only after CLOSED with opted-in entries.
   Add `noindex`, 30-day TTL, creator revoke/regenerate slug, player
   self-delete.
7. **Close semantics:** 0 entries → CLOSED, no winner, consolation
   line. 1 entry → winner by default, no guessing. Guessing is
   per-guesser non-blocking (timer ends window).
8. **Admin token:** delivered via fragment/post-redirect, hashed,
   rotatable — never query string (history/logs/referrer/OG crawlers).
9. **Trust surfaces:** 13+ self-declaration, privacy/ToS/report pages.
   Stop calling Pinned "family-safe" (13+/COPPA flag, not legal advice).

## 3. Firebase data model (draft for PIN-2 ADR)

- `chains/{chainId}` — creatorUid?, gameCount, diaryTail (capped);
  subcollection `diary/{gameId}` (winner, streaks, jokes; ≤1 KB each).
- `games/{slug}` — slug (128-bit) as doc ID; adminTokenHash, chainId,
  state (DRAFT|OPEN|REVEAL|CLOSED), deadlineAt, guessingClosesAt,
  challenge, embedded immutable persona (incl. language), entryCount
  (transaction), winnerSubmissionId, posterStatus, creatorUid?.
- `games/{slug}/players/{playerId}` — displayName, cookieSecretHash,
  roastLevel, posterOptIn, reclaimPinHash.
- `games/{slug}/submissions/{playerId}` — doc ID enforces one entry;
  cutoutPath, objectLabel, altLabel, scores (hidden until reveal),
  privateJudgement, teaser, safetyFlags, status, hidden, version,
  judgeCount, segmentCount.
- `games/{slug}/guesses/{guesserId}__{submissionPlayerId}`.
- `games/{slug}/posters/main`; top-level `aiCallLogs` (budget by
  dayBucket), `entitlements/{chainId}`, `stripeEvents/{eventId}`.
- Indexes: games(state, deadlineAt), games(chainId, createdAt desc),
  submissions(hidden, total desc, submittedAt), aiCallLogs(dayBucket).
- Firestore rules: deny all client access; everything via SSR/API +
  Admin SDK verifying slug, signed cookie, admin token (creatorUid
  checked identically in optional mode — flag flip needs no migration).
- Jobs: Cloud Tasks `closeGame` at deadline + 5-min onSchedule sweeper;
  judge/segment/poster/diary handlers re-read state transactionally
  (first-writer-wins). Storage private; originals only in `tmp/` with
  1-day lifecycle delete + explicit delete after cut-out; EXIF strip
  and orientation fix in-function.
- Cost/game (8 players, research estimates — verify in PIN-15):
  Firebase <$0.01 (effectively $0 inside free quotas at hackathon
  scale); AI ≈ $0.063 (4p $0.040 / 12p $0.085, +20% retry buffer).
  Hard ceilings: $0.15/game; $5/day global kill-switch to mock lines.

## 4. Auth + Stripe working-lite (gated)

- `link-only` (default, demo/tests): no auth JS/UI; creator = hashed
  admin token; `creatorUid` ignored if present.
- `optional`: **Google only** (Microsoft/Facebook deferred: +0.5–1d
  each plus review risk). Sign-in never required to create. Claim =
  admin token + verified session → set creatorUid if null-or-same,
  else 409. Authz = token OR matching uid. Players never auth (no
  anonymous auth, no custom tokens — own signed HttpOnly cookie).
- Stripe: **test-mode only**, one product — 10-game Host Pack $4.99 —
  custom Functions Checkout + idempotent webhook → entitlements
  credits. No subscriptions, no per-game microcharge, no player-pay.
  Judge demo is never Stripe-gated. Demo line (only after costs are
  measured): 8-player game ≈ 7¢, pack covers AI cost ~7×.
- **Stage-gate (Day 7 EOD / M2 exit):** build Stripe + Google-lite
  only if (i) M1 loop + Judge Demo green on prod, (ii) golden-set
  costs measured, (iii) one real 4+ player playtest done. Otherwise
  ship entitlements + flag only; describe packs as designed-not-live.

## 5. Build / seam / skip verdicts

| Topic | Verdict | Cost |
| --- | --- | --- |
| ICU catalog EN complete, FR {} | Build at scaffold | 0.25d |
| FR translation, per-player host translation | Skip (PIN-23 later) | — |
| 44px targets, 4.5:1 tokens, reduced motion | Build | 0.35d |
| Semantic guessing + live regions, judge altLabel | Build (alt pre-reveal = "Entry N", no leak) | 0.75d |
| Browser speechSynthesis "Hear the host" | Seam (optional) | 0.25d |
| Cloud TTS / Meta voice dependency | Skip MVP (post-MVP pack) | — |
| Google auth (flagged, gated) | Build-lite if gate passes | 0.5–1d |
| Microsoft/Facebook auth | Skip MVP | — |
| Stripe $4.99 10-pack (test-mode, gated) | Build-lite if gate passes | 1–1.5d |
| Subscriptions, per-game charges | Skip | — |

Honesty bounds: "WCAG 2.2 AA targets", never "certified"; "browser
voice", never "AI voice actor".

## 6. Work decomposition (filed/amended in Linear)

Estimates in solo-days. "Parallel" = safe for separate agent lanes
(disjoint files/contracts); core state machine stays serial.

**Core Loop:** domain core + 0/1-entry close 0.75d · create + persona
preview/reroll + nudges 0.75d · join/submit + reclaim PIN + HEIC spike
+ client resize 1d · close/reveal/guess + sweeper 1d · poster +
scoreboard + OG compromise + TTL/revoke/self-delete 0.75d · Judge
Demo + landing 0.5d · rematch/diary 0.5d.

**AI & Vision:** smoke test first, in parallel with scaffold (SAM
point-grammar/mask decode/orientation, token measurement, rate limits)
0.75d · judgePhoto (folded safety + alt + score-hide + validators)
0.75d · segmentObject + fallbacks 1d · roast/injection hardening +
20-case eval 0.5d · golden set + measured costs 0.5d.

**Platform & Monetization:** scaffold/ADR (App Hosting, dev+prod
projects, Blaze alerts, GameRepo port, ICU + a11y tokens) 1d · budget
guard + rate limits + kill-switch 0.5d · entitlements + free caps
(3 games/chain, 12 players) **always build** 0.25d · Stripe test
packs 1–1.5d **gated** · Google-only auth-lite 0.5–1d **gated** ·
privacy/ToS/13+ pages 0.25d · FR stub at scaffold 0.35d.

**Umbrella:** source-closure spike (open rules/ToS/pricing in a real
browser) 0.5–0.75d Days 1–2 · playtests 1d · video/submission 1d.
Total to gate ≈ 8.5–9d; gated lite adds 1.5–2d from M3 slack only.

Feature build-up: M1 (Days 1–5) scaffold → domain → create → submit
(mock AI) → live judge/segment → close/reveal → poster → demo; exit =
unaided 4-player game + Day-5 pivot gate (guessing vs Host Awards).
M2 (5–8) diary, safety/injection eval, cost caps, golden set, reroll,
reclaim. M3 (8–10) real chats, top-5 fixes, gated lite, freeze, video.

## 7. Top risks (kill order)

1. Dead async (no iOS web push) → Express default, milestone nudges,
   <4-player Host-Awards reveal.
2. Score-fishing / "unfair AI" → hidden scores, capped re-judges.
3. Prompt injection (brief, names, photo text, diary) → quoted-data
   prompts, output validators, injection eval set.
4. Cost abuse on credits → per-slug/IP caps, cached demo, kill-switch.
5. Capability-link/OG leaks → §2.6 compromise + TTL/revoke.
6. Children/COPPA → 13+ gate; no "family-safe" claims.
7. Cookie fragility in in-app browsers → reclaim name+PIN; test real
   WhatsApp webview + Safari private mode on a physical iPhone.
8. Blaze bill shock (alerts don't cap) → in-code hard stop; separate
   demo Firebase project.
9. Retention past game 2 (diary recycles jokes; loser callouts punish
   return) → rotate mechanic at Day-5 gate; soften streak copy.
10. Demo-day API latency/quota → cached/AI_MOCK-capable demo; live
    call only for the judge's own photo; recorded video is primary.

**Missed by the original FR set (now tracked):** HEIC uploads,
stock-photo cheating + third-party consent, display-name profanity on
posters, cross-timezone deadlines, analytics/consent decision,
AiCallLog retention/deletion story.

## 8. Unverified — strike from external copy until closed

$150 credit amount/terms as applied to this account, exact Firestore
unit prices/quotas in-project, US Stripe net-of-fees example, any
Meta-side no-retention/no-training claim, partner fallback pricing.
Closure = source-closure issue (real-browser opens, Day 1–2) +
PIN-3 measurements + PIN-15 golden-set token counts. Until then,
demo/submission copy uses ranges and "measured in testing" language.
