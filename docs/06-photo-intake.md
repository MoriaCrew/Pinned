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

- Working images: `tmp/boards/{boardId}/jobs/{jobId}/working.webp`
  (Studio layout; the pre-pivot `tmp/games/.../submissions/...`
  layout went with the legacy routes in PIN-93.)
- Scenes (persistent, derived, never an original photo):
  `scenes/boards/{boardId}/{sceneId}/scene.{png|jpg|webp}`, the full
  image as composed (viewer, share, link cards, download), and
  `preview.webp` beside it (PIN-133): long side at most
  `Policy.scenePreviewMaxPx`, WebP at `Policy.scenePreviewQuality`
  (sharp's 1-100), served by the scene image route with
  `?size=preview` to the board strip. Scenes stored before PIN-133
  get their preview on its first request. Scene delete and the
  element-delete cascade remove both objects.
- Everything ephemeral lives under the `tmp/` prefix so one bucket
  lifecycle rule covers it. Persistent derived assets (`elements/`,
  `scenes/`) use their own prefixes; nothing persistent goes in `tmp/`.

## Multi-photo batches and idempotent uploads

- A batch is not a new upload shape: the client queues up to
  `Policy.photosPerBatch` picked files and sends each as its own
  single-photo `POST /photos`, serially (`Policy.batchUploadConcurrency`,
  default 1), each with a client-minted `uploadId` form field that
  becomes the DecomposeJob id. Every file goes through the same
  intake above; there is no multipart batch and originals are still
  never written anywhere.
- The deterministic id makes the POST idempotent: the job create is
  the atomic anchor (the `tmp/` working copy is written only after
  it lands), and a replayed POST for an existing own job returns it
  with 200 before caps, credit preflight, intake or any AI call —
  so a lost response can be retried with byte-identical content
  without a second job or a second PIN-151 debit. The client knows
  the job id before the POST returns and polls `GET /jobs/[jobId]`
  during it (404 until intake creates the job).
- Job-store updates are compare-and-set on the expected status:
  blind progress/finish writes can no longer resurrect a terminal
  job. A runner checks its own deadline (the summed Policy
  timeouts + `Policy.staleJobMarginMs`, the margin covering its
  non-AI render/store/persist tail) before the PIN-151 debit and
  fails without debiting past it; a sweep at bound + 2 x margin fails
  still-pending/running jobs as `stale_running` (never debits; a
  debited runner that loses its guarded finish is refunded under
  `refund:photo:{jobId}` — see docs/15).
- `Policy.maxConcurrentDecomposeJobs` caps simultaneously running
  decomposes per instance (busy = a code-less 429 the client backs
  off on; coded `credits_pool_empty` / `photos_per_day` /
  `free_photos_used` (PIN-230) stops stop the queue). The App Hosting `runConfig` concurrency in
  `apphosting.yaml` is the second line.

## Lifecycle runbook

A working copy is deleted in two layers (`docs/11` A6):

1. **The app, first.** `confirmPins` (`src/server/board-api.ts`)
   deletes it when the uploader taps "Pin selected", and an
   opportunistic per-board sweep (`sweepExpiredWorkingCopies`, run on
   the next photo upload to that board; no cron) deletes any copy older than
   `Policy.workingCopyTtlHours`. Tap-add refuses an expired copy
   (`addTapElement`, `src/server/decompose-job.ts`).
2. **The bucket rule, as backstop** for copies the app never got to
   (an abandoned review on a quiet board): `storage.lifecycle.json`
   at the repo root expires `tmp/` objects by age: 1 day after
   PIN-209 (it was 14 days before). Until that rule is applied to a
   bucket, user-facing copy must not promise a hard 24-hour deletion.

Apply or re-apply to an environment bucket:

```powershell
gcloud storage buckets update gs://<bucket> --lifecycle-file=storage.lifecycle.json
gcloud storage buckets describe gs://<bucket> --format="json(lifecycle)"
```

Apply the file to the dev and prod buckets before promoting; the
steps are in `docs/DEPLOY.md`.

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
