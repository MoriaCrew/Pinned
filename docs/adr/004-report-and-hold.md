# ADR-004: Reports hold first, decide second, delete on a timer only for faces

_Status: Accepted Nov 4, 2026 (PIN-266). Extends ADR-003. Runbook:
`docs/20-abuse-runbook.md`. Policy row: `docs/11-studio.md` §5.1
(`report.*`, `takedownHours`)._

## Context

"Report this board" (PIN-239) is a one-tap `mailto:` to the legal
contact whose body carries only an opaque board reference. On
Nov 4 2026 a visitor sent one by mistake: the mail held the template
and nothing else. There is no reason to pick, no confirmation, no
in-app record, and everything after receipt is manual (find the
board, hold Storage, tombstone, find library copies). The pieces the
runbook uses by hand already exist in code: scene `hidden`, element
refs prefixed `held:` (never served, never deleted, never reach a
model), the board tombstone, `Element.faceFlag` set by Muse Spark at
upload, and Storage temporary holds.

Three automations were on the table: take a board offline or delete
its assets whenever a reported picture contains faces; let a model
judge the reported content; delete as soon as anyone on the board
reports. Hosting-service notice-and-action duties (DSA Art. 16 and
17) apply regardless of company size; Art. 19 exempts small
providers only from the online-platform duties. Legal wording stays
with counsel.

## Decision

1. **Reports are in-app records.** `POST /api/boards/<slug>/report`
   writes a `reports/{id}` document with a scope (element, scene,
   board), one reason (`likeness`, `inappropriate`, `illegal`,
   `ownership`, `other` with a message), the reporter kind
   (participant when the board cookie is valid, else visitor) and
   what was held. The reporter sees a receipt with the reference. The
   `mailto:` goes; the contact address stays as plain text.
2. **Hold at report time, reversibly.** The request applies the hold
   itself (no queue, like the demo sweep): the element's refs get
   `held:` and the scenes using it `hidden`; a whole-board hold does
   that for every element and scene and sets `Board.reviewAt`, which
   blocks uploads, scenes and tap-adds (423). A report records
   exactly what it held so `dismiss` can restore it.
3. **Decision table.** Element or scene: held for any reporter and
   reason. Whole board: held when the reporter is a participant or
   the reason is `illegal`; an anonymous visitor's whole-board report
   with another reason is queued and alerted, nothing hidden (anyone
   with a link can join and report, so one click must not blank a
   friend group's board). `illegal` adds Storage temporary holds on
   the board's folders.
4. **Delete on a timer.** _Amended 2026-11-04 (PIN-278): the
   operator does not watch the queue by default._ Every report that
   holds something sets `deleteAt = now + takedownHours`; the backstop
   tombstones it if nobody decided by then. Content reported as
   `illegal` is tombstoned too, but its Storage temporary holds
   survive the takedown, so the bytes are preserved for the runbook's
   §7 until `release-holds`. A queued-only report (nothing hidden) has
   no deadline. _Before:_ only a `likeness` report on a face-flagged
   element had a deadline, and `illegal` was never deleted by the app.
5. **No model as judge.** Suspected illegal content never leaves the
   project (the runbook's "nothing reads image bytes" holds for the
   automation too), a model verdict is not a defensible takedown
   ground, and the signal we rely on is already computed at upload
   (`faceFlag`, screen and document flags) or at generation (provider
   refusals).
6. **Alert through Monitoring, not mail.** The route logs one
   structured line `report.received` with the reference, reason,
   scope, severity and hold counts, never the slug or the message. A
   log-based alert policy on the existing email channel delivers it.
   The operator decides with `scripts/report-decide.mjs` (`--dismiss`
   restores, `--takedown` follows the runbook); a signed-in operator
   page can come later.
7. **Limits are Policy.** `report.perIp`, `report.maxBytes`,
   `report.messageMaxChars`, `report.sweepBatch`; the deadline is the
   existing `takedownHours` promised on `/terms`.

## Consequences

- A mistaken report hides at most the thing it names, and `dismiss`
  puts it back; today's accidental mail would have produced a queued
  record and an alert, nothing hidden.
- The reporter's message is stored for the operator but never logged
  or mailed; the alert carries the reference only, so the board link
  never spreads.
- Prod gets this with promotion #4 after judging week; it lands on
  `dev` first.
- Not done here: email acknowledgment to the reporter (needs an SMTP
  provider and a new secret), an operator UI, and any automated
  detection of illegal material (partner-gated hash matching; the
  human path in `docs/20` remains).
