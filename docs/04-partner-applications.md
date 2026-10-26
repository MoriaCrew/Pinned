# Pinned — Inference-Partner Applications (copy-paste pack)

_Goal: submit Baseten + Modal on Day 1 using the public repo, keep
Fireworks as fast-follow. Primary inference stays on the Meta Model API
($150 hackathon credits); partners provide the Muse Spark Open /
open-weights path, overflow capacity and GPU jobs. Fill bracketed fields
before sending. Do not paste API keys into applications._

## Shared facts (reuse verbatim)

- **Project:** Pinned — one link, one async photo game for group chats,
  hosted by a generated AI persona. No install, no account.
- **Event:** Meta Global AI Developer Hackathon (Meta × Cerebral Valley),
  Oct 26–Nov 4, 2026 · Indie Developer track · Theme: Build for Your World
  · Solo developer · Accepted participant.
- **Repo (public):** https://github.com/MoriaCrew/Pinned
- **Org:** https://github.com/MoriaCrew · **Event:**
  https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details
- **Meta models used:** Muse Spark (persona, vision judging, diary),
  SAM 3.1 (object cut-outs), Muse Image (poster backgrounds) via Meta
  Model API; Muse Spark Open (open weights) as the partner-hosted path.
- **Expected load (hackathon):** bursty, tiny — dozens of games, ≤12
  photo submissions/game; per submission ≈1 vision judge call + 1
  segmentation; per game ≈1 persona + 1 poster + 1 diary call. Peaks
  during playtests (Days 8–9) and judging (Nov 4–8). No training; inference
  only (Modal: occasional GPU batch for segmentation/poster experiments).

## 1) Baseten — application draft

**What are you building?**
Pinned is a link-based party game for group chats, built solo for the
Meta Global AI Developer Hackathon (Indie track, Build for Your World).
A creator describes an AI host in one line; Muse Spark generates the
persona and judges async photo submissions against a published rubric,
SAM 3.1 cuts out each submitted object for a fair guessing reveal, and
Muse Image paints the shareable winner poster. Public repo:
https://github.com/MoriaCrew/Pinned (requirements + architecture in
`docs/`).

**How will you use Baseten?**
Hosted inference for Muse Spark Open (open weights) behind our
provider-agnostic ModelGateway: (a) fallback/overflow for persona +
judging calls if Meta Model API throttles during playtests/judging,
(b) A/B comparison of hosted Spark vs Spark Open on our 20-photo eval
set (judgement quality, latency, cost/game). OpenAI-compatible endpoint
preferred; no fine-tuning, no training on player data.

**What do you need?** Hackathon partner credits + rate-limit headroom
for bursty playtests (reported partner offer: $100 + 2M TPM for select
participants). Timeline: integration Days 1–3, playtests Days 8–9,
submission Nov 4, judging Nov 4–8.

## 2) Modal — application draft

**What are you building?** _(Same project paragraph as Baseten above.)_

**How will you use Modal?**
Serverless GPU jobs around the core Meta Model API path: (a) batch
segmentation/poster experiments and eval-set runs (20-photo golden set:
cut-out quality, roast-policy checks, cost/game), (b) self-hosted
open-weights experiments (SAM-family / Spark Open quantised variants)
if API segmentation quality or latency needs a fallback, (c) scheduled
jobs (deadline closing, poster composition) if we outgrow the web host's
cron. All player-photo processing is ephemeral; originals are deleted
after cut-out derivation.

**What do you need?** Hackathon partner credits (reported: $100 for
select participants) for Endpoints / serverless GPUs during Oct 26–Nov 8.
Solo developer; usage is small and bursty (see Shared facts).

## 3) Fireworks AI — fast-follow draft (submit if Baseten stalls)

**What are you building?** _(Same project paragraph.)_
**Use:** OpenAI-compatible hosted inference for Muse Spark Open as the
gateway fallback for persona/judging; eval-set comparisons vs Meta Model
API. **Ask:** hackathon partner credits (reported: $25 + workshop for
select participants). Same timeline/load as above.

## 4) Meta Model API — Day-1 checklist (not an application; do first)

- [ ] Claim hackathon $150 credits; create Standard-mode API key
      (avoid Contributor mode for real player photos).
- [ ] Smoke-test from a script (`PIN-3`): Spark chat (persona JSON),
      Spark vision (object label + rubric), SAM 3.1 (cut-out), Muse
      Image (poster background). Log latency + cost for each.
- [ ] Store key in local `.env` + host/GitHub secrets only. Record
      base URL + model IDs in `docs/02-architecture.md` ADR.

## Application tracker

| Partner | Status | Submitted | Credits/key | Gateway wired | Issue |
| --- | --- | --- | --- | --- | --- |
| Meta Model API | ☐ claim Day 1 | — | $150 (hackathon) | ☐ | PIN-3 |
| Baseten | ☐ submit Day 1 | | | ☐ | PIN-4 |
| Modal | ☐ submit Day 1 | | | ☐ | PIN-4 |
| Fireworks | ☐ fast-follow | | | ☐ | PIN-4 |

_Update this table in the PR that wires each provider; never record key
values here — only where the secret lives (e.g. "GitHub Actions secret")._
