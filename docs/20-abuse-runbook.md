# 20 — Abuse reports and illegal content (PIN-239)

One page for the human on duty. Scope: a report that a board holds
illegal or abusive content — above all CSAM (child sexual abuse
material). This is an operations procedure, not legal advice; when
in doubt, quarantine first and ask qualified counsel after.

## Where reports land

- "Report this board" at the foot of every board page mails
  `LEGAL_CONTACT_EMAIL` (see `docs/DEPLOY.md` §2). Someone named
  watches that inbox while any public post is live.
- A report carries only a **board reference** (`board.reportSubject`
  / `board.reportBody`): the first 16 hex of
  `sha256("pinned-report-v1:" + slug)` (`boardReportRef` in
  `src/domain/tokens.ts`). It never contains the board link, so
  mail and logs never gain a working capability URL.
- Terms promise removal within `Policy.takedownHours` (24) of
  confirming a report (`/terms` #report).

## Find the board from a reference

1. In the Firebase console (prod project first), list the doc ids
   of the `boards` collection — the ids are the slugs.
2. Recompute the reference per slug with any sha256 tool, e.g.
   PowerShell:
   `[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes("pinned-report-v1:<slug>"))).Substring(0,16).ToLower()`
   (or `printf 'pinned-report-v1:<slug>' | sha256sum`, first 16
   chars). The match is the reported board.
3. Keep the slug out of mail, chat and tickets from here on; refer
   to the board by its reference.

## Quarantine (minutes, before anything else)

1. In Firestore, open `boards/<slug>` and set `deletedAt` to the
   current epoch-ms. That is the same tombstone the host delete
   writes (`BoardRepository.deleteBoard`): the board reads as
   missing everywhere and its photos/scenes stop being served
   (assets only ever go through the board-checked route).
2. Setting the field by hand does **not** run the storage sweep —
   that only runs in the in-app delete flow
   (`sweepDeletedBoardStorage`). Leave the bytes under `tmp/`,
   `elements/` and `scenes/` exactly where they are: unreachable
   to visitors, preserved for the report below.
3. Do not open the board or view the images to "check". Work from
   the report text and the element/scene metadata (labels, ids,
   times) only.

## Preserve and report

1. Record, in a private operator note (never git, never Linear):
   the reference, the report's date and text, when you set
   `deletedAt`, and the element/scene ids from the board's
   subcollections. No image bytes, no board link.
2. **CSAM or anything that may be:** file a report with the NCMEC
   CyberTipline (report.cybertip.org) the same day. Include the
   metadata from the note. Keep the storage objects untouched
   until NCMEC or law enforcement say otherwise; if they ask for
   the material, only they get it, through their channel.
3. **Never redistribute** suspected CSAM: do not download it to a
   personal device, attach it to mail, or copy it anywhere for
   "evidence". If a reporter sent you an image anyway, do not
   forward it — tell NCMEC it exists and delete the mail copy once
   they have what they need.
4. Other illegal content (not CSAM): keep the tombstone on, keep
   the same note, and follow counsel's direction on reporting.
   Ordinary Terms breaches (spam, harassment): the tombstone is
   the removal; note it and close.

## Close out

1. Reply to the reporter: confirm removal, give the date, nothing
   else (no board link, no other board's data, no internals).
2. Check the same uploader did not use other boards you can see
   reported the same way; quarantine any that are reported too —
   do not go browsing unreported boards.
3. Only after the preservation step is finished (for CSAM: after
   NCMEC/law-enforcement clearance) may the board's storage be
   swept like a normal deleted board. Until then the tombstone
   alone keeps it off the site.
4. Log the incident outcome (reference, dates, CyberTipline report
   number if any) where the operator keeps such records.
