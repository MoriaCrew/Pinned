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
rows are retained — code does not fake deletion. Composite
indexes for the rollups live in `firestore.indexes.json`
(board/participant/day, user/day, operation/day); deploy them
with the usual `firebase deploy --only firestore:indexes`.

## Migration

Pre-v2 rows (legacy `gameId`, float `costEstimateUsd`) stay
readable: `normalizeAiCallLog` derives `boardId` and
`costMicroUsdEst` on read. No backfill job; `userIdAtCall` is
never invented for old rows.
