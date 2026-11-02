# Pinned — Pre-launch security review (dev / main), 2026-11-01

## Verdict

**GO-WITH-FIXES for publicly promoting the current prod (`pinneds.com`,
billing OFF); NO-GO for merging `dev` → `main` until the billing gates
clear.** The two "promotions" are different acts:

- Tweeting/posting `pinneds.com` today is shippable after the
  before-tweet checklist below (~5–9 h remaining after the fix branch).
- Merging `origin/dev` to `main` is silently the **live-billing launch**
  (PIN-210) and is not ready: Plus is never revoked on refund/chargeback,
  reconciliation is manual and unalerted, and the prod webhook-secret
  pairing has never been exercised end-to-end.

No Critical auth, IDOR, or data-exposure flaw was found. The blockers are
abuse-cost, content-safety/legal readiness, and billing readiness — all
fixable without redesign. Authn/authz design is strong for a hackathon
codebase (see Positives).

## Scope and method

- Baselines: `origin/dev` (92ae41e, launch candidate) and `origin/main`
  (91d01b8, live prod). `src/` is byte-identical between them; the only
  diff is the PIN-210 billing block in `apphosting.prod.yaml` + docs/12.
  Local dirty checkouts were excluded from the verdict.
- Six audit lanes (auth/IDOR, upload/AI abuse, Stripe, GCP/Firebase,
  live probing, best-practice research) + adversarial completeness
  critic, then first-hand parent verification of every load-bearing
  claim (live health probes, deployed env, secret-hash comparison,
  Stripe read-only API, XSS sink grep).
- Live probing: active on `dev.pinneds.com` only (one throwaway test
  board created, slug not retained); prod was GET-only. GCP and Stripe
  access was read-only throughout; no secret value was printed (secret
  checks used lengths, prefix classes, and SHA-256 hash prefixes).
- Hackathon deadline in view: submission Nov 4 (docs/12).

## Three resolved questions

1. **Is prod billing live? NO (deployed), YES on next merge.** Deployed
   prod has no `PLUS_MODE`/Stripe env; `GET pinneds.com/api/health`
   returns `plusMode:off` and the webhook returns 503. `origin/dev`
   adds `PLUS_MODE=stripe` + both secret refs + credits
   `starterMakes:5` to `apphosting.prod.yaml`, and everything Stripe-side
   is already live: catalog price `pinneds_plus_20` EUR 2.99
   (livemode), enabled live webhook endpoint for
   `pinneds.com/api/billing/stripe/webhook` (exact 11 events), populated
   prod Secret Manager. Verified first-hand: the prod Secret Manager
   `STRIPE_SECRET_KEY` is `rk_live_` and resolves the live price; the
   dev one is `rk_test_`. Treat the next promotion as the go-live act.
2. **Prod auth: OPTIONAL, already live** (not link-only).
   `apphosting.prod.yaml` on main sets `AUTH_MODE=optional` +
   `AUTH_SAME_ORIGIN=1`; live health agrees, `/api/me` returns 401,
   `/__/auth/handler` returns 200. Docs claiming "prod today:
   link-only" are stale. The pending promotion changes billing only.
3. **Secrets are properly separated.** `SESSION_SECRET` and
   `META_API_KEY` hashes differ between dev and prod (both 64/48 chars);
   a dev-minted cookie cannot be forged onto prod. (Entropy beyond
   length was not assessed; values were never displayed.)

## Max unauthenticated AI cost exposure

No account or payment is needed to spend AI budget: board creation is
unauthenticated and joining needs only a display name + cookie.
Per-identity caps (~$1.40/day: 20 photos, 150 SAM calls, 100 tap-names,
10 scenes) multiply freely with Sybil identities, so the **global daily
cap is the only real bound — and it can be burned in hour 1** (no hourly
sub-cap). Unit reserves: Spark $0.0170, SAM $0.0025, scene $0.0100,
chips/tap $0.0051; one photo ≈ $0.032 reserved.

- **Prod live: $50/day + 10,000 calls** (judging-week values — note the
  older $2/200 figure is stale, actual is 25×). Worst unauthenticated
  burn ≈ $50 in the first hour (~1,560 photos), then fail-closed
  (photos error, scenes degrade to $0 collages, chips to a fixed list)
  until UTC midnight. Credits are OFF on live prod, so there is no
  per-board makes pool yet.
- **Dev: $5/day + 500 calls.** Worst ≈ $5 in hour 1, then AI is dead
  for every dev user for ~23 h.
