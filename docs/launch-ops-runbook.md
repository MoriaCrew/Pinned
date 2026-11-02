# Launch ops runbook (PIN-240)

_Owner: Robin (operator). Launch guardrails for judging week:
the hourly AI sub-cap, GCP budget alerts, the soft-kill drill,
alert test-fires and demo-board protection. Context:
`docs/security-review-2026-11-01.md` findings F4 and checklist A
items 4–5; deploy mechanics in `docs/DEPLOY.md`._

**Operator-only steps.** Creating GCP budgets, notification
channels or uptime checks, and pushing env changes, are operator
actions in GCP/GitHub consoles. Coding agents document these
steps; they do not run `gcloud` writes. Never paste secret
values, board slugs or signed URLs into this repo, a PR or
Linear.

## 1. AI caps in place

All three caps are enforced atomically before every provider
call (reserve in `src/gateway/budget.ts`, one Firestore counter
doc per UTC day; the in-memory backend matches). A denied
reserve means no provider call: scenes fall back to an honest
collage, photo uploads say the AI budget is used up, and the
denial is logged as a `denied_*` AiCallLog row.

| Cap | Env | Dev | Prod (judging week) | Denial |
| --- | --- | --- | --- | --- |
| Daily spend | `AI_DAILY_BUDGET_USD` | 5 | 50 | `budget` |
| Daily calls | `AI_DAILY_CALL_LIMIT` | 500 | 10000 | `call_limit` |
| Hourly spend (PIN-240) | `AI_HOURLY_BUDGET_USD` | 2 | 15 | `hourly_budget` |

Hourly sub-cap rules:

- It is a **sub-cap inside the daily cap**: the day counter
  (`reservedMicroUsd`) also holds `hourBucket` +
  `hourReservedMicroUsd` (UTC hour, e.g. `2026-11-04T14`). When
  the hour rolls, the hour accumulator resets inside the same
  transaction; the daily total keeps climbing and stays
  authoritative — a call that fits the hour but busts the day is
  denied `budget`, never allowed by the hour.
- **0 or unset = off** (the code default): behaviour is exactly
  the daily cap alone, as before PIN-240. Hosted values above
  are operator-tunable judging-week settings.
- `AI_HOURLY_BUDGET_USD=0` is **not a kill switch** — it only
  removes the hourly limit. To stop AI spend use section 4.
- If judges hit `denied_hourly_budget` rows in the AI log while
  the day still has plenty left, raise the hourly value (a
  config-only rollout); if one actor is burning the pool, lower
  it instead. A photo is ~7 calls, a scene 1 call.

## 2. GCP budget alerts (operator creates, per project)

A GCP budget is an **alert, not a cap**: reaching 100% emails
people; it does not stop Cloud Run, Firestore, Storage or Meta
spend by itself (Meta spend is not on GCP billing at all — see
section 6). The app-level caps above are the actual AI bound;
these budgets catch everything else (runaway instances, reads,
egress) early enough for a human to pull section 4.

Prerequisites: Billing Account Administrator (or Costs Manager)
on the billing account, `gcloud` logged in. Find the billing
account id read-only, then create one budget per project.
Amounts below are monthly EUR starting points — adjust to the
card limit you are comfortable with before running.

```sh
# Read-only: list billing accounts, note the shared account id.
gcloud billing accounts list
BA=<BILLING_ACCOUNT_ID>

# Prod guard (judging month): alerts at 50% / 90% / 100%.
gcloud billing budgets create --billing-account="$BA" \
  --display-name="Pinned prod guard" \
  --budget-amount=150EUR \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --filter-projects=projects/moriacrew-pinned-prod

# Dev guard: same shape, smaller amount.
gcloud billing budgets create --billing-account="$BA" \
  --display-name="Pinned dev guard" \
  --budget-amount=25EUR \
  --threshold-rule=percent=0.5 \
  --threshold-rule=percent=0.9 \
  --threshold-rule=percent=1.0 \
  --filter-projects=projects/moriacrew-pinned-dev

# Read-only verification: both budgets listed, filters scoped
# to exactly one project each.
gcloud billing budgets list --billing-account="$BA"
```

Then, in the Cloud Console (Billing → Budgets & alerts → each
budget), confirm who gets emailed: by default budget emails go
to billing-account admins. If the on-duty human during judging
is not one of them, connect a Monitoring notification channel
to the budget (Console → the budget → notification settings) so
alerts reach a named inbox that is actually watched that week.
Record both budget names and the alert recipients on the Linear
launch issue.

## 3. Alert test-fire (prove delivery, once per channel)

An alert nobody has seen arrive is not an alert. Before the
public post, fire one test per channel to a **named human on
duty during judging** and record date, time and recipient on
the Linear launch issue. Never test by burning real AI budget.

1. **Budget email:** create a throwaway budget on either
   project with a tiny amount (e.g. `1EUR`) and a
   `percent=0.01` threshold rule, same flags as section 2,
   display name `Pinned alert TEST - delete me`. Normal
   background spend crosses 1% of EUR 1 quickly; wait for the
   email (budget emails are not instant — allow a few hours),
   confirm the right inboxes received it, then **delete the
   test budget** (`gcloud billing budgets delete` with its id,
   or Console) so it cannot mask the real guards.
