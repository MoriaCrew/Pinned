# Deploying Pinneds (dev → prod)

_Owner: Robin. Every operator step below is written so a local Claude
Code session with `gcloud`, `firebase` and `gh` logged in can run it,
with Robin approving each command. Console-only steps are marked
**(console)**. Never paste secret values into a terminal transcript,
a PR, Linear or this repo: commands below only print names, lengths
and hashes._

## 1. What runs where

| | dev | prod |
|---|---|---|
| URL | https://dev.pinneds.com | https://pinneds.com (www → 301 to apex) |
| Firebase project | `moriacrew-pinned-dev` | `moriacrew-pinned-prod` |
| App Hosting backend | `pinned-web`, `europe-west4` | `pinned-web`, `europe-west4` |
| Builds from | branch `dev` (auto, on push) | branch `main` (auto, on push) |
| Env file | `apphosting.yaml` + `apphosting.dev.yaml` | `apphosting.yaml` + `apphosting.prod.yaml` |
| Firestore / Storage | `eur3` / `moriacrew-pinned-dev.firebasestorage.app` | `eur3` / `moriacrew-pinned-prod.firebasestorage.app` |

App Hosting builds on push and **does not wait for CI**. Feature PRs
merge into `dev`; prod changes only through a promotion PR into
`main`, merged by Robin. The `Protect main` ruleset (SECURITY.md)
allows **squash merges only** with linear history, so each
promotion lands on `main` as one squash commit that `dev`'s history
never contains. §4 shows how to cut every promotion after the first
so it never conflicts.

## 2. Environment matrix

`—` = unset. Values live in the yaml files; secrets are Secret
Manager references by name.

| Key | Code default (`src/config.ts`) | dev | prod (judging week) |
|---|---|---|---|
| `AI_MOCK` | mock unless `"0"` | `0` | `0` |
| `AI_DAILY_BUDGET_USD` / `AI_DAILY_CALL_LIMIT` | 5 / 500 | 5 / 500 | **50 / 10000** |
| `AUTH_MODE` / `AUTH_SAME_ORIGIN` | link-only / off | optional / 1 | optional / 1 |
| `UI_LOCALES` | `en` | all 7 | all 7 |
| `PLUS_MODE` | off | stripe (sandbox) | off until PIN-210 (live) |
| `POLICY_OVERRIDES_JSON` | — | credits on | — until PIN-210 |
| `PINNED_LAB` | off | 1 | — (lab routes 404) |
| `DEMO_BOARD_SLUG` | — | — | secret ref after seeding (§6) |
| `runConfig` | — | base: min 0, max 2, 512 MiB | min **1**, max **4**, **1024 MiB**, concurrency 10 |
| Secrets | — | `META_API_KEY`, `SESSION_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | `META_API_KEY`, `SESSION_SECRET`, `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` (+ Stripe and `DEMO_BOARD_SLUG` later) |

Budget behaviour when the day's cap is reached: scenes become an
honest collage; photo uploads stop with "Today's AI budget is used
up". The day resets at 00:00 UTC (7 pm US Eastern after Nov 1).

## 3. Pre-flight (before merging to `main`)

Set a shell variable once: `P=moriacrew-pinned-prod`.

1. **Logins.** `gcloud auth login`, `gcloud auth application-default login`,
   `firebase login`, `gh auth status`.
2. **Secrets exist, with access for the backend.** For each name in
   the prod column above:
   ```sh
   for s in META_API_KEY SESSION_SECRET NEXT_PUBLIC_FIREBASE_API_KEY NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN; do
     gcloud secrets describe "$s" --project "$P" --format="value(name)" >/dev/null && echo "$s ok" || echo "$s MISSING"
     firebase apphosting:secrets:grantaccess "$s" --backend pinned-web --project "$P"
   done
   ```
   A missing secret fails the build: create it with
   `firebase apphosting:secrets:set NAME --project "$P"` (value typed
   at the prompt), then grant access as above.
3. **`SESSION_SECRET` is long enough and differs from dev** (prints
   only a length and same/different):
   ```sh
   gcloud secrets versions access latest --secret SESSION_SECRET --project "$P" | tr -d '\n' | wc -c   # want >= 32
   a=$(gcloud secrets versions access latest --secret SESSION_SECRET --project moriacrew-pinned-dev | sha256sum)
   b=$(gcloud secrets versions access latest --secret SESSION_SECRET --project "$P" | sha256sum)
   [ "$a" = "$b" ] && echo "SAME as dev: rotate prod" || echo "different"
   ```
4. **Service-account roles match dev:**
   ```sh
   for p in moriacrew-pinned-dev "$P"; do echo "== $p"; gcloud projects get-iam-policy "$p" \
     --flatten="bindings[].members" --filter="bindings.members:firebase-app-hosting-compute" \
     --format="value(bindings.role)" | sort; done
   ```
5. **Firestore indexes, Firestore rules and Storage rules**, deployed
   from the commit you are about to promote (the Studio code queries
   indexes the game build never needed). Answer **No** if asked to
   delete indexes that are not in the file.
   ```sh
   git fetch origin dev && git checkout origin/dev
   firebase deploy --only firestore:indexes,firestore:rules,storage --project prod
   gcloud firestore indexes composite list --project "$P" --format="table(name.basename(),state)"   # all READY
   ```
6. **Sign-in on pinneds.com.**
   - Authorized domain and Google provider (read-only check):
     ```sh
     curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: $P" \
       "https://identitytoolkit.googleapis.com/admin/v2/projects/$P/config" | jq '.authorizedDomains'
     ```
     `pinneds.com` must be listed (docs/13: already enabled Oct 29).
   - **(console)** Google Cloud → APIs & Services → Credentials → the
     prod project's web OAuth client → add the authorized redirect URI
     `https://pinneds.com/__/auth/handler`.
   - **(console)** Google Auth Platform → Branding: app name
     "Pinneds", home page `https://pinneds.com`, authorized domain
     `pinneds.com`, privacy policy URL once PIN-26 ships. Audience:
     publishing status **In production** (basic scopes only, no
     verification needed).
