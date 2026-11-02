# 20 — Abuse reports and illegal content (PIN-239)

One page for the human on duty. Scope: a report that a board holds
illegal or abusive content — above all CSAM (child sexual abuse
material). These are operational controls, not legal advice; when
in doubt, quarantine first and ask qualified counsel after.

**Order:** find → note → hold storage → tombstone → copies →
report → close. Never open the board, never view, download or
forward the images. Use your own logins (Firebase console, `gcloud
auth login`, ADC); no service-account keys. Nothing below reads image
bytes. `<project>` is the project the lookup found the board in;
`<bucket>` is that project's bucket (`docs/DEPLOY.md` §6.2).

## 0. Who and when (fill in before launch)

| | |
| --- | --- |
| On duty | `<name>` (backup `<name>`) |
| Inbox `LEGAL_CONTACT_EMAIL` checked | every `<N>` h during launch and judging week, `<cadence>` after |
| Quarantine target | within `<N>` h of **receipt** (the mail's arrival time) |
| "Confirmed" means | `<e.g. reference matched to a board, and the report text plus metadata plausibly show a Terms or legal breach>` |

The Terms promise removal within `Policy.takedownHours` (24 h by
default) of **confirming** a report (`/terms#report`). That clock
starts at confirmation, so the row above must bound receipt →
confirmation, or the promise is open-ended. Anything that may be CSAM
is quarantined on receipt, before confirmation. Note all three times.

## Where reports land

- "Report this board" at the foot of every board page mails
  `LEGAL_CONTACT_EMAIL` (`docs/DEPLOY.md` §2); the address and the
  reference also show as plain text for in-app browsers with no mail
  app. Keep `LEGAL_CONTACT_EMAIL` set on every backend: without it the
  link falls back to the Terms contact, a **public** GitHub issue.
- A report carries only a **board reference**: the first 16 hex of
  `sha256("pinned-report-v1:" + slug)` (`boardReportRef`,
  `src/domain/tokens.ts`). Never the board link.

## 1. Find the board

```sh
node scripts/find-report-ref.mjs --project moriacrew-pinned-prod --ref <reference>
```

Read-only. Prints `<slug> live|deleted` to your terminal only; exit 1
= not in that project (try `moriacrew-pinned-dev`). From here the slug
goes only into the console paths and commands below: never into
mail, chat, tickets, Linear or git, and never paste those commands
anywhere.

## 2. Note what is there (read only)

Firestore console → `boards/<slug>/elements`: for each doc note `id`,
`cutoutRef`, `label`; `boards/<slug>/scenes`: note each `id`. Write
them in a private operator note (never git, never Linear). A
`cutoutRef` that does **not** start with `elements/boards/<slug>/` is a
library copy whose bytes live in another board's folder: note that
folder (the ref without `cutout.png`). Do not open Storage in the
console on these folders: it previews images.

## 3. Hold storage — before the tombstone

A tombstone alone does not preserve anything: `sweepDeletedBoardStorage`
(`src/server/board-storage.ts`) deletes a deleted board's objects
whenever a decompose or scene job on it finishes (`decompose-job.ts`,
`scene-job.ts`), and deleting another board can free shared cut-out
bytes. So hold first:

```sh
gcloud storage objects update "gs://<bucket>/elements/boards/<slug>/**" --temporary-hold --project <project>
gcloud storage objects update "gs://<bucket>/scenes/boards/<slug>/**" --temporary-hold --project <project>
```

Same command for each foreign folder from step 2
(`"gs://<bucket>/<folder>/**"`). "Matched no objects" is fine (no
scenes yet). Check one: `gcloud storage objects describe
"gs://<bucket>/<cutoutRef>" --project <project>` shows
`temporary_hold: true`. Storage refuses to delete a held object, so the
sweep's delete fails harmlessly (counted as `failed`, logged by error
name only). **Never hold or list `tmp/`**: working copies are not
evidence we keep; the 1-day lifecycle rule deletes them.

## 4. Tombstone the board

Firestore console → `boards/<slug>` → add field `deletedAt`, type
number, value = now in epoch ms (PowerShell:
`[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()`). Same tombstone as
the host delete (`BoardRepository.deleteBoard`): the board, its
images, scenes and link-preview card read as missing everywhere. Then
run the step 3 commands once more, to catch anything a job wrote in
between.

