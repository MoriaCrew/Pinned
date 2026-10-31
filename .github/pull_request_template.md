## Linear

- Issue: PIN-<!-- n only. No Linear URL: this repo is public, Linear is private (see docs/03 §4). -->

## Requirements

- Satisfies: `docs/11-studio.md` section(s) <!-- e.g. 5.2 --> (see `docs/adr/003-studio-architecture.md`)

## What changed

<!-- One short paragraph + bullet list. Scope only; link follow-up issues for anything deferred. -->

## Test evidence

<!-- Paste the exact commands run and their outcome. CI green is necessary, not sufficient. -->

- [ ] Bugbot review finished and every finding triaged (fix / follow-up PIN / justified dismissal in-thread):
- [ ] Unit / contract tests:
- [ ] Preview click-through (phone viewport) for UI changes:
- [ ] Phone-viewport screenshots attached (UI changes):

## AI / cost impact

<!-- Models + prompt versions touched; mock behaviour; expected calls per photo/scene; fixture or spike result if prompts changed. Write "None" if no AI surface changed. -->

## Safety & privacy

- [ ] No secrets, `.env`, or real personal photos in this diff
- [ ] `pre-commit` (gitleaks) ran; no `--no-verify`
- [ ] Limits come from `Policy` (no new numeric literals), or N/A
- [ ] New UI strings are in `en.json` only (no other locale or `*.lock.json` edits), or N/A
- [ ] Originals-never-persisted invariant intact (or N/A — say why)
- [ ] Prompts untouched, or version bumped and evidence noted above

## Rollback

<!-- How to revert safely (usually: revert this PR; note any migration/data caveat). -->
