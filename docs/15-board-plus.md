# 15 — Board Plus (PIN-103)

Server seam for an optional paid add-on. The UI is built
separately; this page is the contract it builds on.
`PLUS_MODE` is `off` (nothing can be bought), `mock` (demo) or
`stripe` (credit packs via hosted Checkout, PIN-149; the
credits themselves land by webhook only, PIN-150).

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
- `POST /api/boards/{slug}/credits/checkout` `{ lookupKey }` →
  200 with one of:
  - `{ status: "redirect", url }` (PLUS_MODE=stripe: a hosted
    Stripe Checkout Session for that pack)
  - `{ status: "unavailable" }` (off/mock; nothing written)

  Gates: slug 404; cross-site 403, non-JSON 415, per-IP 429
  (`Policy.credits.checkoutPerIp`, default 20 per 10 min,
  in-process), body 413 (the shared `plus.requestMaxBytes` cap);
  then a joined board participant (board session cookie) or the
  board host, else 401 `participant_required` (the same answer
  for unknown boards). 400 `pack_unknown` for a pack Policy does
  not offer; 429 `intent_cap_reached` at the per-board pending
  cap (`Policy.credits.pendingIntentCapPerBoard`); 503
  `checkout_unavailable` when Stripe has no active price or the
  session cannot be created (the just-made intent and purchase
  are closed again, so the cap is freed). Error bodies never
  carry the slug.
- `GET /billing/return?intent={id}&result=success|cancel` → 302.
  The return redirector Stripe points at: it resolves the opaque
  intent server-side and lands on `/g/{slug}?billing=processing`
  (success) or `?billing=cancelled` (cancel). It grants nothing —
  credits arrive by webhook only (PIN-150), hence "processing".
  Unknown, expired and malformed intents all land on `/` with no
  flag, indistinguishable from each other.
- `POST /api/boards` (create): unchanged body; additionally sets
  the host cookie. A Plus skin as the initial `themeId` is 402
  `plus_required` (a new board holds no entitlement).
- `GET /api/boards/{slug}` (board view), additive fields:
  - `viewer: { isHost: boolean }`
  - `plus: { active: boolean, plan?: "board" | "host", mode:
    "off" | "mock" | "stripe", priceLabels: { board, host } }`

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

Read only in `src/config.ts`; anything but an exact known value
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
- `stripe` (PIN-149): sells the credit packs through hosted
  Stripe Checkout (adapter section below). Requires
  `STRIPE_SECRET_KEY` in the same env — `stripe` without a key
  parses as `off` in config (fail closed: sells nothing, never
  errors per request; `GET /api/health` shows the effective
  mode). Plus plans (board/host skins) are **not** sold in this
  mode yet: the plan route answers `unavailable`, and a stored
  `source: "stripe"` grant counts while a mock one does not.
  **No hosted backend runs `stripe` yet**: dev references the
  key in `apphosting.dev.yaml` but keeps `PLUS_MODE=mock`, and
  prod has neither the mode nor a key reference. Flipping a
  hosted backend waits for webhook grants (PIN-150/PIN-153) —
  taking payments with no fulfilment path is forbidden.

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
behavior in that slice; the runtime adapter followed in
PIN-149 (below).

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

## Credit storage + checkout intents (PIN-148)

`FirestoreCreditLedgerStore`
(`src/server/firestore-credit-ledger-store.ts`) implements the
ledger port by running the pure ops inside one Firestore
transaction per board, so concurrent debits cannot overspend and
concurrent grants cannot double-credit; a throw aborts the
transaction and writes nothing. Storage is multi-doc so no
document grows unbounded:

- `creditAccounts/{boardId}` — the account head only (`balance`,
  `frozen`, `pendingClawback`, `starterGranted`,
  `frozenByDispute`).
- `creditAccounts/{boardId}/purchases/{purchaseId}` — one doc
  per recorded purchase.
- `creditAccounts/{boardId}/entries/{eventId}` — one append-only
  doc per applied entry, keyed by event id, with an internal
  `_seq` (append order, stripped on reads; the board-repository
  pattern).

