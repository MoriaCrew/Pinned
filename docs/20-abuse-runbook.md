# 20 — Abuse reports and illegal content (PIN-239, PIN-266)

One page for the human on duty. Scope: a report that a board, a pin
or a scene holds illegal or abusive content, above all CSAM (child
sexual abuse material), and the ordinary reports (someone's likeness,
something not theirs to share) that arrive far more often. These are
operational controls, not legal advice; when in doubt, hold first and
ask qualified counsel after. Decision record: `docs/adr/004-report-and-hold.md`.

**Order:** read the report → decide (dismiss or takedown) → report
and preserve when illegal → close. Never open the board, never view,
download or forward the images: the scripts below work on records
and references and print no board link. Use your own logins (`gcloud
auth application-default login`); no service-account keys.
`<project>` is `moriacrew-pinned-prod` or `moriacrew-pinned-dev`.

## 0. Who and when (fill in before launch)

| | |
| --- | --- |
| On duty | `<name>` (backup `<name>`) |
| Report alert (email) and `pending` checked | twice a day during judging week (`docs/DEPLOY.md` §8), `<cadence>` after |
| Decision target | within `<N>` h of **receipt** (the report's `created` time) |
| "Confirmed" means | `<e.g. the report text plus the record's metadata plausibly show a Terms or legal breach>` |

The Terms promise removal within `Policy.takedownHours` (24 h by
default) of **confirming** a report (`/terms#report`). That clock
starts at confirmation, so the row above must bound receipt →
decision, or the promise is open-ended. Anything that may be CSAM is
held on receipt (the app does it), before any confirmation.

## What the app already did (PIN-266)

"Report" at the foot of every board page opens a sheet: what (this
board, a pin, a scene), why (`likeness`: that is me or someone who did
not agree; `inappropriate`; `illegal`, minors included; `ownership`:
not theirs to share; `other` with a message), an optional message and
email. `POST /api/boards/<slug>/report` records it at `reports/{id}`
and acts at once, reversibly, per this table:

| Scope | Reporter | Reason | Automatic action |
| --- | --- | --- | --- |
| pin / scene | anyone | any | the pin's refs get `held:` (image 404, never composed), the scenes using it are hidden; a scene is hidden |
| pin with a face | anyone | `likeness` | as above, plus a deadline: tombstoned by the daily sweep if nobody decided within `takedownHours` |
| whole board | participant | any | every pin held and scene hidden; board under review (uploads, scenes, tap-adds answer 423; banner on the page) |
| whole board | anyone | `illegal` | as above, plus Storage temporary holds on every object (evidence), severity high |
| whole board | visitor | not `illegal` | nothing hidden (anyone with a link can join and report); the report is queued |

Nothing is deleted automatically except the one deadline case, and an
`illegal` report is never deleted by the app. The reporter sees a
receipt with the board's **reference** (first 16 hex of
`sha256("pinned-report-v1:" + slug)`, `boardReportRef`), never the
slug. The same reference is the only board identifier in the alert
line `report.received` (Cloud Logging → the email channel,
`docs/DEPLOY.md` §6) and in every command below.

A report that still arrives by **mail** to `LEGAL_CONTACT_EMAIL`
(someone copied the address from the sheet) carries that reference
too: treat it as a visitor's whole-board report, that is, decide from
the text; if it names a pin or scene, hold by hand (section 5).

## 1. Read the report

```sh
npm run report:ops -- --project <project> pending                    # the queue, oldest first
npm run report:ops -- --project <project> list --ref <reference>     # every report on that board
npm run report:ops -- --project <project> show --id <reportId>       # one report, message included
```

Read-only. `show` prints the reporter's words: run it in a private
terminal, never in CI. The lines carry report ids, references, enums,
times and hold counts, never the slug. (`npm run report:find-ref --
--project <project> --ref <reference>` still maps a reference to the
slug for the manual path; the slug then goes only into console paths
and commands, never into mail, chat, tickets, Linear or git.)

Write the operator note now (private, never git or Linear): the
reference, report id, the report's text and times (receipt, your
decision), what the app held (`held:` line of `show`).

## 2. Decide

**False alarm, or not actionable** (an accidental tap, a report that
describes nothing, a pin the reporter changed their mind about):

```sh
npm run report:ops -- --project <project> dismiss --id <reportId> --note "<why>"
```

Restores exactly what that report hid: refs unprefixed, scenes back
(a scene returns only when every pin it uses is back), board review
cleared, Storage holds released, unless another **open** report on
the same board still holds them. The record stays as `dismissed`.

**Confirmed** (a Terms breach, or someone's likeness they did not
agree to):

```sh
npm run report:ops -- --project <project> takedown --id <reportId> --note "<what and why>"
```

Removes the reported thing the way the product deletes: a pin
(element cascade: pins gone, its scenes hidden, objects deleted
unless a live library copy still needs them), a scene (tombstone,
picture deleted) or the board (tombstone, My boards rows unlinked,
storage swept). Storage temporary holds are **never** released by a
takedown: a held object refuses deletion, the sweep logs it as
failed, the bytes stay. That is the point for section 6; for an
ordinary takedown that reports `storage hold true`, run
`release-holds` afterwards (section 7, step 3).

