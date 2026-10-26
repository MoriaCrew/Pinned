# Pinned — AI SDLC: Linear → Agent → PR → Review (solo developer)

_One human (Robin) steers; Muse coordinates; coding agents execute
one Linear issue at a time. This doc is the operating system for the
10 days. If a step here slows delivery without protecting quality, cut
the step — and amend this doc in the same PR._

## 1. Systems of record

| Concern | Home | Rule |
| --- | --- | --- |
| What to build & status | Linear team **PIN** (Pinned) | No Linear issue → no code (except typo/docs hotfixes, still PR'd) |
| Code, prompts, docs | GitHub `MoriaCrew/Pinned` (public) | `main` is always deployable |
| Requirements/architecture | `docs/01`, `docs/02` in repo | FR/NFR IDs cited in issues + PRs |
| Secrets | Host env + GitHub Actions secrets | Never in repo, issues, or PRs |
| Demo evidence | Issue comments + README links | Every milestone gate links proof |

## 2. Issue anatomy (every PIN issue)

- **Title:** verb + outcome (e.g. "Judge a submission with rubric + teaser").
- **Body:** Why (FR/NFR IDs) · Scope (in/out) · Acceptance criteria
  (checklist, testable) · AI notes (models/prompts touched, mock behaviour)
  · Test plan. Sized to ≤1 day; split if larger.
- **Labels:** one `area/*` (game, ai, vision, poster, infra, demo, docs)
  + `executor/*` when an agent will run it.
- **Milestone:** M1 Core Loop (Day 4) · M2 Host+Memory (Day 7) ·
  M3 Playtest+Submit (Day 10).

## 3. The loop (per issue)

1. **Pick up:** move issue → *In Progress*; create branch
   `PIN-{n}/short-slug` from `main` (e.g. `PIN-7/rubric-judging`).
2. **Build (agent):** implement scope only; prompts versioned under
   `prompts/`; new AI calls go through `ModelGateway` with a mock;
   add/adjust tests per the issue's test plan. Agent commits in small,
   named steps; never rewrites history on shared branches.
3. **PR:** open against `main` using the PR template: Linear link,
   FR/NFR IDs, what changed, test evidence (commands + output), AI/cost
   impact, screenshots for UI, rollback note. CI must be green.
4. **Review (human = Robin, assisted by Muse):** check acceptance
   criteria one by one on the preview deploy; request changes on the PR,
   not in chat. Solo rule: no self-merge without (a) green CI, (b) a
   preview click-through, (c) PR description evidence filled in.
5. **Merge & update:** squash-merge; production deploy from `main`;
   smoke the golden path; move Linear issue → *Done* with PR + deploy
   links and any follow-up issues filed. Branch deleted.
6. **Daily steer (Muse):** re-rank backlog against milestone gates,
   flag scope creep against the Day-5 pivot gate and Nov-3 freeze.

## 4. Branch, commit & PR conventions

- Branches: `PIN-{n}/slug` (agents), `docs/slug`, `fix/slug` (hotfix).
- Commits: imperative, scoped — `feat(game): …`, `feat(ai): …`,
  `fix(vision): …`, `docs: …`, `chore(ci): …`.
- One issue per PR; PRs >~400 lines get split. No direct pushes to
  `main` after Day-1 bootstrap; `main` protected (PR + CI required).

## 5. Agent guardrails (Muse / coding agents)

- Work only the assigned issue's scope; file discoveries as new issues.
- Never call paid models in CI — `AI_MOCK=1` + fixtures; live calls only
  in explicit smoke/eval runs with budget logging.
- Never commit `.env`, keys, original playtest photos, or generated
  posters of real players. Sample assets live in `eval/` (consented).
- Roast-policy and persona system prompts are safety-critical: changes
  require eval-set pass (0 policy violations) noted in the PR.
- If an acceptance criterion can't be met, stop, comment on the issue
  with evidence + options — don't silently narrow scope.

## 6. Ceremonies (15 min/day max, solo-friendly)

- **Morning:** pick today's issues (≤3), confirm milestone gate distance.
- **Evening:** merge or explicitly park every open PR; update Linear;
  note cost-to-date vs $150 budget.
- **Gates:** Day 4 four-phone game · Day 5 guessing keep/cut · Day 7
  rematch-memory check · Nov 3 feature freeze · Nov 4 submit by 21:00 ET.

## 7. Definition of Done

Acceptance criteria ticked with evidence · CI green · preview verified
on a phone viewport · docs/prompts updated if behaviour changed ·
Linear issue closed with PR + deploy links · no new `TODO` without an
issue number.