`getAccount`/`listEntries` reconstruct the domain account
exactly (entries by `_seq`, `appliedEventIds` derived from the
entry ids), so duplicate-event replay is a no-op even after a
restart. Unknown boards read a zero balance. All access is
direct doc reads plus whole-subcollection reads sorted in code:
**no new composite indexes**, so `firestore.indexes.json` is
unchanged and no index deploy is needed for this slice.
`firestore.rules` stays deny-all — the Admin SDK server path
owns these collections.

`CheckoutIntent` (`src/server/checkout-intent.ts`, Firestore impl
in `src/server/firestore-checkout-intent-store.ts`) is the
opaque bridge to hosted checkout. The server mints a random
UUID intent id; the board mapping exists only inside the stored
record at `checkoutIntents/{intentId}` (top-level by intent id,
so a webhook resolves it with one direct get). The
public/Stripe-facing shape (`toPublicCheckoutIntent`) carries
only the opaque intent id plus the pack offer — no board slug or
internal board id may ever reach Stripe metadata,
`client_reference_id` or URLs; the checkout slice must send the
intent id and nothing board-identifying. `purchaseId` equals the
intent id (one opaque identity per purchase); creating an intent
writes nothing to the ledger — the caller drives
`recordPurchase`/`closePurchase` with that id. Intent `expiresAt`
is `createdAt + Policy.credits.intentTtlSeconds`, and the
per-board pending cap (`Policy.credits.pendingIntentCapPerBoard`,
values supplied by the caller) is enforced transactionally
against `checkoutIntentBoards/{boardId}` (`pendingIntentIds`),
lazily expiring stale pending intents so an abandoned tab
cannot block a board forever. `resolvePending` answers "still
payable" for the webhook slice and lazily expires stale intents;
`close`/`expire` free the cap slot. No routes, Stripe calls or
board-loop wiring landed in this slice — store selection arrived
with PIN-149, the first slice to call these stores (below).

## Stripe Checkout adapter + buy route (PIN-149)

`StripeCreditCheckout` (`src/billing/stripe-checkout.ts`,
official `stripe` SDK, server-only) implements the additive
`CreditCheckout` port next to the plan-based `Checkout` port —
packs are not Plus plans, so the plan port's shape stays
untouched and keeps answering `unavailable` in stripe mode.
The client is dependency-injected (tests run a fake; no network
in tests), built once per process in `src/billing/server.ts`
from `STRIPE_SECRET_KEY` (env name only, via `src/config.ts`)
with the API version pinned in that one config place
(`STRIPE_API_VERSION`, typed against the SDK's bundled version
so an SDK bump fails typecheck until the pin follows). Store
selection for the PIN-148 stores also landed here, following
the budget-store pattern (`src/server/checkout-intent-store.ts`,
`src/server/credit-ledger-store.ts`): Firestore when
`DATA_BACKEND=firestore`, in-memory otherwise.

How a buy flows (`buyCredits`, `src/server/credit-checkout.ts`):

1. The pack is validated against `Policy.credits.packs` (pinned
   to the catalog by test) and the Stripe **price is resolved
   by `lookup_key`** (`prices.list`, active only) through a
   short in-process cache (5 min; lookup keys survive price
   transfers, ids do not). Unknown/draft/mis-sized packs are
   refused from the committed catalog before any Stripe call;
   a catalog pack with no active price is a 503. Nothing is
   written yet, so a bad price leaves no intent behind.
2. The opaque `CheckoutIntent` is created (per-board pending
   cap + TTL from Policy, enforced in the store) and the ledger
   purchase recorded with `purchaseId` = the intent id.
3. Only then is the hosted Checkout Session created. If that
   fails, the intent and purchase are closed again so the cap
   slot is freed, and the caller gets a generic 503.

Session parameters (checked against the current Stripe docs —
Checkout Sessions create + Adaptive Pricing):

- `mode: "payment"`, one line item at quantity 1 on the EUR
  base price. `expires_at` tracks the intent's expiry (floored
  at Stripe's 30-minute minimum session life, capped under
  its 24-hour maximum) so a session cannot be paid long after
  its intent died; the webhook stays the grant authority.
- `adaptive_pricing: { enabled: true }` — Stripe presents the
  payer's local currency and handles conversion; the session
  still settles in EUR. This only takes effect on eligible
  sessions and follows the Dashboard's Adaptive Pricing
  setting; if the account cannot use it (e.g. a Managed
  Payments conflict, to verify when the mode is first flipped
  on dev), the fallback is explicit `currency_options` on the
  catalog prices — not built today.
