# Security — public-repo guardrails for Pinned

This repository is **public for its entire life**. Anything committed is
world-readable forever, including in git history after deletion. These
rules exist so one tired commit at 1am cannot leak a key or a person's
photo. They apply to the human operator and to coding agents alike.

## The four gates (defence in depth)

| Gate | Where | What it does |
| --- | --- | --- |
| 1. Pre-commit | Your machine (`.pre-commit-config.yaml`) | Gitleaks + private-key/large-file hooks block the commit |
| 2. Push protection | GitHub (enabled on this repo) | GitHub rejects pushes containing recognised secrets |
| 3. CI secret scan | Every PR/push (`.github/workflows/secret-scan.yml`) | Gitleaks scans full history; any hit fails the build |
| 4. Platform scanning | GitHub secret scanning + alerts | Continuous rescan of history, issues and PR text; alerts on new patterns |

Setup per clone: `pre-commit install` (see `AGENTS.md`). Never bypass a
gate with `--no-verify`, force-push, or an allowlist edit in the same PR
as the code it unblocks — allowlist changes need their own reviewed PR.

## Never commit (any branch, any file, any commit message)

- API keys, tokens, passwords, session secrets (Meta, Baseten, Modal,
  Fireworks, DB, storage) — values live only in local `.env`, host env,
  GitHub Actions secrets. `.env.example` holds names with empty values.
- Private keys/certs (`*.pem`, `*.key`, `*.p12`), credential JSON,
  `.env*` files other than `.env.example`.
- Personal data: real player photos (originals *or* cut-outs), names +
  photos together, emails, chat screenshots with identities. Test assets
  in `eval/` must be consented samples, clearly synthetic where possible.
- Full request/response dumps from live AI calls containing user content.
  Log shapes, counts, latency and cost — redact payloads (`--redact`).

## If something leaks anyway — rotate first

1. **Revoke/rotate the credential immediately.** Deleting the file or
   rewriting history does not un-leak a key; rotation does.
2. Check the provider's usage logs for abuse; note the window.
3. Then clean up: remove the secret, and only if it was a credential
   that *cannot* be rotated (personal data), purge history and ask
   GitHub Support to drop cached views. Personal photos: treat as
   incident — inform the person, purge, document in Linear.
4. Record what happened (no secret values) in the relevant Linear issue.

## Reporting

Found a secret or personal data in this repo? Contact the owner via
GitHub (@Robin-ELM) — please do not open a public issue quoting it.
