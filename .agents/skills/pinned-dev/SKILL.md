---
name: pinned-dev
description: Work safely and consistently on the Pinneds Studio Next.js, Firebase, and AI Gateway codebase.
---

# Pinneds Studio Development

Use this skill for implementation, debugging, testing, prompt, or
Firebase work in the Pinned repository. Studio pivot (PIN-49): the
game is dropped. Spec: `docs/11-studio.md`; decisions:
`docs/adr/003-studio-architecture.md`. Game docs are archived in
`docs/archive/` — do not apply them.

## Start every task

1. Read the assigned `PIN-*` issue, then `AGENTS.md`.
2. Read the relevant sections of `docs/11-studio.md` (spec),
   `docs/adr/003-studio-architecture.md`, `docs/06` (photo intake),
   `docs/07` (SAM lab) and `docs/08` (UX) as the issue needs.
3. Check `git status` and preserve changes you did not make.
4. Work on a `PIN-{n}/short-slug` branch from current `dev`. PRs go
   to `dev`, titled `PIN-{n}: …`. Never merge to `main` without
   Robin.

## Architecture rules

- Keep `src/domain` pure, deterministic, and unit-tested.
- **No hard-coded limits.** Every count, size, cap, timeout and TTL
  comes from the one typed `Policy` object (`docs/11` §5.1:
  defaults → env → per-board overrides). Prompts, validators and UI
  read the same object.
- Route every AI call through the gateway capability ports
  (`ElementNamer`, `Segmenter`, `SceneComposer`) with the decorator
  chain: timeout → retry → reserve budget (fail closed) → call →
  log cost → fall back. Never import provider SDKs in UI or domain
  code. Provider refusals are the typed outcome `refused`, never a
  500.
- Read environment only through `src/config.ts`. Server modules
  carry `server-only`.
- Default to `AUTH_MODE=link-only` and `AI_MOCK=1`. Board
  participants never authenticate; sign-in comes later behind
  `AUTH_MODE` (PIN-57). Do not add Firebase Auth or live AI calls
  unless the assigned issue explicitly requires them and its gate
  has passed.
- Firestore and Storage are server-only; assets are served through
  a route that checks the board link. Keep client rules deny-all.
- Never persist original photos. Persist only the stripped working
  copy under `tmp/` (Policy TTL, `docs/11` A6) and derived cut-outs
  (`elements/`) and scenes (`scenes/`). People are allowed in pins:
  a face flag shows the one-line consent note (`faces: note`),
  never blocks.
- Jobs: `DecomposeJob`/`SceneJob` move `pending → running → ready /
  failed / refused`, idempotent, claim-before-call; request does
  the work, client polls. No queue in slices 1–2.
- Put all UI copy in `src/i18n/messages/en.json`; keep French as an
  empty fallback stub unless the issue explicitly requests
  translation. Follow `docs/08`: icon + ≤6 words, 44 px targets.
- Prompt behavior changes update a versioned file under `prompts/`
  (`elements.v1`, `scene.v1`) and require matching fixture or
  golden-set evidence. Store the prompt version with every output.
- Validate board slugs as `^[A-Za-z0-9_-]{22}$` before any
  Firestore path is built.

## Verify

Run the narrowest relevant test first, then:

```bash
npm run typecheck
npm test
npm run build
```

with `AI_MOCK=1`. For UI work, run `npm run dev`, open the affected
route and `http://localhost:3000/api/health`, and record a
phone-viewport check in the PR. Never use paid model calls in CI or
ordinary tests; use the mock gateway and recorded fixtures. A live
smoke belongs only to an issue that asks for it, with secrets
supplied outside git and spend recorded.

## Ship

Fill the PR template with the short `PIN-n` ID, the `docs/11`
sections implemented, exact test commands and outcomes, AI/cost
impact, screenshots for UI work, and rollback. Squash-merge to
`dev` only when CI, gitleaks and Cursor Bugbot have **all finished
green** (pending ≠ pass); triage every Bugbot finding in-thread.
Never commit `.env*` values, keys, service-account JSON, or real
personal photos.

## Autonomy / stop rules

Don't wait for Robin: run tests yourself, decide from the numbers
and `docs/11` §2, record why in the PR. Split any issue over ~1 day
or ~400 changed lines into child issues first. **Stop and report**
on the Linear issue, then continue with other unblocked work, only
if: Muse Image cannot compose reference images at all; spend would
exceed 3× budget; a change would store originals or leak a secret;
an operator-only step is needed (secrets, console, DNS).
