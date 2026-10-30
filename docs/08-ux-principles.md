# 08 — UX principles: minimal, icon-first (PIN-37)

> The look, words and components are now defined in
> [`docs/14-design-system.md`](14-design-system.md), which wins where
> the two disagree (no emoji, verb-first words, the Pinneds UI kit).

Audience assumption: a player who tapped a chat link and does not
"do apps". Every screen must survive being used one-handed, in a
hurry, with zero instructions read.

## Rules

1. **One action per screen area.** If two things compete, one goes
   behind a tap (`<details>`) or to a later step.
2. **Icon + ≤6 words.** Labels are `⏰ Ends`, `📷 in`, `Join →`.
   Sentences only where a mistake is costly (admin-link secrecy,
   photo safety) — and then one short line, icon-led.
3. **Show, don't explain.** Example hosts are tappable chips, not
   help text. Deadlines are ⚡ 🌆 🐌 cards.
4. **Big targets.** Anything tappable is ≥44px, primary actions
   ≥48px and full-width where practical (.btn, .choice-card,
   .photo-pick).
5. **Progress is visible, not described.** The ① Join → ② Photo
   → ③ Done strip replaces explanatory paragraphs.
6. **No jargon, no system states.** Never render raw enum values
   ("OPEN"), build status, or storage concepts at players.
7. **Icons are decoration, text is meaning.** Every icon keeps a
   real text label for screen readers and translation (EN now,
   FR later via `src/i18n`). Emoji vary by platform; words don't.
8. **Errors are one line + the fix.** "Too big — 10 MB max." not a
   paragraph. Prevent first: client-side size check before upload,
   instant photo preview before sending.

## Iteration log

- **It.1 (PIN-37):** game page challenge-first with fact chips;
  rubric/voice collapsed into "🎭 Meet your host"; join with
  roast cards + PIN behind "📱 Switching phone later?"; submit
  with one-line safety icon row, big photo picker with instant
  preview; create with example chips + deadline cards.
- **Make a scene (PIN-70):** pins themselves are the picker —
  tap to pick (✅ Picked + count in the bottom bar), fixed
  suggestion chips are tappable example prompts (§3), refused and
  failed scenes are one friendly line + "✏️ Change idea" (§8).
- **Collage fallback (PIN-71):** offline (AI_MOCK) and
  over-budget scenes arrive as a "🧩 Collage" card — the cut-outs
  on a gradient, labelled in the UI and in the data
  (kind="collage"), never dressed up as an AI scene (§6 honesty).
- Next candidates: reveal/guessing flow (PIN-10), poster share
  (PIN-11), creator admin (PIN-12), FR pass with family testers.
