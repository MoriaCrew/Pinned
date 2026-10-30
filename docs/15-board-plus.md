# 15 — Board Plus (PIN-103)

Server seam for an optional paid add-on. The UI is built
separately; this page is the contract it builds on. Stripe is
not wired yet: `PLUS_MODE` is `off` (nothing can be bought) or
`mock` (an instant, clearly labelled demo grant).

## What it is

- The core loop is always free: uploads, cut-outs, pins, scenes
  and the AI budget are unchanged and never gated. **Guests never
  pay.**
- Board Plus is bought by the board's **host** (the browser that
  created the board) and today unlocks the Plus skins.
- **Which skins are Plus is owned by the skins catalogue**
  (`src/domain/skins.ts`, `Skin.plus`; today `darkroom`,
  `postcard`, `marigold`). `src/domain/plus.ts` derives
  `PLUS_SKIN_IDS` / `isPlusSkin` from it and keeps no list of its
  own; a test pins that they agree. Skins are stored in the
  existing `Board.themeId`; `isBoardThemeId` accepts every skin id
  plus the first-generation theme ids.

## Plans

| Plan | id | Billing | Covers | Display price (Policy) |
| --- | --- | --- | --- | --- |
| This board | `board` | one-time | this board | `plus.priceLabels.board` = `$3.99` |
| Host plan | `host` | monthly | every board the host runs (see limits) | `plus.priceLabels.host` = `$4.99/month` |

Prices are placeholder **labels** in Policy (overridable through
`POLICY_OVERRIDES_JSON` or per board), never literals in code and
never used to charge anything. The host plan covers the board
plan (`planCovers`), so buying `board` on a host-plan board is a
no-op.

## Host identity

- **Credential.** `POST /api/boards` draws a random 256-bit token
  (`generateAdminToken`) and stores on the board only
  `Board.host = { tokenHash, issuedAt }`, where `tokenHash` is
  `sha256("pinned-host-v1:" + token)`. The creator gets the raw
  token once, in the cookie `pinned_host_{slug}` with the value
  `h1.<token>` (`src/server/host-session.ts`).
- **Verification.** The cheap check is the cookie's version prefix
  and token shape (no I/O). The full check loads the board and
  compares hashes timing-safely (`verifyToken`), then checks the
  stored `issuedAt` against `Policy.plus.hostCookieDays` (default
  365) using the board's effective Policy. A token older than that
  is refused whatever the browser kept.
- **Revocable.** Replacing or clearing `Board.host` kills the
  token. Today an operator does that on the board doc; an in-app
  hand-off or rotation is a follow-up.
- **No SESSION_SECRET involved.** Nothing is HMAC-signed, so
  rotating the secret never strips hosts, and a backend without a
  secret still has hosts.
- **Domain separation.** The `pinned-host-v1:` hash prefix keeps a
  host hash distinct from an admin-token hash (bare token) and from
  a participant-cookie hash (HMAC-signed JSON body). The `h1.`
  prefix keeps the cookie format versioned.
- **Cookie scope.** The cookie uses `Path=/api/boards/{slug}`, plus
  `HttpOnly`, `SameSite=Lax`, `Secure` on https, and
  `Max-Age = hostCookieDays` from the env-level Policy at create.
  It is sent only to that board's API, never to pages or other
  boards, so it cannot bloat every request.
  - Consequence: the server-rendered board page (`/g/{slug}`)
    cannot see the cookie, so its first view says
    `viewer.isHost: false`. The client's first poll of
    `GET /api/boards/{slug}` (inside the cookie path) reports the
    real value. UI must treat host-only controls as "appear after
    the first poll".

**Limits (deliberate for v1):**

- Host = the creating browser. Another device, a cleared cookie
  jar or a private window is not the host. There is no hand-off or
  re-issue yet, and the credential expires `hostCookieDays` after
  create.
