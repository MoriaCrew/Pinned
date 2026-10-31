# AI usage attribution (PIN-137)

Every decorated AI call appends one `AiCallLog` (v2) record,
including budget/cap denials (`denied_*` outcomes). Fields:
`boardId` (slug, internal only), `participantId`,
`userIdAtCall` (snapshot at call time, `null` for link-only,
never backfilled), `sceneId`/`photoId`/`jobId` where the caller
knows them, typed `operation`, units (tokens / images /
`audioSeconds`), integer `reservedMicroUsd` + `costMicroUsdEst`,
`attempt`/`attempts`, and `expireAt` (epoch ms,
`Policy.aiCallLogRetentionDays`, default 90 days).

All cost figures are **estimates** from list prices. The
provider dashboard is authoritative.

## Pricing rule

Prices live in `src/gateway/costs.ts` (Meta list prices,
Oct 30):

| Operation | Billing unit | Estimate |
| --- | --- | --- |
| Spark (`nameElements`, `nameOne`, `suggestChips`) | tokens | $1.25 in / $4.25 out per 1M tokens |
| SAM 3.1 (`segment`) | image | $2.50 per 1000 images |
| Muse Image (`composeScene`) | generated image | flat $0.01 |
| Muse Voice (`transcribe`) | audio second | $0.18 per hour |

A scene costs the flat Muse Image price, whatever its token
counts (PIN-180). Before the call the gateway reserves $0.01
against the daily budget (so the $2 default admits 200
scenes). After
it, the `AiCallLog` row is priced at $0.01 per generated image:
`images` on the row is how many images the reply held, so a
reply with no image (a refusal) and a failed call are priced
at $0. Input and output tokens stay on the row for
attribution but never move the price. The scene job's own
`costUsd` is the same $0.01 for an AI scene and $0 for a
collage.

## Collage reason

A scene that comes out as a collage records why, in
`collageReason` on the scene and its job (also in the public
scene and job payloads):

- `budget`: the daily AI budget, call limit or AI switch
  closed the composer (job errors `budget`, `call_limit`,
  `budget_off`). The board shows one line on the print: AI was
  busy, so this one is a collage, and no creation was used. No
  make is debited for a collage.
- `pool_empty`: the board has no makes left (PIN-151). Its
  copy is the makes copy (PIN-152).
- `mock`: offline demo mode (`AI_MOCK=1`). No extra line.

Collages from before this field have no reason and show no line.

A photo job the budget denied (the namer, or the cutter when
no pin landed) ends `failed` with the same `errorCode`
(`budget`, `call_limit` or `budget_off`), and the add sheet
shows the budget line instead of the generic failure.

## Operator report

```sh
npm run usage:costs -- --from 2026-10-01 --to 2026-10-31
npm run usage:costs -- --days 7
```

Service-account (ADC) read of `aiCallLogs`; per-board /
per-participant / per-operation estimated dollars. Board slugs
are printed as a short sha256 hash, never raw.

## Retention / TTL (operator step)

Firestore TTL policies can only be created console-side. Rows
carry `expireAtTs` (a Timestamp mirror of `expireAt`, written by
`FirestoreGameRepository`) so the operator can enable a TTL
policy on `aiCallLogs.expireAtTs` in the Firebase console or via
`gcloud firestore fields ttls update`. Until that policy exists,
rows are retained — code does not fake deletion. The same
console step applies to `starterAllowances.expireAtTs` (PIN-204,
the free-creations-per-maker counters keyed by a hashed client
address or user id, docs/15): with the policy on, a counter goes
when its window ends; without it, counters are kept. Composite
indexes for the rollups live in `firestore.indexes.json`
(board/participant/day, user/day, operation/day); deploy them
with the usual `firebase deploy --only firestore:indexes`.

## Migration

Pre-v2 rows (legacy `gameId`, float `costEstimateUsd`) stay
readable: `normalizeAiCallLog` derives `boardId` and
`costMicroUsdEst` on read. No backfill job; `userIdAtCall` is
never invented for old rows.
