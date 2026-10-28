# ADR-003: Studio architecture — Policy as data, capability ports, jobs (PIN-49, Oct 28 2026)

_Status: Accepted. Supersedes the game architecture in
`docs/archive/02` (ADR-001 hosting and ADR-002 no-friction stand).
Spec: `docs/11-studio.md` §5._

## Context

Studio replaces the game loop (persona, judging, reveal) with a
pipeline: Spark names elements, SAM cuts them out, Muse Image
composes pins into scenes (`docs/11` §1). The existing gateway grew
game-shaped operations with known review findings: budget checked by
scanning the day's logs, check-then-call races, no timeouts, no
per-IP create limit, `AI_DAILY_BUDGET_USD=0` meaning $2, unvalidated
slugs reaching Firestore paths, and server modules without
`server-only`. Limits (pins per scene, TTLs, caps) would otherwise
be scattered as literals across prompts, validators and UI, each
needing a redeploy to tune. Scenes also need a durable async story:
a compose can take ~30 s and can be refused by the provider.

## Decision

1. **Policy as data.** One typed `Policy` object (Zod schema,
   defaults in code, then env, then per-board overrides) owns every
   count, size, cap, timeout and TTL. Prompts, validators and UI
   read the same object; no hard-coded limits elsewhere. Firebase
   Remote Config is deferred (A3): v1 is defaults + env + board
   overrides.
2. **Capability ports with one decorator chain.** `ElementNamer`,
   `Segmenter` and `SceneComposer` are the only AI surfaces. Each
   has a Meta adapter, a mock adapter and a recorded-fixture
   adapter. Every port call runs: timeout → retry on 429/5xx →
   reserve budget (fail closed, one counter doc per day with
   `FieldValue.increment`) → call → log cost (`AiCallLog`) → fall
   back. `AI_DAILY_BUDGET_USD=0` means off.
3. **Refusal is an outcome.** Provider refusals return a typed
   `refused` outcome with a friendly line, stored on the job/scene.
   Never a 500, never retried as an error.
4. **Jobs, request + poll.** `DecomposeJob`/`SceneJob` documents
   move `pending → running → ready / failed / refused`, idempotent
   by job id with claim-before-call. The request does the work; the
   client polls. No queue in slices 1–2 (A4); add one only if
   retries get complex.
5. **Element/Pin split.** An `Element` is an owned asset
   (`ownerId`, label, cut-out + flattened refs, `faceFlag`); a `Pin`
   places it on a `Board`. `Scene` credits `elementIds` and records
   `promptVersion` and `costUsd`. Deleting an element removes its
   pins and hides the scenes that used it.
6. **Stateless remix.** Remix attaches the parent scene image as an
   `input_image` plus new elements and the instruction.
   `previous_response_id` is only a same-session shortcut; calls
   default to `store: false` (`docs/11` §9 Q1).
7. **Slug validation.** Every `/g/{slug}` route rejects slugs not
   matching `^[A-Za-z0-9_-]{22}$` (128-bit base64url) before any
   Firestore path is built.

## Consequences

- Tuning a limit is a config change, not a code edit; per-board
  caps keep one board from spending the shared daily budget
  (`docs/11` A2).
- The decorator chain closes the listed review findings in one
  place (PIN-51) instead of per-call-site patches.
- Board pages poll job status; no queue infrastructure to operate
  until evidence demands it (A4).
- Elements outlive boards, so a future user library (PIN-57) needs
  no migration: `ownerId` is present from day one.
- Privacy copy is narrowed: originals are never stored, but no
  "zero data retention" claim survives `store` semantics
  (`docs/11` §4).
- Cost: one extra counter write per AI call and a claim write per
  job. Accepted at hackathon scale.