- **Follow-up:** attach host status to a signed-in user
  (`AUTH_MODE=optional`). That could happen at create time when
  signed in, or by a claim with host cookie + user cookie. It makes
  host status portable and re-issuable, and gives the host plan
  something to hang on (a user, not a board) so it can really
  cover all of that host's boards.

## API

Every `[slug]` route runs the slug gate first (malformed slug →
the uniform 404). The two host-only routes then run the cheap,
I/O-free gates, in order:

1. `Sec-Fetch-Site` present and not `same-origin` → 403
   `cross_site`.
2. `Content-Type` not `application/json` → 415
   `unsupported_media_type`.
3. Per-IP budget `Policy.plus.hostRoutesPerIp` (default 60 per
   10 min, shared by both routes, in-process) → 429
   `rate_limited`.
4. Host cookie missing or malformed → 403 `host_only`.
5. Body over `Policy.plus.requestMaxBytes` (default 1024) → 413
   `body_too_large`.

After the gates, the route loads the board and checks the host
token against the stored hash and age. A wrong or expired token
and an unknown board are the same 403 `host_only`, so the routes
reveal nothing about whether a board exists. Input errors are 400.
Error bodies are `{ error, code }`. The guards live in
`src/app/api/boards/request-guards.ts` for other routes to adopt
later.

- `PATCH /api/boards/{slug}/skin` `{ skinId }` → 200 `{ board }`.
  400 `skin_unknown` (not `isBoardThemeId`); 402 `plus_required`
  for a Plus skin without an entitlement that counts. Choosing the
  current skin is a 200 no-op: no write, no version bump.
- `POST /api/boards/{slug}/plus` `{ plan: "board" | "host" }` →
  200 with one of:
  - `{ status: "granted", plus }`
  - `{ status: "unavailable" }` (PLUS_MODE=off, or a paid grant the
    mock may not replace; nothing written)
  - `{ status: "redirect", url }` (reserved for Stripe)

  400 `plan_unknown`.
- `POST /api/boards` (create): unchanged body; additionally sets
  the host cookie. A Plus skin as the initial `themeId` is 402
  `plus_required` (a new board holds no entitlement).
- `GET /api/boards/{slug}` (board view), additive fields:
  - `viewer: { isHost: boolean }`
  - `plus: { active: boolean, plan?: "board" | "host", mode:
    "off" | "mock", priceLabels: { board, host } }`

  The entitlement's `source` and `grantedAt` and the host hash
  never leave the server.
- `GET /api/health` additionally reports `plusMode`.

## Data

- `Board.plus?: { plan, source: "mock" | "stripe", grantedAt } | null`.
  Absent or `null` means a free board; every reader is null-safe.
- `Board.host?: { tokenHash, issuedAt } | null`: server-only.
- Skin and Plus are written only through
  `BoardRepository.updateBoardSettings(slug, fn)`. The caller's
  mutator receives the current stored board and returns a patch,
  `null` (no change: no write, no version bump), or throws to
  refuse. It runs inside the Firestore transaction (or the
  synchronous in-memory body), the same shape as PIN-90's
  `mutateReclaimAttempt`. So every decision is made against the
  exact board being written:
  - the skin entitlement check
  - the no-op "already wearing it"
  - the mock's plan coverage (`host` survives a concurrent `board`
    in either order)
  - "never replace a stripe grant with a mock"

  A patch bumps `Board.version` by exactly one and never touches
  counters. A skin change also replaces the stored theme tokens
  with the new skin's tokens, or removes them, so an old palette
  never lingers.

## `PLUS_MODE`

Read only in `src/config.ts`; anything but the exact value `mock`
is `off`. Adapters live in `src/billing/` behind the `Checkout`
port (`startCheckout({ slug, plan })`, which throws a typed
`BoardNotFoundError` when the board is gone).

