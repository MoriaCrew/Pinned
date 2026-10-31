# Pinneds — AI SDLC: Linear → agent → PR → `dev` → `main`

_One human (Robin) steers; coding agents (Claude Code, Muse Code,
Cursor) execute one Linear issue at a time. If a step slows delivery
without protecting quality, cut it and amend this doc in the same PR.
Agent rules: [`AGENTS.md`](../AGENTS.md); environments and promotion:
[`DEPLOY.md`](DEPLOY.md)._

## 1. Systems of record

- **Linear** (team PIN, private): what to build and status. No issue,
  no code; typo and docs hotfixes are still PR'd. Issue body:
  Outcome · Scope · Checks · Stop conditions, about a day or ~400
  changed lines (split if larger). Labels: one `area/*` and one
  `executor/*` (`claude`, `muse`, `cursor`, `operator`).
- **GitHub** `MoriaCrew/Pinned` (public): code, prompts, docs. `dev`
  integrates; `main` is prod. Spec and decisions: `docs/11`,
  `docs/adr/003`; cite sections in issues and PRs.
- **Secrets:** host env, Secret Manager, GitHub Actions secrets.
  Never in the repo, issues or PRs.

## 2. The loop (per issue)

1. **Pick up:** issue → *In Progress*; branch `PIN-{n}/short-slug`
   from `dev`.
2. **Build:** scope only. Limits from `Policy`, AI calls only through
   gateway ports with a mock, prompts versioned in `prompts/`, new UI
   strings in `en.json` only. Small named commits.
3. **PR to `dev`**, titled `PIN-{n}: …`, with
   [the template](../.github/pull_request_template.md) filled: short
   issue ID, `docs/11` sections, exact test commands and results,
   AI/cost impact, phone screenshots for UI, rollback.
4. **Gates:** CI (typecheck, tests, build), gitleaks and Cursor Bugbot
   must all have *finished* green; pending is not a pass (PR #1 merged
   at 15:20 and Bugbot landed a real Medium finding at 15:23). Triage
   every finding in-thread: fix, follow-up issue, or written
   dismissal. Medium+ security findings block merge.
5. **Squash-merge to `dev`**, delete the branch, move the issue to
   *Done* with the PR number and any follow-ups filed.

## 3. Promotion: `dev` → `main`

Robin promotes; an agent never merges to `main`. After a hosted smoke
on the dev backend (`dev.pinneds.com`: add a photo, make a scene,
remix, share, `/api/health`), Robin squash-merges a promotion PR into
`main`, the only method the `Protect main` ruleset allows (squash,
linear history; `SECURITY.md`). The first Studio promotion is a plain
`dev` → `main` PR; later ones are cut from `main` with `dev`'s tree
restored on top so they never conflict (`DEPLOY.md` §4). Prod builds
automatically from `main` (`pinneds.com`). Per-environment settings
and rollback: `DEPLOY.md`.

## 4. Conventions and guardrails

- Branches `PIN-{n}/slug`; no direct pushes to `dev` or `main`.
  Commits are imperative and scoped: `feat(ai): …`, `fix(board): …`,
  `docs: …`, `chore(ci): …`. One issue per PR.
- **Public-link hygiene:** the repo is public, Linear is private.
  Commits, PRs, code and docs carry only the short `PIN-n` ID, never
  a full Linear URL (it leaks the title slug and dead-ends judges at
  a login wall).
- No paid model calls in CI (`AI_MOCK=1` plus fixtures); live calls
  only when an issue asks, with spend recorded. No `.env`, keys or
  real personal photos in git; a firing scanner means rotate first
  (`SECURITY.md`). Secrets, console and DNS steps are
  `executor/operator` (Robin).
- If a check cannot be met, stop and comment on the issue with
  evidence and options; never silently narrow scope.

## 5. Definition of done

Checks ticked with evidence · CI, gitleaks and Bugbot green · UI
checked on a phone viewport · docs and prompts updated if behaviour
changed · issue closed with the PR number · no new `TODO` without an
issue number.