## 5. Library copies on other boards

A signed-in uploader can pin a cut-out onto other boards they joined
(`pinFromLibrary`, `src/server/my-pins.ts`). The copy shares the same
stored bytes and its board is live, so step 4 does not stop it. For
each distinct `cutoutRef` from step 2: Firestore → Query builder →
scope **Collection group**, `elements` → `cutoutRef` `==` `<cutoutRef>`
→ Run (the index exists). Every result outside `boards/<slug>/` is a
copy (or the source, if the reported element was itself a copy): give
each one the step 6 hold.

## 6. Hold one element (copies, or a board that stays live)

For element `<id>` on board `<b>`, in this order:

1. Collection group `scenes` → `elementIds` `array-contains` `<id>`.
   For each: hold `"gs://<bucket>/scenes/boards/<b>/<sceneId>/**"`
   (command as step 3), then set field `hidden` = `true` (boolean).
   Hidden scenes are never listed or served.
2. Hold the element's folder (`cutoutRef` without `cutout.png`), unless
   section 3 already covered it. Always before the prefix below: once
   prefixed, the shared-bytes check no longer sees this element, so
   another delete could free the bytes.
3. In the element doc, put `held:` in front of `cutoutRef` and
   `flattenedRef` (`held:elements/boards/…`). Checked in code: the board
   image route, the library thumbnail and the link-preview card serve
   only refs starting `elements/` (`resolveElementImage`,
   `resolveOwnedElementImage`, `loadBoardCard`); owner delete and job
   clean-up never delete such a ref; a new scene using it fails (the
   store refuses a ref with `:`), so no bytes reach a model or a
   collage; pinning it from the library copies the `held:` refs. The pin
   stays with a blank picture; if its name is the problem, change
   `label` too (old one in the note).

False alarm: remove the prefixes, set `hidden` back to `false`,
release with `--no-temporary-hold`.

**The judges' demo board:** never tombstone it; hold the reported
elements with step 6. If the whole board is spoiled, point the landing
demo link at the backup board (`docs/DEPLOY.md` §6.3):
`firebase apphosting:secrets:set DEMO_BOARD_SLUG --project
moriacrew-pinned-prod`, backup slug typed at the prompt; it applies on
the next rollout (`docs/launch-ops-runbook.md` §5). The submission
form may still carry the original link, so the step 6 holds stay.

## 7. Report and preserve

1. The operator note also gets: the reference, the report's date and
   text, the receipt / confirmation / quarantine times, the copies
   held. No image bytes, no board link.
2. **CSAM or anything that may be:** report to the NCMEC CyberTipline
   (report.cybertip.org) the same day with the note's metadata;
   outside the US, also the national hotline (inhope.org). If they ask
   for the material, only they get it, through their channel.
3. Keep every hold until the report is closed. Where US law applies,
   18 U.S.C. §2258A(h) requires preserving reported content after a
   CyberTipline report: 1 year since the 2024 REPORT Act (90 days
   before it), longer if law enforcement asks. Confirm which law
   applies with counsel.
4. **Never redistribute** suspected CSAM: no download to any device,
   no attachment, no "evidence" copy. If a reporter sent an image
   anyway, do not forward it; tell NCMEC it exists and delete the mail
   copy once they have what they need.
5. Other illegal content: same holds and note, follow counsel on
   reporting. Ordinary Terms breaches (spam, harassment): the
   tombstone or step 6 is the removal.

## 8. Close out

1. Reply to the reporter: removal confirmed, the date, nothing else.
2. Quarantine other boards only if they are reported too; never browse
   unreported boards.
3. When preservation ends (CSAM: NCMEC / law-enforcement clearance and
   the legal period): `--no-temporary-hold` on every path you held,
   then `gcloud storage rm` on the same paths. Nothing in the app
   sweeps a hand-tombstoned board by itself. False alarm instead:
   delete the `deletedAt` field (the board returns as it was), undo
   step 6, release the holds.
4. Log the outcome (reference, dates, CyberTipline report number)
   where the operator keeps such records.
