# Pinneds Studio — a shared pinboard of real things

> Anyone with the board link uploads a photo. Muse Spark names the
> things in it, SAM 3.1 cuts each one out, and the cut-outs are pinned
> to the board with the owner's name. Anyone then picks a few pins
> from anyone, writes or taps a scene prompt, and Muse Image composes
> them into a new image in the board's gallery — credited to the
> people whose things are in it. No accounts: the link is the
> invitation.

**Meta Global AI Developer Hackathon** · Indie Developer track · Theme:
*Build for Your World* · Solo developer · Oct 26 – Nov 4, 2026

- Hackathon: https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details
- Meta event page: https://dev.meta.ai/events/global-hackathon
- Org: https://github.com/MoriaCrew · Tracking: Linear team `PIN` (Pinned)
- Repository: https://github.com/MoriaCrew/Pinned (public, AGPL-3.0 — see License below)

## Studio in 30 seconds

1. **Share.** Create a board, get a link (`/g/{slug}`), drop it in the
   group chat. Nothing to install, no accounts.
2. **Pin.** Anyone uploads a photo; Spark names the things in it and
   SAM cuts them out. The cut-outs land on the board as pins with the
   owner's name.
3. **Make a scene.** Pick a few pins from anyone, write or tap a scene
   prompt, and Muse Image composes them into a new image in the
   board's gallery — credited to whoever brought each thing.
4. **Remix.** Any scene can be remixed into a new one. Solo works too:
   a one-person board is also the judge demo.

> **Pivot note (Oct 28, PIN-48):** Pinneds started as an AI-hosted
> photo game. The game (judging, personas, deadlines, guessing) is
> dropped; Studio is the product now. The game docs are archived in
> `docs/archive/`; the Studio spec is `docs/11-studio.md`.

## How Meta's models power it

| Model | Role in Pinneds Studio |
| --- | --- |
| **Muse Spark** (Meta Model API) | Names the elements in a photo (short noun phrases that feed SAM) and flags faces for the one-line consent note. |
| **SAM 3.1** (Meta Model API) | Cuts each named thing out of the photo: concept prompts, plus tap/box prompts to add what naming missed. |
| **Muse Image** (Meta Model API) | Composes selected pins into a new scene from reference images (`/v1/responses`); stateless remix re-attaches the parent scene image. |

All model calls go through one gateway (capability ports
`ElementNamer`, `Segmenter`, `SceneComposer` with timeout, retry,
budget reservation and cost logging — `docs/11-studio.md` §5.2).
Every limit (pins per scene, caps, timeouts, TTLs) lives in one
typed Policy object; nothing is hard-coded.

## Privacy, in one paragraph

Original photos are never stored: uploads are stripped (EXIF
removed, re-encoded) into a short-lived working copy, and only the
cut-outs and scenes persist. People are allowed in pins — when a
face is detected the app asks "everyone in this photo OK with being
remixed?" and never blocks; the provider's guardrails refuse what
they refuse, and refusals show as a friendly message, not an error.
Inputs go to Meta under Standard mode (not used for training).

## Status

🚧 **Studio pivot in progress (Oct 28).** Spec in the repo
(`docs/11-studio.md`, `docs/adr/003-studio-architecture.md`); slices
(photo → pins, pins → scene, sharing, remix) land as small `PIN-*`
PRs to `dev`. First family board targets Sat Oct 31; feature freeze
Tue Nov 3; submission Wed Nov 4, 9:00 PM ET. Demo link and video
will be added here before submission.

## Docs

- `docs/11-studio.md` — Pinneds Studio spec: product, Policy, ports,
  jobs, data model, UX, slices, test plan, open questions
- `docs/adr/003-studio-architecture.md` — Policy as data, capability
  ports + decorators, jobs, Element/Pin split, stateless remix
- `docs/03-ai-sdlc.md` — Linear → coding agent → PR → review workflow (solo + Muse)
- `docs/06-photo-intake.md` — photo intake and ephemeral storage
- `docs/07-sam-lab.md` — SAM 3.1 lab notes and measurements
- `docs/08-ux-principles.md` — minimal, icon-first UX rules
- `docs/09-design-system.md` — board themes (ex-presets; see docs/11 A5)
- `docs/10-custom-domains.md` — pinneds.com domain setup
- `docs/archive/` — game-era requirements, architecture and research
  (01, 02, 05), archived Oct 28; history only
- `SECURITY.md` — public-repo guardrails: never-commit list + leak runbook
- `AGENTS.md` — instructions for coding agents working this repo

## Quick start (developers)

Requirements: Node 20.9+ and npm. The scaffold runs fully offline with
mock AI; no API key is needed for the landing page or tests.

```bash
git clone https://github.com/MoriaCrew/Pinned.git
cd Pinned
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000 in a browser. Health check:
http://localhost:3000/api/health

Quality gates: `npm run typecheck`, `npm test`, and `npm run build`.
Firebase projects `moriacrew-pinned-dev` and `moriacrew-pinned-prod`
exist with Firestore in `eur3`, billing enabled, and `pinned-web`
App Hosting backends in `europe-west4`; the first rollout follows merge.

## License

Copyright (C) 2026 Moria Crew. AGPL-3.0 — see `LICENSE`. In short: you may use, study and modify this
code, but if you offer a modified version to others over a network you
must release your source under the same licence. Hackathon note: the
organisers separately receive a broad licence to submitted materials
under the event rules; the AGPL governs reuse by everyone else.