- `off` (default; prod): every checkout answers `unavailable` and
  writes nothing. A leftover `source: "mock"` grant **does not
  count** in `off` (`hasPlus(board, mode)`): it unlocks no skin
  and the view shows `active: false`. A board already wearing a
  Plus skin keeps the stored id; the UI decides how to render
  that (follow-up). The UI should present Plus honestly as not
  available yet — never a buy button that pretends.
- `mock` (dev backend via `apphosting.dev.yaml`; locally via
  `.env.local`): grants the entitlement at once with
  `source: "mock"`. No money moves; the UI must say it is a demo.
  The stored source keeps mock grants distinguishable forever.
  Never set `mock` on prod.

Check a backend with `GET /api/health` → `plusMode`.

## Policy keys (`plus`)

| Key | Default | Notes |
| --- | --- | --- |
| `priceLabels.board` / `.host` | `$3.99` / `$4.99/month` | display only |
| `hostCookieDays` | 365 | Server-side credential age, checked with the board's effective Policy, so a per-board override applies there. Cookie `Max-Age` is set once at create from the env-level Policy. |
| `requestMaxBytes` | 1024 | JSON body cap on the host routes |
| `hostRoutesPerIp` | 60 / 600,000 ms | in-process per-IP brake, both host routes |

## Stripe catalog (PIN-146)

What Pinneds sells is committed code: `src/billing/catalog.ts`
(`CATALOG_ITEMS`, catalog version `dev-v1`). Amounts are EUR
cents, tax-inclusive (TTC) — the displayed price is the charged
price. Runtime slices import the manifest; nothing reads Stripe
object ids from config.

| Item (lookup key) | Grants | Price | Status |
| --- | --- | --- | --- |
| `pinneds_credits_25` | 25 makes | €4.99 one-time | live |
| `pinneds_credits_60` | 60 makes | €9.99 one-time | live |
| `pinneds_credits_150` | 150 makes | €19.99 one-time | live |
| `pinneds_host_monthly` | host plan | €4.99/month recurring | draft — seeded, not yet offered |

Every catalog product and price carries metadata
`catalog=pinneds`, `item_key`, `credits` (packs only) and
`catalog_version`. Product identity is that metadata, never the
name; price identity is the `lookup_key`, which stays stable
when a price is replaced.

`scripts/seed-stripe-catalog.mjs` converges a Stripe **sandbox**
onto the manifest (plain `fetch`, no SDK; it mirrors the
manifest — a test pins the mirror). It is a dry-run unless
`--apply` is passed, takes the secret from the env var named by
`--env-var` (never printed; live keys refused), and prints item
keys and object ids only:

```
node --env-file=.env.local scripts/seed-stripe-catalog.mjs --env-var STRIPE_PINNED_LOCAL_AGENT_KEY
node --env-file=.env.local scripts/seed-stripe-catalog.mjs --env-var STRIPE_PINNED_LOCAL_AGENT_KEY --apply
```

Convergence: a product matched by metadata is reused (updated
in place on copy/metadata drift); a price matched by lookup key
is reused only when amount, currency, product, tax behavior and
recurrence all match — those fields are immutable, so drift
mints a new price with `transfer_lookup_key=true` and archives
the old one. POSTs carry idempotency keys, and re-running a
converged sandbox creates nothing. The pure decision functions
(`catalogValidationErrors`, `planProduct`, `planPrice`,
`buildCatalogPlan`) are unit-tested in
`src/billing/catalog.test.ts`. This slice changes no runtime
behavior: checkout still runs `off`/`mock` until the Stripe
adapter slice lands.

## Credit ledger (PIN-147)

`src/domain/credit-ledger.ts` is the pure per-board makes ledger:
no Stripe calls and no board-loop wiring yet — checkout/webhook
slices translate Stripe events into its operations, taking amounts
from `Policy.credits` (packs pinned to the PIN-146 catalog by a
test, `starterMakes` 25 granted once per board, paid makes never
expire, `pendingIntentCapPerBoard` 3, `intentTtlSeconds` 1800).