2. **Monitoring channel** (if one is attached): Console →
   Monitoring → Alerting → notification channel → **Send test
   notification**; confirm receipt.
3. **Uptime check** (`docs/DEPLOY.md` section 6.6): confirm the
   `https://pinneds.com/api/health` check is green and its alert
   policy names the same channel. Do not break prod to test it;
   a green check plus a delivered channel test is the proof.

## 4. Soft-kill drill (rehearse before launch, dev first)

Goal: stop AI (and, separately, billing) spend in minutes,
without breaking existing boards, pins or scenes. Env values
live in `apphosting.dev.yaml` / `apphosting.prod.yaml`; a change
takes effect on the next App Hosting rollout for that backend
(push to `dev` / promotion to `main` per `docs/DEPLOY.md`), so
**time the drill end to end** — that rollout time is your real
kill latency.

| Lever | Effect | Use when |
| --- | --- | --- |
| `AI_DAILY_BUDGET_USD=0` | All live AI denied (`off`); scenes become collages, uploads say AI is off | AI spend runaway or provider incident |
| `AI_MOCK=1` | Same user-visible pause, mock pipeline | Provider down/slow; keep demos moving without live calls |
| `PLUS_MODE=off` | Checkout answers "unavailable", nothing sold | Billing incident (independent of AI) |
| Demo board `dailyBudgetUsd: 0` (Firestore `policyOverrides`, no deploy) | AI off for the demo board only | Demo board abused; fastest, narrowest lever (`docs/DEPLOY.md` section 8) |
| `AI_HOURLY_BUDGET_USD=0` | **Not a kill** — removes the hourly sub-cap only | Never as an incident lever |

Drill steps (dev backend, then read prod values so the prod
change is copy-ready):

1. Note the current values. Start a timer.
2. Set `AI_DAILY_BUDGET_USD` to `"0"` in `apphosting.dev.yaml`,
   push to `dev`, watch the rollout finish (Firebase Console →
   App Hosting → `pinned-web` → Rollouts).
3. Verify: `curl -s https://dev.pinneds.com/api/health` is ok;
   on a throwaway board, a new scene lands as a collage and a
   photo upload is refused with the budget-off line; existing
   boards/pins/scenes still open. Stop the timer, record it.
4. Restore the original value, push, re-verify one live photo +
   one scene succeed.
5. Repeat the same edit shape mentally for
   `apphosting.prod.yaml` (and `AI_MOCK=1`, `PLUS_MODE=off`) so
   the prod diff is a known one-liner during an incident. Hard
   kill, last resort only: `runConfig.maxInstances: 0` takes
   the whole site down — prefer the levers above.

## 5. Demo-board protection

The seeded judge board is a capability link: anyone with it is
on the board. Rules from `docs/DEPLOY.md` sections 6 and 8:

- **Never post the demo-board link publicly** (no social post,
  README, PR, screenshot URL bar or public issue). Post the
  landing page (`https://pinneds.com`); the demo link goes only
  in the hackathon submission form for judges.
- Keep a **reseed standby**: `npm run seed:demo` run twice
  gives the demo board plus an identical backup board. Slugs
  are printed once — record them only in Linear, never in git.
  If the demo board is vandalised or exhausted, point the
  landing demo secret at the backup instead of cleaning up
  live.
- The demo board is a normal board (free creations, then Board
  Plus bought on it per `docs/DEPLOY.md` section 6.4); only the
  join caps are raised by `policyOverrides`. Global daily +
  hourly caps still bound its spend.
- Twice a day during judging: open the demo board, check it
  still looks right and one scene still composes.

## 6. Judging-week checks (twice a day)

- `curl -s https://pinneds.com/api/health` — ok, live AI on.
- Demo board glance (section 5).
- Meta spend (not on GCP billing):
  `GCLOUD_PROJECT=moriacrew-pinned-prod npm run usage:costs -- --days 1`
  (estimates, `docs/16-ai-usage.md`). A rising
  `denied_hourly_budget` count with daily budget still
  available means the hour is the binding cap — raise
  `AI_HOURLY_BUDGET_USD` if legitimate judge traffic is being
  refused, lower it if one actor is draining the pool.
- GCP Console → Billing → Budgets: both guards tracking under
  their thresholds; act on any 50% email the same day, not at
  90%.

## 7. After judging (from Nov 8) — re-lower the caps

Judging-week values are deliberately generous; do not leave
them running unattended:

- [ ] `apphosting.prod.yaml`: `AI_DAILY_BUDGET_USD` 50 back to
  a quiet-week value (5), `AI_DAILY_CALL_LIMIT` 10000 back
  down (500), `AI_HOURLY_BUDGET_USD` 15 back down or `"0"`
  (off), `runConfig.minInstances` 1 back to 0. One
  config-only promotion (`docs/DEPLOY.md` section 9).
- [ ] GCP budgets: keep both guards, lower amounts to
  quiet-week levels; delete any leftover TEST budget.
- [ ] Remove demo-board `policyOverrides` that are no longer
  needed; keep Firestore TTL + bucket lifecycle rules.
- [ ] Record final judging-week spend (GCP + `usage:costs`)
  on the Linear launch issue.