7. **Meta prod key (console):** credit balance and per-model rate
   limits. Worst case is about 32 SAM calls at once (`maxInstances` 4
   × Policy `maxConcurrentDecomposeJobs` 2 × `samConcurrency` 4);
   typical judging traffic is far below that.
8. **Domain (read-only):** `curl -sI https://pinneds.com | head -1` and
   `curl -sI https://www.pinneds.com | grep -i location`.

## 4. Promote

1. Every PR meant for this promotion is merged to `dev`, and
   dev.pinneds.com passes the smoke in §5.
2. Open the promotion PR, titled `Promotion: dev → main (<date>)`,
   listing the PIN issues it ships.
   - **While `main` is an ancestor of `dev`** (true for the first
     Studio promotion: `git merge-base --is-ancestor origin/main origin/dev && echo ok`),
     a plain `dev` → `main` PR works (or reuse the open one).
   - **Every later promotion:** `main` now holds a squash commit that
     `dev` lacks, so a `dev` → `main` PR would conflict wherever a
     file changed both before and after the last promotion. Instead,
     cut a branch from `main` whose files are exactly `dev`'s:
     ```sh
     git fetch origin main dev
     git checkout -b promote/$(date +%Y-%m-%d) origin/main
     git restore --source=origin/dev --staged --worktree -- .   # also applies deletions
     git commit -m "Promote dev to prod ($(git rev-parse --short origin/dev))"
     git diff --stat origin/dev   # must print nothing: tree == dev
     git push -u origin HEAD
     ```
     and open the PR from that branch into `main`.
3. CI green and Bugbot triaged → Robin merges with **Squash and
   merge** (the only method the ruleset allows).
4. Watch the build: Firebase console → App Hosting → `pinned-web`
   (prod) → Rollouts. Then confirm the running revision picked up
   `runConfig`:
   ```sh
   gcloud run services describe pinned-web --region europe-west4 --project "$P" \
     --format="value(spec.template.metadata.annotations,spec.template.spec.containers[0].resources.limits.memory)"
   ```

## 5. Smoke (prod or dev)

```sh
curl -s https://pinneds.com/api/health   # ok:true, aiMock:false, authMode:"optional", plusMode:"off"
curl -s -o /dev/null -w "%{http_code}\n" https://pinneds.com/lab/sam          # 404
curl -s -o /dev/null -w "%{http_code}\n" https://pinneds.com/__/auth/handler  # 200
curl -s -o /dev/null -w "%{http_code}\n" https://pinneds.com/api/me           # 401 when signed out
```

