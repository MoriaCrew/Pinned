# Docs index

One line per document. Start with the repo [`README.md`](../README.md), then
[`11-studio.md`](11-studio.md) for the spec and [`19-meta-models.md`](19-meta-models.md)
for how each Meta model is used. Numbers 01, 02 and 05 are archived with the dropped game;
04 was removed on Day 1 (PIN-18).

## Current docs (`docs/`)

| Doc | What it covers |
| --- | --- |
| [`03-ai-sdlc.md`](03-ai-sdlc.md) | How work flows: Linear issue → coding agent → PR → review, for a solo developer |
| [`06-photo-intake.md`](06-photo-intake.md) | Photo intake: checks, EXIF stripping, the short-lived working copy, what is never stored |
| [`07-sam-lab.md`](07-sam-lab.md) | SAM 3.1 lab notes and measurements (`/lab/sam`, dev only) |
| docs/08 (UX principles, superseded by docs/14) | First minimal, icon-first UX rules |
| docs/09 (first design system, superseded by docs/14) | Per-board looks and themes from the game era |
| [`10-custom-domains.md`](10-custom-domains.md) | pinneds.com and dev.pinneds.com domain setup |
| [`11-studio.md`](11-studio.md) | Studio spec: product, decisions, Policy, ports, jobs, data model, storage, UX, test plan |
| [`12-submission.md`](12-submission.md) | Hackathon submission packet and video plan |
| [`13-auth.md`](13-auth.md) | Optional Google sign-in (`AUTH_MODE`), claim flow, My boards and My pins |
| [`14-design-system.md`](14-design-system.md) | The Pinneds design system: look, words, UI kit, landing showcase sets |
| [`15-board-plus.md`](15-board-plus.md) | Board Plus and creations: `PLUS_MODE`, Stripe Checkout, webhook grants, ledger, runbook |
| [`16-ai-usage.md`](16-ai-usage.md) | AI call log, cost estimate per operation, collage reasons, usage report |
| [`17-showcase-sets.md`](17-showcase-sets.md) | Recipe for making a landing showcase set with the app's own pipeline |
| [`18-i18n.md`](18-i18n.md) | UI languages: how a request picks one, `UI_LOCALES`, adding strings, translation runs |
| [`19-meta-models.md`](19-meta-models.md) | Each Meta model: prompt and version, Policy keys, inputs, fallbacks, cost, evidence |
| [`DEPLOY.md`](DEPLOY.md) | Prod runbook and env matrix (lands with PIN-209) |

## Decisions (`docs/adr/`)

| Doc | What it covers |
| --- | --- |
| [`adr/003-studio-architecture.md`](adr/003-studio-architecture.md) | ADR-003: Policy as data, capability ports and decorators, jobs, Element/Pin split, stateless remix |

ADR-001 (hosting) and ADR-002 (no friction) still stand; they live in the archived
`archive/02-architecture.md`.

## Archive (`docs/archive/`, history only)

The photo game Pinneds started as was dropped on Oct 28. Don't apply these docs.

| Doc | What it covers |
| --- | --- |
| [`archive/01-requirements.md`](archive/01-requirements.md) | Day-1 requirements for the game (FR/NFR IDs) |
| [`archive/02-architecture.md`](archive/02-architecture.md) | Game architecture, including ADR-001 and ADR-002 |
| [`archive/05-research-synthesis.md`](archive/05-research-synthesis.md) | Day-1 research synthesis |

## Key files outside `docs/`

| File | What it covers |
| --- | --- |
| [`AGENTS.md`](../AGENTS.md) | Rules for coding agents working in this repo |
| [`SECURITY.md`](../SECURITY.md) | Public-repo guardrails: never-commit list, scanners, leak runbook |
| [`prompts/README.md`](../prompts/README.md) | Prompt contracts and the list of versioned templates |
| [`eval/README.md`](../eval/README.md) | Rules for evaluation fixtures (synthetic only, source noted) |
| [`eval/studio-findings.md`](../eval/studio-findings.md) | Measured results: fidelity, naming, speed, cost, refusals, live runs |
| [`eval/showcase/README.md`](../eval/showcase/README.md) | Showcase-set spike decisions and evidence |
| [`public/landing/README.md`](../public/landing/README.md) | Where each landing image comes from |
| [`.env.example`](../.env.example) | Every environment variable, with safe local defaults |