**Timed takedown.** A `likeness` report on a face-flagged pin carries
`deleteAt`; `.github/workflows/report-sweep.yml` runs
`report:ops sweep` daily and tombstones what passed its deadline
with no decision (never an `illegal` report). Deciding before the
deadline, either way, cancels it. The step summary shows counts only.

**Reply to the reporter** when they left an email (the record's
`email` line): the decision and the date, nothing else; never the
board link. The app sends no mail itself.

## 3. Reports of illegal content

The app has already held every pin, hidden every scene, put the board
under review and set Storage temporary holds (`show` says
`storage hold true`). Do not dismiss. Decide `takedown` once the
record's metadata and text plausibly describe illegal material (your
"confirmed" rule in section 0); the holds keep the objects as
evidence. Then section 6 (report and preserve). Never run
`release-holds` before section 7 says so.

If `storage hold false` on an `illegal` report, a Storage call
failed when the report was filed: set the holds by hand (section 5,
step 1) before anything else.

## 4. The judges' demo board

Never take down the demo template board or the judges' board as a
whole; decide per pin or scene (the automatic hold already did the
hiding). If the whole board is spoiled, point the landing demo at the
backup board (`docs/DEPLOY.md` §6.3 and §6.5) and leave the holds in
place: the submission form may still carry the original link.

## 5. Manual path (fallback: a mailed report, a failed hold, the app down)

Find the board: `npm run report:find-ref -- --project <project> --ref <reference>`
prints `<slug> live|deleted` to your terminal only.

1. **Hold storage before any tombstone.** `sweepDeletedBoardStorage`
   deletes a deleted board's objects whenever a job on it finishes,
   and deleting another board can free shared cut-out bytes:
   ```sh
   gcloud storage objects update "gs://<bucket>/elements/boards/<slug>/**" --temporary-hold --project <project>
   gcloud storage objects update "gs://<bucket>/scenes/boards/<slug>/**" --temporary-hold --project <project>
   ```
   `<bucket>` is `<project>.firebasestorage.app`. "Matched no objects"
   is fine. **Never hold or list `tmp/`**: working copies are not
   evidence we keep; the 1-day lifecycle rule deletes them.
2. **Note what is there (read only).** Firestore console →
   `boards/<slug>/elements`: note each `id`, `cutoutRef`, `label`;
   `boards/<slug>/scenes`: each `id`. A `cutoutRef` outside
   `elements/boards/<slug>/` is a library copy whose bytes live in
   another board's folder: hold that folder too (step 1 command on
   it). Do not open Storage in the console on these folders: it
   previews images.
3. **Tombstone the board.** Firestore console → `boards/<slug>` → add
   field `deletedAt` (number, now in epoch ms). Same tombstone as the
   host delete: the board, its images, scenes and link card read as
   missing everywhere. Run step 1 again to catch anything a job wrote
   in between.
4. **Library copies on other boards.** For each distinct `cutoutRef`
   from step 2: Firestore → Query builder → Collection group
   `elements` → `cutoutRef == <cutoutRef>`. Every result outside
   `boards/<slug>/` is a copy (or the source): hold it with step 5.
5. **Hold one element** (`<id>` on board `<b>`), in this order:
   collection group `scenes` → `elementIds array-contains <id>` →
   hold each `"gs://<bucket>/scenes/boards/<b>/<sceneId>/**"` and set
   `hidden = true`; hold the element's folder; then put `held:` in
   front of `cutoutRef` and `flattenedRef` in the element doc. Readers
   serve only refs starting `elements/`, job clean-up never deletes
   such a ref, a new scene using it fails, pinning it from the library
   copies the prefix. False alarm: remove the prefixes, `hidden` back
   to `false`, `--no-temporary-hold`.

## 6. Report and preserve

1. The operator note also gets: the reference, report id, the
   report's date and text, the receipt / decision times, the copies
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
   no attachment, no "evidence" copy. If a reporter sent an image by
   mail anyway, do not forward it; tell NCMEC it exists and delete
   the mail copy once they have what they need.
5. Other illegal content: same holds and note, follow counsel on
   reporting. Ordinary Terms breaches (spam, harassment): the
   takedown is the removal.

## 7. Close out

1. Reply to the reporter if they left an address: removal confirmed
   (or not), the date, nothing else.
2. Hold other boards only if they are reported too; never browse
   unreported boards.
3. When preservation ends (CSAM: NCMEC / law-enforcement clearance
   and the legal period), or after an ordinary takedown that left
   holds:
   ```sh
   npm run report:ops -- --project <project> release-holds --id <reportId>
   ```
   releases exactly the objects that report held, minus any object
   another report still holds (an open one, or a takedown not yet
   closed out). Then the objects of a tombstoned board go with the next
   storage sweep, or by hand: `gcloud storage rm "gs://<bucket>/elements/boards/<slug>/**"`
   and the `scenes/` folder. Nothing in the app sweeps a
   hand-tombstoned board by itself. False alarm instead: `dismiss`
   (or, on the manual path, delete the `deletedAt` field, undo step
   5, release the holds).
4. Log the outcome (reference, report id, dates, CyberTipline report
   number) where the operator keeps such records.