On a phone: create and join a board; upload a fixture photo from
`eval/fixtures/studio/photos/` (pins in under ~20 s); pin; make a
scene (under ~30 s); remix it; switch language in the "you" menu;
sign in with Google and open My boards; open the board link in a
private window (link preview shows the latest scene); delete an
element; delete the throwaway board.

## 6. After the first promotion

1. **TTL on AI call logs** (rows carry `expireAtTs`, docs/16):
   ```sh
   gcloud firestore fields ttls update expireAtTs --collection-group=aiCallLogs --enable-ttl --project "$P"
   ```
2. **Bucket lifecycle** (`tmp/` working copies deleted after 1 day;
   `firebase deploy` does not apply it). Do both buckets:
   ```sh
   gcloud storage buckets update gs://moriacrew-pinned-prod.firebasestorage.app --lifecycle-file=storage.lifecycle.json
   gcloud storage buckets update gs://moriacrew-pinned-dev.firebasestorage.app --lifecycle-file=storage.lifecycle.json
   ```
3. **Demo board + an identical backup:**
   `SEED_BASE_URL=https://pinneds.com npm run seed:demo` twice. The
   script prints each slug once: record them only in Linear (PIN-76),
   never in git. Time the first scene with
   `npm run seed:demo -- --time-first-scene <slug>`.
4. **Demo-board overrides** (no deploy; Firestore console →
   `boards/<slug>` → field `policyOverrides`, a map). Try it on a
   throwaway board first: an invalid value makes that board answer
   500.
   ```json
   { "dailyBudgetUsd": 80, "dailyCallLimit": 16000,
     "participantsPerBoard": 500, "joinMaxNewPerIp": 200,
     "scenesPerBoardPerDay": 300, "scenesPerParticipantPerDay": 30,
     "photosPerParticipantPerDay": 40 }
   ```
   The board's own budget is checked against the same daily counter,
   so the demo board keeps working after the global cap is hit.
5. **Landing demo link:** `firebase apphosting:secrets:set DEMO_BOARD_SLUG --project "$P"`
   + `grantaccess`, then a PR adding the reference to
   `apphosting.prod.yaml` (it ships with promotion #2).
6. **Monitoring:**
   - Uptime check on `https://pinneds.com/api/health` every minute,
     content contains `"aiMock":false`, with an email alert
     **(console: Monitoring → Uptime checks)**; the check also keeps
     the instance warm.
   - Alert on Cloud Run 5xx > 5 in 5 min for `pinned-web`.
   - GCP billing budget (e.g. $25) with 50/90/100 % emails. Meta
     spend is not on GCP billing: run
     `GCLOUD_PROJECT=moriacrew-pinned-prod npm run usage:costs -- --days 1`
     twice a day.
7. **GitHub front page:**
   `gh repo edit MoriaCrew/Pinned --description "Pinneds: a shared pinboard of real things. Muse Spark names them, SAM 3.1 cuts them out, Muse Image composes credited scenes. Meta AI hackathon." --homepage https://pinneds.com --add-topic muse-image --add-topic muse-voice --add-topic nextjs --add-topic firebase`

## 7. Live billing

Turned on by PIN-210 with promotion #2, after Stripe live activation,
the tax decision (PIN-154) and the legal pages (PIN-26). Steps and
smoke: `docs/15-board-plus.md`, "Going live on prod".

## 8. Judging week (Nov 4–8)

- **Freeze** `main` and `dev` (dev.pinneds.com is the fallback demo).
- **Twice a day:** health, the demo board, `usage:costs`.
- **Meta slow or down:** set the demo board's `dailyBudgetUsd` to 0.
  Scenes become honest collages, uploads say AI is switched off,
  existing pins and scenes keep working. Undo by restoring the value.
- **Bad release:** App Hosting → Rollouts → previous rollout → Roll
  back (switches traffic, no rebuild). The first Studio promotion has
  no Studio rollout behind it, so fix forward until promotion #2.
- **DNS or certificate trouble:** the backend's `hosted.app` URL
  still works; then dev.pinneds.com; then the video.

## 9. After judging

Lower `AI_DAILY_BUDGET_USD`/`AI_DAILY_CALL_LIMIT`, set
`minInstances: 0`, remove the demo-board overrides you no longer
need, and keep the TTL and lifecycle rules.