- Overshoot above the cap: Spark **input** tokens are never reserved
  (est. +5–15% on photo-heavy traffic), plus any provider-billed
  retried/timed-out attempts and the dev lab race (below). The reserve
  counter itself cannot exceed the cap (single Firestore transaction).

## Findings (ranked)

### Critical (legal/safety) — before any promoted post

**F1. No content moderation, no report/takedown flow, no CSAM runbook.**
Only Meta's own refusals gate uploads; an explicit/illegal photo that
Spark names and SAM segments becomes a permanent cut-out served to any
link holder. Terms prohibit illegal content but there is no in-app
Report path, no monitored abuse contact/DSA point, and no documented
quarantine-preserve-report procedure (NCMEC CyberTipline / DSA Art. 16
class duties; jurisdiction needs qualified review — this is a controls
flag, not legal advice). One troll on a promoted post is the highest
weekend risk. Minimum fix (2–4 h): Report-board link, monitored abuse
mailbox during launch, 1-page runbook; plus upload-consent interstitial
("only share photos you have permission for; anyone with this link can
see them") + 24 h takedown commitment (1 h, mind the 7 locales).

### High

**F2. Per-IP limits were XFF-spoofable — FIXED on branch
`sec/pre-launch-fixes`.** `CLIENT_IP_TRUSTED_HOPS` was unset on both
backends (confirmed in deployed Run env), so the rate-limit key was the
client-controlled first `X-Forwarded-For` entry. Proven live on dev:
after a board-create 429, rotating XFF restored a fresh bucket. This
defeated board-create, join, upload, auth, checkout and lab brakes,
the maker free-boards rule, and the PIN-lockout IP leg — and it is what
makes the hour-1 budget burn practical. Fix: `CLIENT_IP_TRUSTED_HOPS=2`
(lab-measured `fahIndexFromRight=2`) in both yamls. After deploy,
re-probe `GET /api/lab/client-ip` on dev (`configuredHops: 2`) and
re-run the spoof test. Residual: the limiter is in-process, so limits
still multiply × instances (×4 prod).

**F3. Plus is never revoked on refund/dispute (blocks merge).** Makes
are clawed back correctly, but Plus itself is permanent: pay EUR 2.99
→ Plus forever + spend 20 makes → full refund/chargeback → board keeps
free Plus. Repeatable across boards. Implement revocation on full
refund / lost dispute (4–8 h + tests) **or** keep prod billing off.
Deliberately not rushed in this review.

**F4. No GCP budget guardrail.** `gcloud billing budgets list` on the
shared billing account is empty. App-level AI caps fail closed, but
Cloud Run/Firestore/Storage spend and the Meta account have no alert
or kill-switch, and an hour-1 burn kills the judges' AI for the day.
Read-only audit could not create these; commands are in the checklist.

### Medium

- **F5 (dev-only).** Unauthenticated SAM lab (`PINNED_LAB=1`,
  `POST /api/lab/sam`) burns live Meta spend **outside** the atomic
  budget reserve (non-atomic pre-check; concurrent calls race). Prod
  correctly 404s. Route through the reserve, gate behind auth, or
  remove `PINNED_LAB` from the shared dev backend (1–2 h). The F2 fix
  restores its per-IP brake meanwhile. Lab 500s leak `error.message`.
- **F6.** Billing config holes — **FIXED on the branch**: checkout
  could sell without `STRIPE_WEBHOOK_SECRET` (paid-never-granted), and
  nothing checked key livemode vs environment. `PLUS_MODE=stripe` now
  requires key + webhook secret and honours
  `STRIPE_EXPECTED_LIVEMODE` (dev `test`, prod `live`), failing closed
  to off. Webhook 1 MiB cap also now enforced on bytes read, not only
  `Content-Length`.
- **F7.** Reconciliation (`npm run billing:reconcile`) is manual,
  unscheduled, and refund/dispute-blind; dead letters return 200 and
  sit unalerted. Schedule + alert before merge (2–4 h).
- **F8.** 4-digit reclaim PINs stored as fast `sha256` (no KDF/salt):
  a DB leak means instant offline crack → participant impersonation.
  Online lockout is solid. Post-hackathon KDF migration (4–6 h).
- **F9.** Durability/depth debt: no CSP (Report-Only first), Firestore
  PITR + delete-protection OFF, bucket UBLA off / public-access
  prevention inherited, primitive Editor on default service accounts
  (runtime SA itself is least-privilege; zero SA keys anywhere), npm
  prod Highs in postcss/grpc-js (build/client-side; fixes available),
  stateless 30-day user cookie with no server revocation, several
  POSTs rely on SameSite=Lax without explicit cross-site guards,
  hidden-scene metadata visible to link holders, chips lack a
  per-participant cap, tap-add lacks a rate limit, unbounded JSON
  bodies on scenes/chips/tap-add.

### Low

Dormant `BASETEN_API_KEY`/`MODAL_*` copies in prod Secret Manager
(delete); `tmp/` lifecycle drift (deployed 14 d vs repo 1 d); prod
`minInstances` drift (yaml 1 vs deployed 0 — judge cold starts);
GitHub Actions pinned to tags not SHAs; no `robots.txt` /
`security.txt`; `/api/health` discloses mode enums; `/billing/return`
intent UUID resolves the board slug indefinitely; SAM `store` flag
unset (provider-default retention vs docs claim); local `.env.local`
holds a standing live-mode restricted Stripe key (machine-compromise
blast radius — prefer just-in-time fetch); stale docs (prod auth mode,
prod AI budget).

## Positives (why not NO-GO)

128-bit board slugs with uniform 404s (no enumeration oracle observed);
deny-all Firestore/Storage rules **deployed == repo** (verified via
rules API); HMAC hash-bound participant cookies (reissue revokes);
256-bit host tokens; fresh-auth claim/restore; provider allowlist
(google.com only); `/__/auth` proxy pinned to the own project; every
API route inventoried with its auth check — none missing; clean
service-layer IDOR re-verification; atomic fail-closed budget reserve
with per-attempt SAM reservation and claim-before-call idempotency;
magic-byte photo intake with EXIF strip, 40 MP cap, originals never
stored; Stripe raw-body signature verification, layered idempotency,
server-side pricing, slug never sent to Stripe; no secrets in git
history (fixtures only); Cloud Run reachable only via the App Hosting
front door; no `dangerouslySetInnerHTML` anywhere (stored-XSS grep
clean — live payload exercise still recommended, see Unknowns).

## Dev vs prod at a glance

| | Dev (`dev.pinneds.com`) | Prod (`pinneds.com`) |
| --- | --- | --- |
| Project | `moriacrew-pinned-dev` | `moriacrew-pinned-prod` |
| Code | `origin/dev` | `origin/main` (`src/` identical) |
| Auth | optional + same-origin | optional + same-origin (already live) |
| Billing | Stripe **test** ON | **OFF**; merge turns **live** EUR 2.99 on |
| AI budget | $5 / 500 calls per day | $50 / 10,000 per day (judging week) |
| Lab routes | OPEN (`PINNED_LAB=1`) | closed (404 verified) |
| Scale | 2 inst / 512 MiB | 4 inst / 1024 MiB, deployed minScale 0 |

## What was fixed in this review

Branch `sec/pre-launch-fixes` (local, **not pushed**; commit `d3ed2dd`
on top of `origin/dev`, worktree `Pinned-secfix/`):

1. `CLIENT_IP_TRUSTED_HOPS=2` on both backends (F2).
2. `PLUS_MODE=stripe` requires `STRIPE_SECRET_KEY` **and**
   `STRIPE_WEBHOOK_SECRET`; new `STRIPE_EXPECTED_LIVEMODE` guard
   (dev `test`, prod `live`) in `src/config.ts` (`parsePlusMode`),
   with unit tests in `src/config.test.ts` (F6).
3. Webhook byte cap enforced post-read in
   `src/app/api/billing/stripe/webhook/route.ts` (F6).
4. `.env.example` documents the pair + livemode vars.

Verification: `npm run typecheck` clean; full `npm test` 1787 passed,
2 failed — both pre-existing on clean `origin/dev` (`src/ui/tokens.test.ts`
build-command failure, `board-scroll.test.ts` source assertion),
proven by re-running them with the fix stashed. Edited yamls parse.
Deploy note: App Hosting rebuilds on push; after rollout, verify with
the lab probe + XFF spoof test, and `curl .../api/health` on both hosts.

## Checklist A — before the promoted post (billing stays OFF)

Effort excludes review/legal sign-off. Item 1 is done on the branch
(needs your push/PR + rollout to take effect).

1. [~0.5 h] Push/PR `sec/pre-launch-fixes`, roll out dev then prod,
   re-probe client-IP (F2/F6 take effect only once deployed).
2. [2–4 h] Report-board link + monitored abuse mailbox + CSAM/illegal
   content 1-page runbook (quarantine via admin, preserve evidence,
   NCMEC CyberTipline, never redistribute) (F1).
3. [1 h] Upload-consent interstitial + takedown commitment in Terms;
   launch copy must say "anyone with the link sees the board" (F1).
4. [1–3 h] GCP budget alerts at 50/90/100% to on-duty humans +
   rehearsed soft kill, e.g.:
   `gcloud billing budgets create --billing-account=0196B0-F6012B-BD9416 --display-name="Pinned prod guard" --budget-amount=150EUR --threshold-rule=percent=0.5 --threshold-rule=percent=0.9 --threshold-rule=percent=1.0 --filter-projects=projects/moriacrew-pinned-prod`
   (adjust amount/currency; repeat for dev). Soft kill drill: set
   `AI_DAILY_BUDGET_USD=0` (or `AI_MOCK=1`), roll out, time it;
   hard kill is `PLUS_MODE=off` (billing) or maxInstances 0. Fire one
   test alert per channel to a named human on duty during judging.
5. [1–2 h] Protect the judges: hourly AI sub-cap or lower prod $50
   after judging week, demo-board reserved makes/Plus purchased,
   reseed script on standby, **never post the demo-board link
   publicly** (post the landing page; demo link only in the
   submission form). Consider fixing prod `minInstances` drift.
6. [1–2 h] Gate the dev SAM lab (reserve/auth/remove flag) (F5).
7. [1–2 h] Stored-XSS live exercise: plant a benign marker payload in
   display name, board title, Spark label, scene prompt on a dev board
   and view as host (grep is clean; CSP is absent, so prove it live).
   Optional same window: CSP Report-Only.

## Checklist B — before merging `dev` → `main` (= billing go-live)

1. [4–8 h] Revoke Plus on full refund / lost dispute + tests (F3).
2. [0.5–1 h] Prove webhook-secret pairing: Stripe Dashboard "Send test
   event" to the live endpoint after a **dev-first** rollout of the
   fix branch, then one real EUR 2.99 buy + refund on prod post-merge
   with `PLUS_MODE=off` rollback rehearsed. Check the live endpoint's
   delivery history for accumulated 503s from the billing-off era.
3. [2–4 h] Schedule `billing:reconcile`, alert on
   `deadLetterTotal > 0` and webhook delivery failures (F7).
4. [0.5 h] Confirm live endpoint URL, Radar defaults, statement
   descriptor, VAT handling for the EUR digital sale in Dashboard.
   (Key livemode/account pairing is already verified; the runtime
   guard ships in the fix branch.)

## Checklist C — post-hackathon hardening

Enforcing CSP (6–12 h + soak); distributed rate limiter + Turnstile on
board-create/upload/scene (App Check monitor-only adds little while
rules deny all — protect the Next.js routes instead) (8–14 h);
automated upload moderation (SafeSearch/classifier) (6–10 h); PIN KDF
(4–6 h); Firestore PITR + delete-protection, UBLA + enforced public-
access prevention, remove default-SA Editor, delete dormant prod
secrets (4–8 h); Spark input-token reservation + chips cap + tap-add
limit (2–4 h); board-link revoke/expiry (4–8 h); GDPR export/erasure
for link users (8–16 h); npm High fixes; SHA-pin GitHub Actions;
`robots.txt` + `security.txt`; fix lifecycle (1 d) and `minInstances`
drift; refresh stale docs (prod auth, prod budget).

## Unknowns that remain (could not be proven read-only)

- Prod webhook **secret value** pairing (Stripe never returns it) —
  only a test delivery / live smoke proves it (Checklist B2).
- Live XSS payload exercise, two-user Google sign-in/claim/restore
  exercise, delete/erasure orphan check, load test of the single-doc
  AI budget + ledger under viral concurrency, alert-delivery proof,
  rollback timing — all need the live drills in the checklists.
- Firebase console state (authorized domains, OAuth redirect URIs,
  browser key restrictions, App Check enforcement) — verify against
  docs/13-auth.md; server-side provider allowlist limits blast radius.
- Whether dev+prod share one Meta account quota (keys differ per
  project Secret Manager, but account-level caps live in the Meta
  dashboard) and Meta's retention/training terms vs the privacy page
  (incl. SAM `store` default) — read the DPA before scaling promotion.
- Deployed images were matched to git by env/behaviour, not by build
  provenance attestation; per-board stored policy overrides in
  Firestore were not enumerated (deployed env shows no global
  `POLICY_OVERRIDES_JSON` on prod, credits-only on dev).
- Platform request logs retain `/g/{slug}` capability URLs by design
  of the platform; restrict `logging.viewer` accordingly (app logs
  themselves redact slugs).

*Method note: findings synthesize six independent audit lanes plus an
adversarial critic; every load-bearing claim above was re-checked
first-hand. Severities are launch-risk ratings for a public promoted
post, not CVSS scores. Legal items flag controls, not legal advice.*
