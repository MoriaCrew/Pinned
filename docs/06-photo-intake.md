# 06 — Photo intake and ephemeral storage (PIN-34)

## Invariants

- Original upload bytes live only in request memory. They are never
  written to Firestore, Cloud Storage, logs, or error messages.
- Only the processed derivative from `src/server/photo-intake.ts`
  may be stored: magic-byte verified (JPEG/PNG/WebP, max 10 MB),
  pixel-budgeted (40 MP), auto-rotated, resized to a 1600 px
  working image, re-encoded to WebP with EXIF/XMP/ICC stripped.
- Clients never access storage directly (deny-all rules). All reads
  and writes go through the server `DerivativeStore` port.

## Layout

- Working images: `tmp/games/{gameId}/players/{playerId}/submissions/{submissionId}/working.webp`
- Everything ephemeral lives under the `tmp/` prefix so one bucket
  lifecycle rule covers it. Longer-lived reveal/poster assets (later
  slices) must use a different prefix with its own policy.

## Lifecycle runbook

Dev bucket `moriacrew-pinned-dev.firebasestorage.app` expires
`tmp/` objects after 14 days (game max 72 h + reveal/derivation
tail). The applied rule lives in
`storage.lifecycle.json` at the repo root.

Apply or re-apply to an environment bucket:

```powershell
gcloud storage buckets update gs://<bucket> --lifecycle-file=storage.lifecycle.json
gcloud storage buckets describe gs://<bucket> --format="json(lifecycle)"
```

Prod: apply the same file to
`moriacrew-pinned-prod.firebasestorage.app` before the PIN-35
promotion, together with the prod `SESSION_SECRET`.

## Access

App Hosting's compute service account
(`firebase-app-hosting-compute@<project>.iam.gserviceaccount.com`)
needs `roles/storage.objectAdmin` on the environment bucket for
server-side derivative writes. Verified/granted per environment;
local development uses the in-memory store unless
`DATA_BACKEND=firestore`.

## Verification

- Unit: `npm test -- src/server/photo-intake.test.ts` proves EXIF
  removal, resizing, and safe rejection of empty/oversize/
  unsupported/truncated inputs.
- Live (opt-in, ADC):
  `PINNED_LIVE_STORAGE_BUCKET=<bucket> PINNED_LIVE_STORAGE_PROJECT=<project> npm test -- src/server/derivative-store.live.test.ts`
