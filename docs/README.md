# Docs index

One line per document, in reading order for a first-time visitor. Start with the repo
[`README.md`](../README.md), then [`19-meta-models.md`](19-meta-models.md) for how each
Meta model is used and [`11-studio.md`](11-studio.md) for the spec. Internal runbooks for
whoever runs the hosted service are grouped near the end; the archive holds the photo game
Pinneds started as. Numbers 01, 02, 05, 08 and 09 are archived with that game; 04 was
removed before the pivot.

## Start here

| Doc | What it covers |
| --- | --- |
| [`README.md`](../README.md) | What Pinneds is, how the Meta models power it, the architecture, how to run it, known limits |
| [`19-meta-models.md`](19-meta-models.md) | Each Meta model: prompt and version, Policy keys, inputs, fallbacks, cost, evidence, what leaves the server |
| [`11-studio.md`](11-studio.md) | Studio spec: product, decisions, Policy, ports, jobs, data model, storage, UX, test plan, issue map |
| [`adr/003-studio-architecture.md`](adr/003-studio-architecture.md) | ADR-003: Policy as data, capability ports and decorators, jobs, Element/Pin split, stateless remix |
| [`build-log.md`](build-log.md) | Who built what: each coding agent's PRs with dates, the evidence for each claim, and what the record does not show |

## Product and features

| Doc | What it covers |
| --- | --- |
| [`06-photo-intake.md`](06-photo-intake.md) | Photo intake: checks, EXIF stripping, the short-lived working copy, what is never stored |
| [`14-design-system.md`](14-design-system.md) | The Pinneds design system: look, words, UI kit, landing showcase sets |
| [`13-auth.md`](13-auth.md) | Optional Google sign-in (`AUTH_MODE`), claim flow, My boards and My pins, delete and rename |
| [`15-board-plus.md`](15-board-plus.md) | Board Plus and creations: `PLUS_MODE`, Stripe Checkout, webhook grants, ledger |
| [`16-ai-usage.md`](16-ai-usage.md) | AI call log, cost estimate per operation, collage reasons, usage report |
| [`18-i18n.md`](18-i18n.md) | UI languages: how a request picks one, `UI_LOCALES`, adding strings, translation runs |
| [`17-showcase-sets.md`](17-showcase-sets.md) | Recipe for making a landing showcase set with the app's own pipeline |
| [`adr/004-report-and-hold.md`](adr/004-report-and-hold.md) | ADR-004: reports hold first (reversibly), the operator decides, timed takedown only for face-flagged likeness reports, no model as judge |
| [`12-submission.md`](12-submission.md) | Hackathon submission packet: pitch, evidence table, video plan, form answers |

ADR-001 (hosting) and ADR-002 (no friction) still stand; they live in the archived
[`archive/02-architecture.md`](archive/02-architecture.md).

## Measurements and lab notes

| Doc | What it covers |
| --- | --- |
| [`../eval/studio-findings.md`](../eval/studio-findings.md) | Measured results: fidelity, naming, speed, cost, refusals, live runs |
| [`../eval/showcase/README.md`](../eval/showcase/README.md) | Showcase-set spike decisions and evidence |
| [`07-sam-lab.md`](07-sam-lab.md) | SAM 3.1 lab notes and measurements (`/lab/sam`, dev only) |

## Internal runbooks (operators only)

For whoever runs the hosted service. A visitor can skip them.

| Doc | What it covers |
| --- | --- |
| [`DEPLOY.md`](DEPLOY.md) | Environments, env matrix, pre-flight, promotion to `main`, smoke, judging week |
| [`launch-ops-runbook.md`](launch-ops-runbook.md) | Launch ops: hourly AI sub-cap, GCP budget alerts, soft-kill drill, demo-board protection |
| [`20-abuse-runbook.md`](20-abuse-runbook.md) | Abuse reports and illegal content: the in-app report and its automatic hold, the operator's decide script, the manual hold path, NCMEC CyberTipline, takedown clock |
| [`security-review-2026-11-01.md`](security-review-2026-11-01.md) | Pre-launch security review (Nov 1) with the status of each finding and the fixes that closed it |
| [`10-custom-domains.md`](10-custom-domains.md) | pinneds.com and dev.pinneds.com domain setup |
| [`03-ai-sdlc.md`](03-ai-sdlc.md) | How work flows: Linear issue, coding agent, PR, review, for a solo developer |

## Archive (`docs/archive/`, history only)

The photo game Pinneds started as was dropped on Oct 28, 2026. These pages are kept for
the record; do not apply them.

| Doc | What it covers |
| --- | --- |
| [`archive/01-requirements.md`](archive/01-requirements.md) | Day-1 requirements for the game (FR/NFR IDs) |
| [`archive/02-architecture.md`](archive/02-architecture.md) | Game architecture, including ADR-001 and ADR-002 |
| [`archive/05-research-synthesis.md`](archive/05-research-synthesis.md) | Day-1 research synthesis |
| [`archive/08-ux-principles.md`](archive/08-ux-principles.md) | First minimal, icon-first UX rules (superseded by `14-design-system.md`) |
| [`archive/09-design-system.md`](archive/09-design-system.md) | Per-board looks and themes from the game era (superseded by `14-design-system.md`) |

## Key files outside `docs/`

| File | What it covers |
| --- | --- |
| [`SECURITY.md`](../SECURITY.md) | Public-repo guardrails: never-commit list, scanners, leak runbook, repository settings |
| [`AGENTS.md`](../AGENTS.md) | Rules for coding agents working in this repo |
| [`prompts/README.md`](../prompts/README.md) | Prompt contracts and the list of versioned templates |
| [`eval/README.md`](../eval/README.md) | Rules for evaluation fixtures (synthetic only, source noted) |
| [`public/landing/README.md`](../public/landing/README.md) | Where each landing image comes from |
| [`.env.example`](../.env.example) | Every environment variable, with safe local defaults |