- **No `payment_method_types`.** That is the legacy static
  list; eligible methods are Dashboard-managed (dynamic payment
  methods) and naming types would override the Dashboard
  configuration. Which immediate methods v1 accepts is
  therefore a Dashboard setting, not code.
- **Guest payer**: no `customer` and no `customer_creation`.
  The payment-mode default (`if_required`) creates no Customer
  for a plain one-time payment, so anyone with the board link
  who has joined can pay without an account.
- **Opacity**: `client_reference_id` is the intent id and
  `metadata` is exactly `{ checkout_intent_id, pack_lookup_key,
  credits }`. The board slug (a capability secret) is never
  given to the adapter, so it cannot appear in params,
  metadata or URLs; success/cancel go to `/billing/return`
  keyed by intent id only. Session creation carries an
  idempotency key derived from the intent id.

Hosted wiring in this slice is reference-only: dev references
`STRIPE_SECRET_KEY` from Secret Manager in
`apphosting.dev.yaml` (already provisioned there) but keeps
`PLUS_MODE=mock`; prod references nothing (no prod secret
exists yet). No hosted backend takes a Stripe payment until
webhook grants land.

## Stripe webhook (PIN-150)

`POST /api/billing/stripe/webhook` (Node runtime) is the only
grant authority for credit packs: it hands the RAW body +
`Stripe-Signature` header to the SDK's `constructEvent` with
`STRIPE_WEBHOOK_SECRET` (env name via `src/config.ts`; no
apphosting yaml references it yet and no hosted `PLUS_MODE`
flips to `stripe` in this slice - the secret cannot exist
until PIN-153 registers the endpoint, and a dangling reference
would break deploys). The route fails closed with 503 when
stripe mode, the API key, or the signing secret is absent;
400 only for a bad/missing signature; 500 only for unexpected
store/API failures so Stripe retries them. Every handled
decision answers 200: processed, duplicate, unhandled type,
and every dead letter below. The service
(`src/server/stripe-webhook.ts`) takes an injected Stripe
client (`src/billing/stripe-webhook.ts`), so tests verify
real signatures with the SDK signer and fake only retrievals.

Events PIN-153 must register on the endpoint (snapshot
payloads, API version pinned in lockstep with the SDK) -
exactly `STRIPE_WEBHOOK_EVENT_TYPES` in the service:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `checkout.session.async_payment_failed`
- `checkout.session.expired`
- `refund.created`
- `refund.updated`
- `refund.failed`
- `charge.dispute.created`
- `charge.dispute.funds_withdrawn`
- `charge.dispute.funds_reinstated`
- `charge.dispute.closed`

How each is handled (semantics checked against current
docs.stripe.com webhook, Checkout fulfilment, Refund object
and dispute lifecycle pages):

- Fulfilment (`completed` + `async_payment_succeeded`, one
  path) grants only when `payment_status` is `paid` - an
  async method's `completed` arrives `unpaid` and grants
  nothing (its ids are still mapped). The session must name
  its intent by `metadata.checkout_intent_id` /
  `client_reference_id` (never a slug), and before granting
  the handler cross-checks the pack (`pack_lookup_key`,
  metadata + intent + `Policy.credits.packs` credits) and
  the money (`amount_total`/`currency` against the pack's
  `eurCents`; for a foreign presentment currency the settled
  EUR amount is read from the charge's BalanceTransaction -
  its amount/currency are the settlement values - after
  retrieving the session/PaymentIntent/charge through the
  injected client when the snapshot lacks fields). Unknown
  intent, dead board/intent (TTL passed at event time), or
  any mismatch writes a dead letter and grants nothing. On
  grant the Stripe session/payment_intent/charge mapping is
  persisted on the intent (additive fields; a conflicting
  remap refuses) so later refund/dispute events, which carry
  only charge/payment_intent ids, resolve back via
  `findByStripeIds`; the intent then closes.
- `async_payment_failed` + `expired` close (expire) the
  intent and its ledger purchase, never grant; a purchase
  the ledger refuses to close (e.g. partially pre-clawed)
  dead-letters for an operator.
