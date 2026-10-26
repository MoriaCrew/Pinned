# Pinned — High-Level Requirements

_Status: v0.1 (Day 1, Oct 26, 2026) · Track: Indie (solo developer) ·
Theme: Build for Your World · Submission deadline: Nov 4, 2026 9:00 PM ET_

This document is the contract for the 10-day build. It records what
Pinned must do, what it explicitly will not do, the gaps found in the
original pitch and how each is closed, and the decisions already made.
Implementation work is decomposed from the `FR`/`NFR` IDs below into
Linear `PIN-*` issues; every PR must cite the IDs it satisfies.

## 1. Problem & audience

Group chats (family, friends, work teams) already share photos and roast
each other, but turning that into a game today needs an app install, an
account, and everyone free at the same time. Pinned serves an existing
chat of 3–12 people who know each other, on phones, asynchronously, with
zero install: one link in the chat is the entire distribution channel.

**Why now / why Meta models:** a convincing, group-specific host
(persona, judging, memory) needs strong multimodal reasoning (Muse
Spark); fair guessing needs reliable object cut-outs (SAM 3.1); a
shareable poster people actually re-post needs fast, cheap image
generation (Muse Image). None of the three is decorative — remove any
one and the loop breaks.

## 2. Core loop (the whole product)

```
CREATE (1-line host brief + deadline)
  → OPEN (private async photo submissions, host judges + teases)
  → REVEAL (cut-out gallery; guessing if ≥4 entries; owners revealed)
  → CLOSED (winner + poster; link becomes read-only scoreboard)
  → REMATCH (new link + structured diary handoff) → CREATE …
```

## 3. Functional requirements (MVP = submission scope)

### FR1 — Create a game
- FR1.1 Creator enters a one-line host brief (free text, ≤140 chars) and
  picks a deadline preset: Express (2h), Evening (same-day 21:00), or
  24h. Custom hours (1–72) allowed behind "More options".
- FR1.2 System generates a structured host persona (name, voice rules,
  catchphrases, judging style) and one photo challenge. Persona is
  stored as JSON, not just prompt prose, so behaviour is testable.
- FR1.3 Creator receives: player link `/g/{slug}`, a separate admin
  token/link, and ready-to-paste invite text for the group chat.
- FR1.4 The judging rubric (Fit / Effort / Chaos, 0–5 each) is shown to
  all players from the start. The winner is the rubric total; host prose
  explains, never contradicts, the scores.

### FR2 — Join & submit (no account)
- FR2.1 First visit asks only: display name, roast level
  (Gentle/Spicy/Feral, default Spicy), poster opt-in (default on,
  one-tap off). A signed player cookie makes return visits one tap.
- FR2.2 Player submits one photo (camera or upload; JPEG/PNG/WebP,
  ≤10 MB). Resubmission before close replaces the entry.
- FR2.3 System proposes a cut-out; player confirms, taps to reselect the
  object, or chooses "use whole photo". Submission never blocks on
  segmentation failure.
- FR2.4 Player immediately sees their private host judgement (scores +
  persona line). Other players see only an anonymous teaser.

### FR3 — Host during OPEN
- FR3.1 Each submission is judged once (idempotent): object naming →
  rubric scores + reason → persona judgement + anonymous teaser.
- FR3.2 A live teaser feed on the game page shows count + anonymous
  host lines ("Someone brought office equipment to a knife fight…").