The account tracks `balance` (makes owned, never negative),
`frozen` (the disputed subset of `balance`, held per dispute id)
and `pendingClawback` (make-debt from a clawback that exceeded the
unspent pool; every future grant pays it down before crediting).
Spendable makes are exactly:

```
available = max(0, balance - frozen - pendingClawback)
```

Reachable states never hold `balance > 0` with
`pendingClawback > 0`, so the debt term cannot double-count; it
keeps a corrupt state failing closed. Ledger entry types are
`starter_grant`, `purchase_grant`, `debit`, `clawback`, `freeze`
and `restore`, each recording gross `amount` plus the signed
counter deltas it actually made. Purchases move
`pending -> granted -> clawed_back`, or `pending -> closed` for an
expired intent. Rules, all unit-tested including duplicates and
out-of-order events: grants are idempotent by purchase id (and
every entry by its event id); a clawback before its grant records
against the pending purchase so grant + clawback net to zero;
partial refunds apply as per-refund deltas indexed by refund id
(repeat id = no-op, totals never exceed the pack); disputed makes
freeze until a restore or the dispute's final clawback (a freeze
arriving before the grant is deferred and lands with it); debits
spend only `available`. Persistence sits behind the
`CreditLedgerStore` port (in-memory implementation included): each
operation is one atomic per-board read-modify-write and a refusal
writes nothing.

## Stripe plan (not built)

1. Add `PLUS_MODE=stripe`, with `STRIPE_SECRET_KEY` and
   `STRIPE_WEBHOOK_SECRET` from Secret Manager (referenced in
   `apphosting.*.yaml`, never values in git) and the two Stripe
   price ids in config.
2. A `StripeCheckout` adapter returns `{ status: "redirect", url }`:
   - **This board** → Checkout Session, `mode: "payment"`.
   - **Host plan** → Checkout Session, `mode: "subscription"`.
   - `client_reference_id` = slug, `metadata` = `{ slug, plan }`,
     success/cancel URLs back to `/g/{slug}`.
3. `POST /api/billing/stripe/webhook` verifies the signature on
   the raw body.
   - `checkout.session.completed` writes
     `{ plan, source: "stripe", grantedAt }` through
     `updateBoardSettings`.
   - Subscription `deleted` / unpaid and refunds/disputes revoke
     (needs a revoke field in the patch).
   - The success redirect never grants — only the webhook does.
4. **Idempotency by Checkout Session id:** record each processed
   session id with a create-if-absent doc (e.g.
   `billing/sessions/{sessionId}`) in the same transaction as the
   grant, so a webhook retry or replay is a no-op. Use an
   idempotency key when creating sessions too.
5. The host plan becomes truly cross-board only once host status
   lives on a signed-in user (see the follow-up above).

## Follow-ups

- Host hand-off / re-issue (and sign-in linking, above).
- A distributed limiter for the host routes. Today's brake uses the
  shared in-process `checkRateLimit`, a soft limit per instance.
- Adopt `request-guards.ts` on the other state-changing routes.
- UI behaviour for a Plus skin whose grant stopped counting.

## Tests

- `src/domain/plus.test.ts`: catalogue agreement, null-safety,
  mode rule, mock decision.
- `src/server/host-session.test.ts`
- `src/billing/checkout.test.ts` and the shared
  `src/billing/mock-checkout.contract.ts` (memory + fake
  Firestore: host-vs-board race, stripe never replaced).
- `src/server/board-plus.test.ts`
- The repository contract (`src/domain/board-repository.contract.ts`:
  mutator no-op/throw/isolation and concurrent read-modify-writes,
  memory + fake Firestore).
- Policy/config tests.
- Route tests: `src/app/api/boards/plus-routes.test.ts` (mock: real
  registry, cookie path, guards, 429) and `plus-routes.off.test.ts`
  (off: unavailable, leftover mock grant inert).