- Refunds claw back per-refund, never from the cumulative
  `charge.refunded`: a Refund's status transitions
  (`pending`/`requires_action` -> `succeeded`/`failed`/
  `canceled`, notified on `refund.updated`/`refund.failed`),
  so only `succeeded` refunds count, on `refund.created` or
  `refund.updated`, once per refund id.
- Disputes: `created` freezes, `funds_withdrawn` is the
  final clawback, `funds_reinstated` restores, and `closed`
  restores on `won`/`warning_closed` and final-clawbacks on
  `lost` when `funds_withdrawn` has not already done so
  (restoring only the freeze's rounding excess then). Funds
  reinstated after a final clawback cannot be un-clawed by
  the ledger, so that case dead-letters as
  `reinstated_after_final_clawback` instead of pretending.
- Out-of-order delivery follows the PIN-147 ledger
  semantics: a refund clawed before its grant nets the grant
  to zero, an early restore tombstones the dispute so a late
  freeze no-ops, and a pre-grant freeze defers, capped at
  what actually lands in the pool.

Money -> makes (one documented formula): for a pack of
`credits` makes at `eurCents`, clawbacks use
`min(credits, floor(cents * credits / eurCents))` on the
CUMULATIVE settled-EUR amount - the intent stores cumulative
refunded EUR cents + makes already clawed for refunds, and
each refund claws the difference, so partial refunds sum to
exactly the pack with no rounding drift. Dispute freezes use
the same ratio with `ceil` (round up protects the pool; the
excess over the final floor amount is restored at close).
Foreign-presentment refund/dispute amounts are never
FX-guessed: settled EUR comes from the reported
BalanceTransaction - or, for a fresh dispute carrying no
balance transactions yet, from its presentment amount at
the charge BalanceTransaction's own Stripe-reported
`exchange_rate`, so the freeze lands at `created`. Refund
counting is atomic in the intent store (`countRefund`
prices the delta from the stored cumulative inside the
write), and a dispute's final clawback is claimed
atomically by whichever terminal event lands first; the
other, in any order, only releases the freeze's ceil
excess. When none of that reads as EUR the
event dead-letters (`fx_unverifiable`).

Durable records: `stripeWebhookEvents/{eventId}` is the
processed-event record (written only after handling, so a
crash retries into the ledger's own event/purchase/refund/
dispute idempotency, and a replay after restart short-
circuits), and `billingDeadLetters/{eventId:reason}` is the
operator flag PIN-153 reconciliation drains - reasons include
`unknown_intent`, `dead_intent`, `dead_board`,
`amount_mismatch`, `amount_unverifiable`, `pack_mismatch`,
`unknown_purchase`, `unknown_mapping` (refund/dispute for a
charge we never mapped), `mapping_conflict`,
`freeze_no_available`, `ledger_refused`, `fx_unverifiable`
and `reinstated_after_final_clawback`. Records carry ids
only - no payloads, no secrets. Plus-plan (board/host)
Stripe sales stay unbuilt: the draft `pinneds_host_monthly`
price is seeded only (PIN-146).

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
- PIN-150: `src/server/stripe-webhook.test.ts` (real SDK
  signatures: fail-closed config, bad signature, unpaid vs
  paid fulfilment, exact-once grant, cumulative refunds,
  dispute freeze/final/restore, dead letters, settled-EUR
  FX), `src/server/firestore-stripe-webhook-records.test.ts`
  (processed/dead-letter store contract incl. replay after
  reload), the PIN-150 cases in
  `src/server/checkout-intent.test.ts` (Stripe mapping +
  refund/dispute accounting, memory + fake Firestore), and
  route wire tests `src/app/api/billing/stripe-webhook-routes.test.ts`
  (400/200 + end-to-end grant) and
  `stripe-webhook-routes.off.test.ts` (503 fail-closed).
- PIN-149: `src/billing/stripe-checkout.test.ts` (fake client:
  lookup resolution + cache, exact session params, no-slug
  guarantee), `src/server/credit-checkout.test.ts` (buy order,
  cap, cleanup, return resolver, store selection) and
  `src/app/api/boards/credits-checkout-routes.off.test.ts`
  (route gates/auth/429, off-mode unavailable, return 302s).
