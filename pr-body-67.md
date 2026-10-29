## Linear

- Issue: PIN-67

## Requirements

- Satisfies: `docs/11-studio.md` sections 5.8 + 6 (Add sheet, TanStack polling, client downscale). Slice 1 demo closer: phone opens board, adds photo, pins pop in, "Pin N"; a second phone sees them next poll.

## What changed

The board's Add button now opens a full Add sheet and board polling moves to TanStack Query.

- `@tanstack/react-query`: board view via `useQuery` (`refetchInterval` = Policy cadence, refetch on focus, `initialData` from SSR); join applies optimistically to the query cache.
- `AddSheet`: pick photo → client downscale (canvas, Policy `uploadMaxPx`/`uploadJpegQuality`; decode failure falls back to the original file, server still re-encodes) → upload → "finding things…" → candidates pop in pre-selected (board poll while the in-request job runs, then the job view polled at Policy `jobPollIntervalMs`) → tap to drop → "Pin N →" with optimistic board pins + rollback on error.
- Face photos: server `job.faceNote` (Policy `faces: note`) shows the one-line consent note once per photo/job, dismissible, never blocks pinning.
- Pure sheet logic in `src/domain/add-sheet.ts` (downscale geometry, pop-in detection, selection, optimistic confirm, face-note-once) with unit tests; Policy gains `jobPollIntervalMs` (1500), `uploadMaxPx` (1600), `uploadJpegQuality` (0.85).
- i18n `add.*` strings (icon + ≤6 words), sheet CSS (≥44px targets, safe-area, reduced-motion inherited).

## Test evidence

- [ ] Bugbot review finished and every finding triaged (fix / follow-up PIN / justified dismissal in-thread): pending CI
- [x] Unit / contract tests: `AI_MOCK=1` — focused `src/domain/add-sheet.test.ts` + policy 12 passed; `npm run typecheck` clean; `npm test` 215 passed + 1 skipped (35 files); `npm run build` ok (`/g/[slug]` 17.7 kB)
- [x] Preview click-through (phone viewport) for UI changes: Chrome CDP 390×844 against local live-AI server — join → Add sheet → photo (`person-desk-mug`) → face note shown, 2 pins pre-selected → Pin 2 → board shows 10 pins, `innerWidth=390 scrollWidth=390`
- [x] Screenshots attached (UI changes): `eval/screenshots/pin-67-sheet-390.png`, `eval/screenshots/pin-67-board-390.png`
- Live hosted-dev run (Checks): 3 synthetic PIN-50 fixtures through the real hosted flow — desk-mug-duck 12.6s/3 pins, person-herb-kitchen 11.0s/2 pins (faceNote=true), kitchen-cat-lamp 16.1s/4 pins; all confirmed, `workingCopyDeleted=true`, 9 pinned on the board. Numbers appended to `eval/studio-findings.md`. Blocker found + fixed: Studio collection-group field indexes were never deployed to dev (hosted uploads 500 FAILED_PRECONDITION); deployed `firestore.indexes.json` to the dev project — prod needs the same before board traffic.

## AI / cost impact

No prompts, models or gateway changes. The live run used the existing `elements.v1` + SAM path: PIN-50 unit estimate $0.020/photo → ~$0.06 for the 3-photo hosted run (target $0.05/photo; 3× stop line $0.15/photo not approached). CI stays `AI_MOCK=1`.

## Safety & privacy

- [x] No secrets, `.env`, or real player photos in this diff (synthetic fixtures only)
- [x] Originals-never-persisted invariant intact — upload path unchanged (server intake strips/re-encodes; client downscale only shrinks bytes in transit)
- [x] Prompt safety rules untouched

## Rollback

Revert this PR. No data migration; the dev Firestore index deploy is additive and can stay.