- FR3.3 Creator can copy a nudge message at any time ("4 in, closes
  21:00 👀") to paste back into the chat. (No push/email/SMS in MVP.)

### FR4 — Close, reveal & guessing
- FR4.1 Game auto-closes at deadline; creator (admin token) can
  force-close early or extend once (+2h).
- FR4.2 Reveal shows all cut-outs shuffled, without owners. If ≥4
  entries, each player guesses the owner of each cut-out (own excluded);
  if <4, guessing is skipped. Guessing window: creator-controlled,
  default "reveal immediately after all guess or 1h".
- FR4.3 Owners, scores and judgements are then revealed; best guesser
  gets a host shout-out (no separate points economy in MVP).

### FR5 — Winner, poster & scoreboard
- FR5.1 Host announces the winner in persona voice with rubric breakdown.
- FR5.2 A poster image is generated (Muse Image background + composited
  SAM cut-outs + rendered text). Entries with poster opt-out appear as
  silhouettes/names only. Poster + a square result card are downloadable.
- FR5.3 After close the link is a read-only scoreboard with correct
  link-preview (Open Graph) metadata for chat sharing.

### FR6 — Rematch & host memory
- FR6.1 "Rematch" creates a new game/link in the same chain; creator may
  keep or edit the host brief and deadline.
- FR6.2 At close, the system writes a structured diary entry (winner,
  streaks, notable entries, 1–3 running jokes; capped size). The next
  game's host prompt includes the chain diary. Breaking the chain
  (fresh create) starts with no memory.
- FR6.3 Diary contains game facts only — never photo content beyond
  short object labels, never roast lines aimed at a person.

### FR7 — Judge demo (hackathon-critical)
- FR7.1 A seeded Express demo game lets a single judge experience the
  full loop in <3 minutes (pre-filled rival entries, force-close).
- FR7.2 Landing page explains the game in <30s with "Start a game" and
  "Try the 3-minute demo" as the only primary actions.

## 4. Non-functional requirements

- NFR1 **Mobile-first:** every flow usable one-handed on a phone browser;
  join-to-submit in <60s for a first-time player.
- NFR2 **Privacy by construction:** originals processed ephemerally and
  deleted after cut-out derivation; EXIF stripped; only cut-outs/posters
  persist. In-app copy states exactly this — no stronger claim.
  A vision safety check flags likely screens/documents/faces and warns
  the player before submit (blur-or-retake guidance).
- NFR3 **Friendly roasts:** system-level policy — roast the photo, effort
  and timing, never identity, body, or protected traits. Per-player roast
  cap enforced at generation; violating output is regenerated once, then
  replaced with a safe fallback line. Creator can hide any entry/line.
- NFR4 **Cost & reliability:** per-game AI budget ceiling with graceful
  degradation (cached persona lines, poster background fallback); every
  model call logged (model, tokens/images, latency, cost estimate);
  `AI_MOCK` mode runs the full loop without paid calls for CI/previews.
- NFR5 **Abuse basics:** capability-URL slugs (unguessable), rate limits
  on create/submit, file validation, one entry per player cookie.
- NFR6 **Observability:** game-state transitions and AI-call outcomes
  visible in server logs; a minimal `/health` endpoint for uptime checks.

## 5. Explicit non-goals (MVP)

Accounts/passwords, native apps, push notifications, real-time sync play,
points economy, player-vs-player dares, public discovery/matchmaking,
payments, video submissions, multi-language UI (host *voice* may follow
the brief's language; UI ships in English).

## 6. Gaps found in the pitch → how closed (decision log)

| # | Gap / risk | Decision (this doc) |
| --- | --- | --- |
| G1 | AI winner feels arbitrary | Published rubric; scores decide, prose explains (FR1.4, FR3.1) |
| G2 | No notifications → dead async games | Deadline presets + copy-paste nudges; chat stays the channel (FR1.1, FR3.3) |
| G3 | Identity without accounts undefined | Capability link + signed player cookie + admin token (FR2.1) |
| G4 | "Most suspicious object" is not a SAM concept prompt | Spark names the object in plain nouns → SAM prompt; tap-reselect + whole-photo fallback (FR2.3) |
| G5 | "Blurs PII before storage" over-claims | Narrowed claim + ephemeral originals + safety-flag warning (NFR2) |
| G6 | Persona brief = prompt-injection / roast-safety risk | Structured persona JSON + system roast policy + per-player cap + regenerate/fallback (FR1.2, NFR3) |
| G7 | Guessing with 2–3 players is pointless | Guessing only at ≥4 entries (FR4.2) |
| G8 | Async game demos badly | Seeded <3-min Judge Demo + force-close (FR7) |
| G9 | Diary drift over long chains | Structured, size-capped JSON diary (FR6.2) |
| G10 | Poster text via image model is unreliable | Image model paints background only; text composited server-side (FR5.2) |

**Pivot gate (Day 5):** if playtests show guessing confuses/slows the
reveal, replace it with Host Awards (Winner / Lowest Effort / Most
Suspicious) using the same assets. The host/persona core does not pivot.

## 7. Success metrics for the hackathon build

- A 4+ player real group-chat game completes end-to-end with no manual
  intervention (Days 8–9 playtest), captured for the demo video.
- Judge demo completable solo in <3 min from a cold browser.
- Segmentation fallback rate, roast-policy violations (target 0 in eval
  set), and cost per game measured on a 20-photo golden set.
- Feature freeze Nov 3 EOD; Nov 4 reserved for video + submission.

## 8. Open questions (resolve by end of Day 2)

- Q1 Hosting vendor pick (see `02-architecture.md` §6) — decide at scaffold.
- Q2 Exact SAM 3.1 request/response shape on Meta Model API — retired by
  Day-1 smoke test (`PIN-3`); gateway interface isolates the answer.
- Q3 Guessing-window default (immediate vs timed) — decide from first
  4-player internal playtest.
