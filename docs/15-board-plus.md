# 15 — Board Plus (PIN-103)

Server seam for an optional paid add-on. The UI is built
separately; this page is the contract it builds on.
`PLUS_MODE` is `off` (nothing can be bought), `mock` (demo) or
`stripe` (the Board Plus pack via hosted Checkout, PIN-149; the
makes and Plus land by webhook only, PIN-150 / PIN-181).

## What it is

- The core loop is free while `Policy.credits.enabled` is off
  (the shipped default, PIN-151): uploads, cut-outs, pins, scenes
  and the AI budget are unchanged. With credits on, AI makes
  ("creations" in the UI) spend the board pool instead (PIN-151
  below). **A creation is one AI scene (PIN-229):** adding a photo
  and its cut-outs never uses one, so discarding cut-outs costs
  nothing; every AI scene uses one, even one the person does not
  keep. A new board starts with a free pool of 5
  (`credits.starterMakes`) while its maker still has free boards
  left (the rule below). **Guests never have to pay.**

> **Free creations rule (PIN-204/205).** Free creations are a
> welcome gift per maker, not per board. A maker gets the free
> pool (`credits.starterMakes`, 5) on each of their first
> `credits.starterBoardsPerMaker` (3) new boards per
> `credits.starterMakerWindowMs` (7 days, counted from their first
> board in the window), together with the board's free photos
> (rule below). After that, a new board starts at 0 creations and
> 0 free photos: it still works (people join, signed-in members
> add things from their other boards, scenes fall back to free
> collages) and shows the usual Get Plus invitation. Paid creations
> are never limited by this rule, and creating a board is never
> blocked by it.
>
> - **Who is a maker:** the signed-in user when sign-in is on and
>   the request carries a session, else the client address the
>   rate limiter uses (`clientIp` in `src/server/rate-limit.ts`,
>   PIN-112) — IPv4 as is, IPv6 grouped by its /64, anything
>   unreadable in one shared bucket. People behind one shared
>   IPv4 (office, school or event Wi-Fi, some mobile carriers)
>   share one allowance while signed out; signing in gives each
>   person their own. Signed-in and signed-out counts are kept
>   apart.
> - **What is stored:** a versioned sha256 of that source in
>   `starterAllowances/{key}`, never the raw address or uid. A
>   plain hash of an IPv4 address can be reversed by brute force,
>   so the counter must not outlive its window: enable the TTL
>   policy on `starterAllowances.expireAtTs` (operator console
>   step, docs/16). A keyed hash is tracked in PIN-207.
> - **When it counts:** once per board creation, before the board
>   is written. The decided amount is stored on the board
>   (`Board.starterMakes`, server-only), and the lazy starter
>   grant uses it, so a failed grant at creation never becomes a
>   full pool. A counter failure gives 0, and so does a lazy grant
>   for an unknown or deleted board (fail closed).
> - **Credits off:** nothing is counted or stored; creation is
>   unchanged.
> - **The hard wall** stays the site-wide daily AI budget
>   (`dailyBudgetUsd` / `dailyCallLimit`), which free and paid
>   makes share today (PIN-206 splits it). Tuning ideas after
>   launch: PIN-207.

> **Free photos rule (PIN-230).** Since a creation is an AI scene
> (PIN-229), a free board's photo cost (~$0.02 a photo, docs/16)
> is bounded by a limit, not a meter: while credits are on, a
> board without Plus cuts `credits.freePhotosPerBoard` (15)
> photos. **A board with Plus has no photo limit**; the Policy
> daily caps (`photosPerParticipantPerDay`,
> `segmentsPerParticipantPerDay`) apply to everyone.
>
> - **What counts:** a photo whose job finished `ready` (it gave
>   cut-outs), or one still pending/running and not yet stale (the
>   stale sweep's bound), so a photo already cutting holds its slot
>   and a dead job never does. Only truly simultaneous requests
>   (both read before either job exists) can pass together, at
>   most the upload concurrency over the limit, as with the daily
>   cap. Failed and refused
>   photos never count. Discarding cut-outs does not give the
>   photo back: the limit bounds AI cost the photo already spent.
>   Counted from the board's photo jobs (`listForBoard`), no new
>   storage.
> - **How many:** board creation decides it with the maker slot
>   above and stores it (`Board.freePhotos`, server-only): the
>   Policy value on a win, 0 past the maker's free boards (else
>   new boards would farm free photos). Boards without the field
>   use the Policy value. A board's own override
>   (`policyOverrides.credits.freePhotosPerBoard`) wins over the
>   stored amount: an operator's explicit choice for that one
>   board. (The demo board needs none: it is a normal board and
>   gets Plus, so no photo limit, once billing is live, DEPLOY
>   §6.4.)
> - **At the limit:** `POST /photos` answers a typed 429
>   `{ code: "free_photos_used" }` before intake, any job or any
>   AI call — checked before the daily cap, since waiting a day
>   would not help. The batch queue stops on it like the other
>   coded 429s. A lost-response replay of a counted photo still
>   gets its job back.
> - **Board view:** `credits.freePhotosLeft` while credits are on
>   and the board has no Plus; absent with Plus (no limit) or
>   credits off. A failed job-list read omits the field, never
>   the page.
> - **In the UI (PIN-231):** a cap people rarely feel, not a meter.
>   The Add sheet says nothing while plenty are left, one quiet
>   line at `credits.lowFreePhotosWarning` (3) or fewer, and at 0
>   invites into the Plus sheet instead of showing the photo
>   picker; the 429 and a batch photo stopped on the code get the
>   same invitation, never an error. The Plus sheet lists
>   "Unlimited photos". Details under "Plus sheet + creations UI".
> - **Plus that counts:** a Stripe grant always; a demo
>   (`source: "mock"`) grant only while `PLUS_MODE=mock` (as for
>   skins).
- **One purchase (PIN-181).** €2.99 once for this board buys
  Board Plus (every look, foil stickers) plus 20 creations. Any
  joined member, or the host, can buy it for the board; it is a
  gift to the board, not to the buyer. No host plan is sold.
- **Look control.** The host can always change the look (free
  skins; Plus skins once the board has Plus). Once the board has
  Plus, any joined member can change it too.
- **Which skins are Plus is owned by the skins catalogue**
  (`src/domain/skins.ts`, `Skin.plus`; today `darkroom`,
  `postcard`, `marigold`). `src/domain/plus.ts` derives
  `PLUS_SKIN_IDS` / `isPlusSkin` from it and keeps no list of its
  own; a test pins that they agree. Skins are stored in the
  existing `Board.themeId`; `isBoardThemeId` accepts every skin id
  plus the first-generation theme ids.

## The purchase (PIN-181)

| What | Who can buy | Billing | Grants | Policy |
| --- | --- | --- | --- | --- |
| Board Plus · 20 creations (`pinneds_plus_20`) | any joined member or the host | €2.99 once, this board | 20 makes + `Board.plus = { plan: "board", source: "stripe" }` | `credits.packs`, `credits.plusOnPurchase` |

It is bought through the credits buy route (PIN-149) and granted
by the webhook (PIN-150 section). The plan ids `board` / `host`
stay in the domain: `board` is what a purchase records, and the
mock checkout still demos both. `host` covers `board`
(`planCovers`). No host plan is sold: the draft
`pinneds_host_monthly` price stays draft. The price on screen is
formatted from the pack's `eurCents` (`formatEur`); there are no
price labels in Policy or in the board view (removed in PIN-182).

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
the uniform 404). The skin and plus routes then run the cheap,
I/O-free gates, in order (since PIN-181 the body cap runs before
the credential check):

1. `Sec-Fetch-Site` present and not `same-origin` → 403
   `cross_site`.
2. `Content-Type` not `application/json` → 415
   `unsupported_media_type`.
3. Per-IP budget `Policy.plus.hostRoutesPerIp` (default 60 per
   10 min, shared by both routes, in-process) → 429
   `rate_limited`.
4. Body over `Policy.plus.requestMaxBytes` (default 1024) → 413
   `body_too_large`.
5. No credential cookie → 403 `host_only`: a well-formed host
   cookie, or for the skin route a board session cookie.

After the gates, the route loads the board and checks the
credential: the host token against the stored hash and age, or
(skin route only) a joined member's board session while the
board has Plus. A wrong or expired credential, a member without
Plus and an unknown board are the same 403 `host_only`, so the
routes reveal nothing about whether a board exists. Input errors
are 400.
Error bodies are `{ error, code }`. The guards live in
`src/app/api/boards/request-guards.ts` for other routes to adopt
later. Board delete (`DELETE /api/boards/{slug}`, PIN-167) is also
host-only but answers every failure with the uniform 404
(`docs/13-auth.md`).

- `PATCH /api/boards/{slug}/skin` `{ skinId }` → 200 `{ board }`.
  Allowed for the host, or since PIN-181 a joined member while
  `hasPlus(board, mode)` (`resolveSkinActor`; the member's Plus is
  checked again inside the write). 400 `skin_unknown` (not
  `isBoardThemeId`); 402 `plus_required` for a Plus skin without
  an entitlement that counts (only the host can hit it: a member
  needs Plus to get this far). Choosing the current skin is a 200
  no-op: no write, no version bump.
- `POST /api/boards/{slug}/plus` (host only) `{ plan: "board" | "host" }` →
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
  flag, indistinguishable from each other. It is read-only
  (PIN-178): it never expires or closes an intent, so it
  cannot race the webhook's grant.
- `POST /api/boards` (create): unchanged body; additionally sets
  the host cookie. A Plus skin as the initial `themeId` is 402
  `plus_required` (a new board holds no entitlement).
- `GET /api/boards/{slug}` (board view), additive fields:
  - `viewer: { isHost: boolean, canChangeLook: boolean }`
    (`canChangeLook`, PIN-181: the host, or a joined viewer while
    the board has Plus; the skin route re-checks)
  - `plus: { active: boolean, plan?: "board" | "host", mode:
    "off" | "mock" | "stripe" }`
  - `credits: { availableMakes: number, freePhotosLeft?: number }`
    (PIN-151, only while `Policy.credits.enabled`; absent
    otherwise, so the disabled shape is unchanged.
    `freePhotosLeft`, PIN-230: only for a board without Plus)

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
  - the skin entitlement check (and a member's Plus, PIN-181)
  - the no-op "already wearing it"
  - the mock's plan coverage (`host` survives a concurrent `board`
    in either order)
  - "never replace a stripe grant with a mock"
  - the purchase grant (`decidePurchasePlusGrant`, PIN-181): no
    write when a stripe grant of any plan exists, else a paid
    `board` grant that also replaces a mock one

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
- `stripe` (PIN-149): sells the Board Plus pack through hosted
  Stripe Checkout (adapter section below). Requires
  `STRIPE_SECRET_KEY` in the same env — `stripe` without a key
  parses as `off` in config (fail closed: sells nothing, never
  errors per request; `GET /api/health` shows the effective
  mode). Plus comes only with that pack (PIN-181): the plan
  route still answers `unavailable`, and a stored
  `source: "stripe"` grant counts while a mock one does not.
  **Dev runs `stripe` since PIN-153** (sandbox only: the dev
  backend flips together with `Policy.credits.enabled` and
  the registered webhook endpoint - PIN-153 section below).
  Prod stays `off` until the PIN-210 prod switch turns on live
  Stripe ("Going live on prod" below). PIN-149/PIN-150
  deliberately shipped reference-only so no backend ever took
  a payment with no fulfilment path.

Check a backend with `GET /api/health` → `plusMode`.

## Policy keys (`plus`)

| Key | Default | Notes |
| --- | --- | --- |
| `hostCookieDays` | 365 | Server-side credential age, checked with the board's effective Policy, so a per-board override applies there. Cookie `Max-Age` is set once at create from the env-level Policy. |
| `requestMaxBytes` | 1024 | JSON body cap on the skin and plus routes (and the credits buy route) |
| `hostRoutesPerIp` | 60 / 600,000 ms | in-process per-IP brake shared by the skin and plus routes |

## Policy keys (`credits`)

Every key is deep-overridable through `POLICY_OVERRIDES_JSON` or
per board. `packs` is an array, so an override replaces the whole
list.

| Key | Default | Notes |
| --- | --- | --- |
| `enabled` | `false` | kill flag for the pool (PIN-151); dev turns it on |
| `packs` | one pack: `pinneds_plus_20`, 20 makes, 299 cents, label `20 creations · €2.99` | what the buy route offers; a test pins it to the catalog's live items (PIN-181) |
| `starterMakes` | 5 | free pool granted once per board (PIN-181; was 25) |
| `freePhotosPerBoard` | 15 | PIN-230: photos a board without Plus cuts while credits are on (ready or in-flight count; failed/refused never). Stored per board at creation with the maker slot (0 past the maker's free boards). 0 = no free photos |
| `photosUseMakes` | `false` | PIN-229: a creation is an AI scene, so photos never touch the pool. `true` restores the PIN-151 photo debit (1 per finished photo job) |
| `starterBoardsPerMaker` | 3 | boards per maker per window that get the free pool; 0 = none (PIN-204; read at board creation since PIN-205) |
| `starterMakerWindowMs` | 604,800,000 (7 days) | fixed window for `starterBoardsPerMaker`, anchored at the maker's first counted board (PIN-204) |
| `lowMakesWarning` | 2 | low state at or under this many makes; 0 disables (PIN-181; was 5) |
| `lowFreePhotosWarning` | 3 | PIN-231: the Add sheet's quiet "N free photos left on this board" line at or under this many free photos left; 0 disables the line (the 0-left invitation stays) |
| `plusOnPurchase` | `true` | a webhook grant also gives the board Plus (PIN-181) |
| `pendingIntentCapPerBoard` | 3 | open checkout intents per board |
| `intentTtlSeconds` | 1800 | how long an intent holds a cap slot (PIN-178) |
| `checkoutPerIp` | 20 / 600,000 ms | buy route per-IP brake |
| `webhookMaxBytes` | 1,048,576 | webhook body cap (PIN-178) |

## Stripe catalog (PIN-146)

What Pinneds sells is committed code: `src/billing/catalog.ts`
(`CATALOG_ITEMS`, catalog version `dev-v1`). Amounts are EUR
cents, tax-inclusive (TTC) — the displayed price is the charged
price. Runtime slices import the manifest; nothing reads Stripe
object ids from config.

| Item (lookup key) | Grants | Price | Status |
| --- | --- | --- | --- |
| `pinneds_plus_20` | Board Plus for the board + 20 creations | €2.99 one-time | live (PIN-181) |
| `pinneds_credits_25` | 25 makes | €4.99 one-time | retired (PIN-181) |
| `pinneds_credits_60` | 60 makes | €9.99 one-time | retired (PIN-181) |
| `pinneds_credits_150` | 150 makes | €19.99 one-time | retired (PIN-181) |
| `pinneds_host_monthly` | host plan | €4.99/month recurring | draft — seeded, not offered |

"Creations" is the customer-facing word for makes; code keeps
`credits`/`makes`. The Checkout page shows the item's name
"Board Plus · 20 creations" and its description. The lookup key
(`pinneds_plus_20`, item `plus_20`) names the product; the pack's
`credits` say what it holds.

`retired` (PIN-181) means no longer sold: `assertLiveCreditPack`
refuses it like a draft, and the seed archives it. The entry
stays in the manifest so the seed can find what to archive, and
purchases made before retirement keep their own terms (PIN-150
section).

Every catalog product and price carries metadata
`catalog=pinneds`, `item_key`, `credits` (packs only) and
`catalog_version`. Product identity is that metadata, never the
name; price identity is the `lookup_key`, which stays stable
when a price is replaced.

`scripts/seed-stripe-catalog.mjs` converges a Stripe **sandbox**
onto the manifest (plain `fetch`, no SDK; it mirrors the
manifest — a test pins the mirror). It is a dry-run unless
`--apply` is passed, takes the secret from the env var named by
`--env-var` (never printed; a live key is refused unless
`--live --i-understand-live`, PIN-210), and prints item keys and
object ids only:

```
node --env-file=.env.local scripts/seed-stripe-catalog.mjs --env-var STRIPE_PINNED_LOCAL_AGENT_KEY
node --env-file=.env.local scripts/seed-stripe-catalog.mjs --env-var STRIPE_PINNED_LOCAL_AGENT_KEY --apply
```

Convergence: a product matched by metadata is reused (updated
in place on copy/metadata drift); a price matched by lookup key
is reused only when amount, currency, product, tax behavior and
recurrence all match — those fields are immutable, so drift
mints a new price with `transfer_lookup_key=true` and archives
the old one. The price lookup reads archived prices too (Stripe
lists only active ones unless asked, paginated like every list):
an archived price can still hold its lookup key, and creating
another price for that key is rejected, so a matching archived
price is reactivated (`unarchive`) and a drifted one transfers
(PIN-233). A retired item is archived instead: its product
and every active price under its lookup key get
`active=false`, nothing is created for it, and an
already-archived item plans `retired` (a no-op). POSTs carry
idempotency keys, and re-running a converged sandbox creates
nothing. The pure decision functions
(`catalogValidationErrors`, `planProduct`, `planPrice`,
`buildCatalogPlan`) are unit-tested in
`src/billing/catalog.test.ts`. This slice changes no runtime
behavior in that slice; the runtime adapter followed in
PIN-149 (below).

## Credit ledger (PIN-147)

`src/domain/credit-ledger.ts` is the pure per-board makes ledger
(board-loop debit wiring lands in PIN-151, below):
no Stripe calls in the domain — checkout/webhook
slices translate Stripe events into its operations, taking amounts
from `Policy.credits` (packs pinned to the PIN-146 catalog by a
test, `starterMakes` granted once per board (5 since PIN-181),
paid makes never expire, `pendingIntentCapPerBoard` 3,
`intentTtlSeconds` 1800).

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
`pending -> granted -> clawed_back`, or `pending -> closed` when
the payment can no longer happen (since PIN-178: Stripe reported
the session expired or its async payment failed, or the session
was never created; an intent past its TTL alone never closes
it). Rules, all unit-tested including duplicates and
out-of-order events: grants are idempotent by purchase id (and
every entry by its event id); a clawback before its grant records
against the pending purchase so grant + clawback net to zero;
partial refunds apply as per-refund deltas indexed by refund id
(repeat id = no-op, totals never exceed the pack); disputed makes
freeze until a restore or the dispute's final clawback (a freeze
arriving before the grant is deferred and lands with it); a freeze
holds at most what is still clawable from its own purchase
(`credits - clawedCredits`, so a dispute after a partial refund
never locks the starter's or other packs' makes), and a final
clawback consumes only its own dispute's hold, never another open
dispute's (PIN-233); debits spend only `available`. Persistence sits behind the
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
cannot block a board forever. `close`/`expire` free the cap
slot. No routes, Stripe calls or board-loop wiring landed in
this slice — store selection arrived with PIN-149, the first
slice to call these stores (below).

Since PIN-178 the TTL only governs that cap slot. Intent status
reads: `pending` holds a slot; `expired` means the TTL passed
and a later buy's cap check (or `expire`) freed the slot, while
the ledger purchase stays `pending`; `closed` is final (granted,
or a terminal outcome). Lazy expiry never touches the ledger,
nothing on a read path expires anything, and `close` also
finalizes an `expired` intent, so a late grant lands on it.
The old `resolvePending` ("still payable") call is gone: the
webhook resolves an intent by id whatever its status.

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
   transfers, ids do not). Unknown/draft/retired/mis-sized
   packs are refused from the committed catalog before any
   Stripe call; a catalog pack with no active price is a 503.
   Nothing is written yet, so a bad price leaves no intent
   behind.
2. The opaque `CheckoutIntent` is created (per-board pending
   cap + TTL from Policy, enforced in the store; since PIN-181
   it also stores the pack's `credits` + `eurCents`) and the
   ledger purchase recorded with `purchaseId` = the intent id.
3. Only then is the hosted Checkout Session created. If that
   fails, the intent and purchase are closed again so the cap
   slot is freed, and the caller gets a generic 503.

Session parameters (checked against the current Stripe docs —
Checkout Sessions create + Adaptive Pricing):

- `mode: "payment"`, one line item at quantity 1 on the EUR
  base price. `expires_at` tracks the intent's expiry (floored
  at 31 minutes, just over Stripe's 30-minute minimum session
  life, capped under its 24-hour maximum) so a board cannot
  keep payable sessions open long after their cap slots
  freed. A session paid in the gap after the intent's TTL
  still grants (PIN-178); the webhook stays the grant
  authority.
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

Hosted wiring in this slice was reference-only: dev referenced
`STRIPE_SECRET_KEY` from Secret Manager in
`apphosting.dev.yaml` but kept `PLUS_MODE=mock`, and prod
referenced nothing, so no hosted backend took a Stripe payment
before webhook grants landed. PIN-153 flips dev (below).

## Stripe webhook (PIN-150)

`POST /api/billing/stripe/webhook` (Node runtime) is the only
grant authority for credit packs: it hands the RAW body +
`Stripe-Signature` header to the SDK's `constructEvent` with
`STRIPE_WEBHOOK_SECRET` (env name via `src/config.ts`; the dev secret exists since
PIN-153 registered the endpoint, and `apphosting.dev.yaml`
references it - PIN-150 itself shipped no reference, since a
dangling one would break deploys). The route fails closed with 503 when
stripe mode, the API key, or the signing secret is absent;
413 when the declared `content-length` exceeds
`Policy.credits.webhookMaxBytes` (1 MiB; PIN-178, checked
before the body is read); 400 only for a bad/missing
signature; 500 only for unexpected store/API failures so
Stripe retries them, logged through the slug-redacting
`logServerError`. Every handled
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
  the handler cross-checks the pack (`pack_lookup_key` and
  credits, metadata against the intent's stored terms) and
  the money (`amount_total`/`currency` against the stored
  `eurCents`; for a foreign presentment currency the settled
  EUR amount is read from the charge's BalanceTransaction -
  its amount/currency are the settlement values - after
  retrieving the session/PaymentIntent/charge through the
  injected client when the snapshot lacks fields). Unknown
  intent, a deleted board (`dead_board`), a purchase a
  terminal event already closed (`dead_intent`), or any
  mismatch writes a dead letter and grants nothing. The
  intent's TTL and status do not matter (PIN-178): a paid
  session grants whenever its ledger purchase is still
  pending, so a payment in the 30-31 minute gap, after the
  payer's return redirect, after another buy's cap check
  expired the intent, or an async payment days later all
  grant. On grant the Stripe session/payment_intent/charge
  mapping is persisted on the intent (additive fields; a
  conflicting remap refuses) so later refund/dispute events,
  which carry only charge/payment_intent ids, resolve back
  via `findByStripeIds`; the intent then closes.
- **Plus on grant (PIN-181).** While the board's
  `credits.plusOnPurchase` is on, the grant also writes
  `Board.plus = { plan: "board", source: "stripe" }` through
  `updateBoardSettings` with `decidePurchasePlusGrant`: no
  write when the board already holds a stripe grant of any
  plan (a replay, or a paid host plan, is never downgraded); a
  mock grant is replaced. It runs after the makes grant AND on
  the `duplicate_grant` path, so a Plus write that throws
  (propagated: 500, Stripe retries) or a crash between the two
  writes is repaired by the next delivery. With no board
  repository wired the makes still land and the event
  dead-letters `plus_grant_unavailable`, re-runnable once
  fixed. A `stripe` grant counts in every `PLUS_MODE`, `off`
  included.
- `async_payment_failed` + `expired` are the terminal
  events: they close the intent and its ledger purchase,
  never grant; a purchase the ledger refuses to close (e.g.
  partially pre-clawed) dead-letters for an operator. Stripe
  never reports one session both expired and paid, so a paid
  event after `expired` would dead-letter `dead_intent`.
- Refunds claw back per-refund, never from the cumulative
  `charge.refunded`: a Refund's status transitions
  (`pending`/`requires_action` -> `succeeded`/`failed`/
  `canceled`, notified on `refund.updated`/`refund.failed`),
  so only `succeeded` refunds count, on `refund.created` or
  `refund.updated`, once per refund id.
- Disputes freeze until Stripe reports the outcome (PIN-178).
  Card disputes deliver `funds_withdrawn` about a second
  after `created`, so it cannot be the final clawback:

  | Event | Effect |
  | --- | --- |
  | `created` | freeze (ceil, capped at what the purchase still has to claw back after refunds; nothing left dead-letters `freeze_no_available`) |
  | `funds_withdrawn` | keep the freeze, or establish it if `created` was missed; after a `lost` claim, only completes that one claw |
  | `funds_reinstated` | restore the freeze |
  | `closed` `won` / `warning_closed` | restore the freeze (a no-op after `funds_reinstated`) |
  | `closed` `lost` | the one final clawback (floor), then restore the ceil excess |

  Funds reinstated after a final clawback cannot be
  un-clawed by the ledger, so that case dead-letters as
  `reinstated_after_final_clawback` instead of pretending.
- Out-of-order delivery follows the PIN-147 ledger
  semantics: a refund clawed before its grant nets the grant
  to zero, an early restore tombstones the dispute so a late
  freeze no-ops, and a pre-grant freeze defers, capped at
  what actually lands in the pool.

**Purchase terms (PIN-181).** The buy route stores the pack's
`credits` and `eurCents` on the intent (server-only, never in
the public shape). The amount check, refunds and disputes
price from those stored terms, so a later Policy price change
or a retired pack never reprices an old purchase. Intents
created before PIN-181 have no `eurCents`: they fall back to
the board's Policy pack by lookup key, and dead-letter
`pack_mismatch` once Policy no longer offers that pack.

Money -> makes (one documented formula): for a pack of
`credits` makes at `eurCents`, clawbacks use
`min(credits, floor(cents * credits / eurCents))` on the
CUMULATIVE settled-EUR amount - the intent stores cumulative
refunded EUR cents + makes already clawed for refunds, and
each refund claws the difference, so partial refunds sum to
exactly the pack with no rounding drift. Dispute freezes use
the same ratio with `ceil` (round up protects the pool; the
excess over the final floor amount is restored by the
`lost` close that claws).
Foreign-presentment refund/dispute amounts are never
FX-guessed: settled EUR comes from the reported
BalanceTransaction - or, for a fresh dispute carrying no
balance transactions yet, from its presentment amount at
the charge BalanceTransaction's own Stripe-reported
`exchange_rate`, so the freeze lands at `created`. That rate
converts major units, so the conversion only runs between
two 2-decimal currencies: a zero-decimal or three-decimal
presentment currency (Stripe's lists on
docs.stripe.com/currencies, kept as constants in the service),
or a missing one, dead-letters `fx_unverifiable` (PIN-181).
Refund
counting is atomic in the intent store (`countRefund`
prices the delta from the stored cumulative inside the
write), and a dispute's final clawback is claimed
atomically by the `lost` close, so a re-delivery or a
`funds_withdrawn` after it, in any order, never claws
twice. When none of that reads as EUR the
event dead-letters (`fx_unverifiable`).

Durable records: `stripeWebhookEvents/{eventId}` is the
processed-event record (written only after handling, so a
crash retries into the ledger's own event/purchase/refund/
dispute idempotency, and a replay after restart short-
circuits). Since PIN-178 an event that wrote a dead letter
gets no processed record: once the cause is fixed, the
Dashboard's Resend re-runs the handler, and that same
idempotency keeps the re-run from applying anything twice.
`billingDeadLetters/{eventId:reason}` is the operator flag
PIN-153 reconciliation drains (a re-run that dead-letters
again keeps the one record) - reasons include
`unknown_intent`, `dead_intent`, `dead_board`,
`amount_mismatch`, `amount_unverifiable`, `pack_mismatch`,
`unknown_purchase`, `unknown_mapping` (refund/dispute for a
charge we never mapped), `mapping_conflict`,
`freeze_no_available`, `ledger_refused`, `fx_unverifiable`,
`reinstated_after_final_clawback` and `plus_grant_unavailable`
(PIN-181: makes granted, Plus not written). Records carry ids
only - no payloads, no secrets. Plus is sold only inside the
pack (PIN-181); a separate host plan stays unbuilt: the draft
`pinneds_host_monthly` price is seeded only (PIN-146).
Refunds and disputes claw back makes but do **not** revoke
Plus in v1 (follow-up below).

## Pool debit on makes (PIN-151)

`src/server/credit-pool.ts` is the one place the board loop
touches the ledger. Everything sits behind
**`Policy.credits.enabled`, default `false`** (deep-overridable
via env `POLICY_OVERRIDES_JSON` or per board, like every other
credits key). While off, no ledger method is ever called — no
starter grants, no debits, no pool gate, no `credits` field in
the board view — so `AUTH_MODE=link-only` behaviour is exactly
the pre-credit behaviour, and the untouched existing suites
prove it. Flipping the flag off mid-life restores that at once.
No hosted backend enables it in this slice (activation is
PIN-153). While on but unwired (no store in deps — only
possible in a test harness) the pool reads empty and debits
refuse: fail closed, never gift a make.

**Starter timing.** The once-per-board starter pool
(`Policy.credits.starterMakes`, default 5 since PIN-181) is granted by
board creation when credits are on, under the deterministic
ledger event id `starter:{boardId}`; it never blocks creation.
Since PIN-205 creation first decides the amount for the maker
(the pool, or 0 past `starterBoardsPerMaker`; "Free creations
rule" above) and stores it on the board; a lazy grant uses that
stored amount, and the Policy default only for boards without it.
Every later credit touch — a board-view balance read (each
5-second poll), a photo preflight, a scene run or a make's
debit — first reads the account head with `getBalance`: one
`creditAccounts/{boardId}` doc read, no transaction, no
`purchases`/`entries` read (PIN-179). Only a missing head or
`starterGranted: false` (a board that predates the flag, or a
failed grant at creation) runs the ledger's transactional,
once-only `grantStarter` and then re-reads the head. So a
granted board's poll costs one document read whatever the
ledger size, and any number of concurrent first touches and
replays still grant exactly once.

**What a make is.** Exactly one successful AI scene (PIN-229).
Photos use no make by default (`credits.photosUseMakes: false`):
people pay for the thing they ask for, not for the AI's guesses,
even though a photo (~$0.02 of naming + SAM calls, docs/16)
costs us about twice a scene ($0.01). With the switch on, the
PIN-151 photo row below applies again.

| Flow | Debits 1 | Never debits |
| --- | --- | --- |
| Photo (`DecomposeJob`) | only with `photosUseMakes`: the job finishing `ready` (one completed job per photo, any element count) | by default every photo; always failures/refusals, cap denies, tap-adds and tap naming on its working copy |
| Scene/remix (`SceneJob`) | a ready scene recorded kind `ai` | refusals/failures, any collage (`AI_MOCK`, over-budget fallback, pool-empty lane) |
| Riders | — | suggestion chips, dictation: still only Policy-capped |

**Debit points (exact seams).** Debit event ids are
`debit:photo:{jobId}` / `debit:scene:{jobId}`, so a retry or
replay of the same job can never double-debit (and the job
claim gates already refuse a second run).

- Photo (only with `photosUseMakes`): inside `runDecomposeJob`,
  after at least one candidate pin has landed and before the
  job may finish `ready`. `uploadPhoto` preflights first (after
  the Policy daily photo cap): an empty pool gets the board
  API's typed 429 `{ code: "credits_pool_empty" }` before intake
  or any AI call, so the happy path never starts unpaid. With
  the switch off (the default) neither runs, and a photo's
  candidates follow the credits-off rules (kept on a failure or
  stale sweep, PIN-64), exactly as with credits off.
- Scene: inside `runSceneJob`, after the composed image is
  stored and before the terminal `finish` syncs a `ready`
  Scene — the only state the image route serves.

**Idempotent uploads + stale runners.** A photo POST may carry a
client-minted `uploadId` that becomes the job id (docs/06): a
replay returns the existing job before the pool preflight, so it
can never reach this seam twice. The runner also checks its own
deadline (the summed Policy timeouts + `Policy.staleJobMarginMs` for its non-AI tail) *before* debiting — past it
the job fails `stale_running` with no debit — and every job-store
write is compare-and-set on the expected status. If a debited
runner nevertheless loses its guarded `ready` finish (the
board-api stale sweep at bound + 2 x margin failed
the job first), it discards the unexposed candidates and refunds
the make under the deterministic ledger event
`refund:photo:{jobId}` (a `debit_refund` entry naming
`debit:photo:{jobId}`; idempotent by event id and per debit, so
retries of the finish can never double-refund). If the request
died after debiting (no live runner to refund), the sweep checks
the ledger instead and keeps the paid job's candidates
confirmable — the board never pays for a result it cannot pin.

**Race rule.** The ledger debit is one atomic per-board
read-modify-write, so two makes racing for the last credit
cannot both debit. The loser never exposes its AI result: a
photo's candidate pins/elements are discarded while its job is
still `running` (unconfirmable, untappable) and the job fails
`credits_pool_empty`; a scene's just-stored image is deleted
and its job/scene fail the same way, before any `ready` sync.
Once a debit lands the make is
paid: the ready outcome is recorded on the job first, and if
the terminal write itself throws it is retried once instead of
discarding or overwriting the result. A non-pool ledger failure at the seam fails the job
`credit_debit_failed` with the same discard/delete — failing
closed without claiming the pool was empty. An exception in
the photo run before the seam also discards landed candidates
while credits are on (off, the keep-what-landed PIN-64 rule
stands).

**Pool-empty lanes.** Photo (only with `photosUseMakes`): the
429 above, no AI spend; by default an empty pool never stops a
photo.
Scene: the existing free collage lane composes instead (the
composer port is never called, the scene is honestly kind
`collage` at $0, nothing debits) — decided inside
`runSceneJob` before composing, exactly like the budget
fallback it joins. The Policy daily caps and the PIN-61 AI
budget gates keep applying in every mode; a pool-empty collage
still counts against the scene day caps, as every collage
always has.

**Board API.** `GET /api/boards/{slug}` adds
`credits: { availableMakes }` while credits are on (the read
PIN-152 renders; no money or per-person fields ever) and omits
it while off. Since PIN-230 it also carries `freePhotosLeft`
for a board without Plus (Free photos rule above). A ledger failure on that read omits the field
instead of failing the board page, logged without the slug.

Tests: `src/server/credit-pool.test.ts` (disabled = zero
ledger writes; starter once at create/lazy/replay; debit on
photo and AI-scene success only; no debit on failure, refusal,
collage or riders; pool-empty photo/scene lanes; the photo
drain and concurrent scene last-make races; kill flag off
mid-life; PIN-179 head-only polls and makes, concurrent first
touches) plus the `credits.enabled` cases in
`src/policy/policy.test.ts`. The PIN-179 cost contract (a
granted board's read is one head-doc get with no transaction;
concurrent first touches grant once; replay after reload) runs
against the fake Firestore in
`src/server/firestore-credit-ledger-store.test.ts`.

## Plus sheet + creations UI (PIN-152, PIN-182, PIN-183, PIN-231)

The user-facing word for makes is **creations** (the code keeps
`makes` / `credits`). There is exactly one sheet that asks for
money, the Board Plus sheet (`PlusSheet` in `src/ui/skin-picker.tsx`,
mounted by `PlusFlow` in `src/app/g/[slug]/PlusFlow.tsx`); the
PIN-152 "Add makes" buy sheet and the Plus plan cards are gone.

The board page renders the PIN-151 `credits: { availableMakes }`
field (`src/app/g/[slug]/MakesFlow.tsx`, pure rules in
`src/domain/makes-ui.ts` and `src/domain/plus-ui.ts`). The
indicator mounts under the board header and renders **nothing**
while the view carries no `credits` (`Policy.credits.enabled`
off, the shipped default), so the disabled board is
pixel-for-pixel the pre-credits board and `AUTH_MODE=link-only`
behaviour is unchanged. The count rides the existing board poll,
so spends and grants appear without a reload, and changes are
announced (`aria-live="polite"`).

- **Indicator (PIN-183).** It speaks only when it matters. While
  `makesState` is `ok` (more than `Policy.credits.lowMakesWarning`
  left, default 2 since PIN-181; 0 means no low state) it renders
  nothing: no header card, no button, a board with plenty looks
  like a credits-off board. At or under the threshold it is one
  quiet line under the title in the board-meta style, no card:
  "N creations left · Get Plus", where "Get Plus" is a text button
  that opens the Plus sheet. At zero: "Out of creations. New scenes
  will be collages." plus the same button — the free collage lane,
  still labelled `Collage` on the print. Once the board has Plus
  the button reads "Add creations" (the same label on every way
  into the sheet below). The button is left out while billing is
  off; the line stays. Copy is activity language only, never money
  words (`wallet`, `gift card`, `cash`, `transfer`, money-`balance`),
  no dollars, no per-person anything (a test scans the EN + FR
  `makes.*` and `ui.plus*` strings, and that EN never says "make").
  The count is always findable in the you menu (below).
- **Plus sheet.** Title, lead ("Anyone on the board can get Plus.
  Everyone here gets it."), a perks list and one button. Perks in
  order: "+N creations" (N = `Policy.credits.packs[0].credits`; "For
  everyone on this board. One per AI scene.", PIN-229), "Unlimited
  photos" ("Add as many photos as you like to this board", camera
  icon, PIN-231), "Every skin", "Foil stickers", "Deeper scenes" and
  "Full-size downloads" (both tagged Soon: planned, not built). The
  button reads "Get Plus · €2.99" with a quiet "Once, for this
  board."; the price is `formatEur(pack.eurCents, locale)`, never a
  label. With Plus already on, the list collapses to the creations
  line plus "Plus is on" (no "Unlimited photos": the limit is
  already gone and this purchase only adds creations, so "Plus is
  on" stands for every perk), the lead becomes the add-creations
  lead, and the button reads "Add N creations · €2.99". On the stripe path one more quiet line
  sits under the button: "You may be charged in your local currency.
  Appears as PINNEDS on your statement." (never in mock or off).
  With nothing to buy (billing off, or the
  checkout answered `unavailable`) the button is disabled "Coming
  soon" under "Payments open after the hackathon. Nothing is
  charged." EN and FR both render (`locale`, default `en`).
- **Who and how it buys**, from `plus.mode` in the board view
  (`plusPurchasePath`): `stripe` posts the pack's `lookupKey` to the
  PIN-149 credits route (`useMakesFlow.buy`) and follows the hosted
  Checkout URL, for any joined member or the host (someone who has
  not joined is asked for a name first, the `buyMakes` join intent;
  the route requires a participant or the host). The pending-cap,
  rate-limit, join-first and generic failures each get their own
  inline line on the sheet. `mock` posts the host-only demo grant
  (`POST plus`, the demo note stays): a joined guest sees the sheet
  with the button disabled and "Only the board's host can do that."
  With Plus already on, the demo grant adds no creations, so the
  button is disabled for everyone, with the demo line under it.
  `off` sells nothing. Webhook granting stays the only way creations
  and Plus land (PIN-150, PIN-181).
- **Who can open it.** Anyone on the board. `PlusFlow` is mounted for
  every viewer; the try-on bar and "Keep it" stay host-only because
  the look flow only gives the host a try-on. The host's Keep it on
  a Plus try-on, and a 402 from the skin route, open the same sheet.
  So do the indicator's button, both pool-empty buttons and the
  you menu's Board Plus entry; someone who has not joined is asked
  for a name first (the `buyMakes` join intent).
- **You menu (PIN-183).** On a board with creations (the view
  carries `credits`) everyone sees a "Board Plus" entry, after My
  pins and before Change look, with a quiet subline: "N creations
  left", or "Plus is on · N creations left" once the board has Plus.
  It opens the Plus sheet. Change look shows for the host and for
  any joined member while `viewer.canChangeLook` (a member needs
  Plus on the board); Delete board stays host-only. The menu kit
  takes an optional `detail` line per item for the subline.
- **Members and the look (PIN-183).** A joined member who may
  change the look opens the same Change look sheet. Every skin is
  open to them (Plus is on) and a pick is saved at once with the
  skin PATCH the server already accepts for members; there is no
  try-on bar for members (`useLookFlow` gets `canChangeLook` next
  to `isHost`; `isHost` keeps the try-on, Keep it, the return look
  and Delete board). The page shows the member's pick while it
  saves and the "Look changed" line after it (`shownLook`).
- **Return landing.** `?billing=processing|cancelled` from
  `GET /billing/return` becomes a transient `aria-live`
  banner, and the flag is stripped from the URL at once.
  Processing means "adding your creations…": the banner refetches
  the board a few times, and only a real rise in
  `availableMakes` (over the count kept from buy time) may
  say "Your creations are in — N creations left." (plus "Plus is
  on." once the refetched view has `plus.active`) — granting stays
  webhook-only (PIN-150) and the redirect alone never claims
  success. No rise after the refetches lands on a neutral "still
  waiting" line; cancelled/failed returns get one neutral line
  each.
- **Look after the return.** A host who leaves for Checkout from a
  Plus try-on stores that skin in `sessionStorage` next to the
  makes baseline (`return-skin.ts`; replaced or cleared by every
  new buy). On `?billing=processing`, once the first poll says
  host and the refetched view has `plus.active`, the look flow
  saves the skin once (`returnSkinStep`: wait, apply or clear)
  and forgets it. A cancelled or failed return only forgets it.
- **Pool-empty outcomes (PIN-183).** Running out is an offer, never
  an error. The photo 429 (`credits_pool_empty`, PIN-151) and a
  photo job failing with that `errorCode` (both only while
  `credits.photosUseMakes` is on, PIN-229) replace the Add sheet's
  generic failure with "This board is out of creations. Get Plus to
  keep going." (a neutral status line, not an alert) and a button
  into the Plus sheet. A scene job failing with that code (the
  last-creation race loser) gets the same line on its problem
  card, with the button first in the card's new action slot, next
  to Change idea and Try again. Once the board has Plus the line
  says "Add more to keep going." and the button "Add creations".
  With billing off there is no button and the plain fact stays
  ("out of creations, so photos can't be cut out right now").
  Every other error keeps its old copy. The 429's body carries
  `code: "credits_pool_empty"` (`errorResponse` adds it for this
  code only), which is how the Add sheet tells it from a rate limit.
- **Free photos in the Add sheet (PIN-231).** A cap people rarely
  feel, not a meter; it rides `credits.freePhotosLeft` in the board
  view (PIN-230), so a board with Plus or with credits off never
  shows any of it. Rules in `src/domain/makes-ui.ts`
  (`freePhotosState`, `freePhotosUsedCopy`, `addPickView`,
  `isFreePhotosUsedCode` on the shared `FREE_PHOTOS_USED`).
  - More than `Policy.credits.lowFreePhotosWarning` (3) left:
    nothing; the pick step is the credits-off pick step.
  - At or under it: one quiet status line under the picker, no
    card, no button: "3 free photos left on this board" (plural
    pair `makes.freePhotosLeft`). 0 turns the line off.
  - At 0, before anyone picks: the invitation takes the photo
    picker's place, "This board used its free photos. Get Plus for
    unlimited photos." (a status line, never an alert) and the same
    Get Plus button into the Plus sheet as the pool-empty
    invitation (`onAddMakes` → `openBuyMakes`). "From your other
    boards" stays under it: library pins use no AI and no free
    photo. With billing off (no `onAddMakes`, the `canBuy` rule of
    `poolEmptyCopy`) the plain fact stays, "This board used its
    free photos, so new photos can't be added right now.", and no
    button.
  - A single upload answering the 429 `free_photos_used` swaps the
    picker for the same invitation at once (the poll may not have
    caught up), and a batch photo stopped with that `errorCode`
    shows it instead of the generic error, keeping Try again /
    Skip. If the board got Plus meanwhile, the picker comes back
    and the line says "This board has Plus now, so photos are
    unlimited. Try again."
- **My boards.** A card whose board has Plus (`hasPlus` in this
  PLUS_MODE, so a mock grant counts only in `mock`) carries a small
  "Plus" tag under its title (`MyBoardCard.plus`).
- **Copy.** Strings live under `makes.*` and `ui.plus*` in
  `src/i18n/messages/en.json`; new ones land there only and fall
  back to English until `npm run i18n:translate` (docs/18), so a
  test pins that every FR key in the family is still an EN key
  (PIN-231 relaxed the old strict EN/FR parity); the components take the page's language (the board passes
  its `locale`, kit parts read `useLocale()`). Whole sentences with
  placeholders, so word order can differ by language: the you
  menu's "Plus is on · N creations left" is one plural pair
  (`you.plusOnLeft`), not a count glued onto words. Prices format
  from `eurCents` per locale (`€2.99` / `2,99 €`), never from
  the pack's English display label. The PIN-152 "per make" line
  left with the buy sheet; the local-currency and statement-name
  notes stay as the one `ui.plusPayNote` line on the stripe path.

Tests: `src/domain/makes-ui.test.ts` (states, thresholds, the
Get Plus / Add creations label, pool-empty copy, flag parsing + URL
strip, banner never claims success without a rise, checkout
answers, prices, PIN-231 free-photos state, copy and pick view),
`src/app/g/[slug]/add-free-photos-render.test.ts` (PIN-231: nothing
above the threshold or with Plus, the low line, 0 left with and
without billing, the library strip at 0, the stopped batch step,
Plus since, other stops untouched, the single-upload 429 wiring),
`src/domain/plus-ui.test.ts`
(`plusPurchasePath`, `returnSkinStep`, `shownLook`, the look flow
reducer), `src/domain/you-menu.test.ts` and
`src/app/auth/you-render.test.ts` (Board Plus and Change look for
guest, member, member with Plus and host, the sublines in EN and FR),
`src/app/g/[slug]/plus-render.test.ts` (the sheet in every mode
and for a guest, order of the perks with Unlimited photos, Plus on, Coming soon, FR, a
member changing the look) and `src/app/g/[slug]/makes-render.test.ts`
(nothing above the threshold, the low and empty lines, banner
states, pool-empty copy, wiring guards, EN/FR parity and copy
guardrails), `src/app/g/[slug]/board-render.test.ts` (the problem
card's action), `src/app/api/boards/shared.test.ts` (the 429's
code), `src/server/my-boards.test.ts` and `src/app/me/library-parts.test.ts`
(the Plus tag), plus `src/ui/kit.test.ts` and the
`lowMakesWarning` and `lowFreePhotosWarning` cases in
`src/policy/policy.test.ts`. Phone screenshots (390 px):
`eval/screenshots/pin-231-add-low-390.png`,
`pin-231-add-used-390.png` and `pin-231-plus-perks-390.png`. No
hosted flip ships with this slice: `Policy.credits.enabled`
stays default `false` and no hosted `PLUS_MODE` changes.

## Reconciliation + dev activation (PIN-153)

`npm run billing:reconcile` (`scripts/billing-reconciliation.mjs`,
pure report logic in `src/domain/billing-reconciliation.ts`) is
the operator safety net: a read-only join of paid Stripe
Checkout Sessions (listed with the runtime key, by env name)
against Firestore ledger purchases, checkout intents and the
PIN-150 dead letters, via service-account ADC. It reports
paid-no-grant (a paid session whose intent has no ledger
grant), grant-no-payment (a granted purchase matching no paid
session by intent id or by the intent's mapped Stripe
session/payment-intent ids), dead-letters by reason (including
`reinstated_after_final_clawback` and `fx_unverifiable`), and
pending intents past their TTL. That last row still counts
toward the exit code, but since PIN-178 it is a prompt to
look, not lost money: such an intent can still grant (an
open session in its last minute, or an async payment still
settling); it only says no buy on that board has freed the
slot yet and no terminal Stripe event has closed it. Check the
session in Stripe if the row outlives the session's 24-hour
maximum life. Board slugs print only as
short hashes, like `usage:costs`. Exit 0 means clean; exit 1
means anomalies exist; exit 2 is a usage/config error.

```
node --env-file=.env.local scripts/billing-reconciliation.mjs --env-var STRIPE_PINNED_DEV_AGENT_KEY --project moriacrew-pinned-dev
```

**Runbook.** Run it daily while dev stripe mode is live and
after any billing change or deploy, and drain dead letters to
zero before calling a billing change done. In Stripe
Workbench, check the dev endpoint's delivery failures the
same cadence: a run of non-2xx deliveries means grants are
not landing and paid-no-grant will confirm it. A paid-no-grant
row is paid money with no makes - find the intent, read the
dead letter for the blocking reason, fix forward, never grant
by hand-editing the ledger. Since PIN-178 the fix-forward is:
remove the cause, then use Resend on that event in the Stripe
Dashboard; a dead-lettered event has no processed record, so
the handler runs again (its ledger ops are idempotent). The
dead-letter record stays until an operator drains it.
Refunds from an agent key are
approval-gated in Stripe (an operator must approve the
pending request in the Dashboard): agents only ever
demonstrate the gate and report the pending request, they do
not chase approval.

**Dev webhook endpoint.** `npm run billing:webhook-endpoint`
(`scripts/ensure-stripe-webhook-endpoint.mjs`, dry-run unless
`--apply`; pure plan in `src/billing/webhook-endpoint.ts`)
converges the sandbox onto one endpoint at
`https://dev.pinneds.com/api/billing/stripe/webhook` with
exactly the 11 PIN-150 events. Creation goes through
`POST /v1/webhook_endpoints`, so payloads are snapshots (the
full resource in `data.object`) rendered at the pinned API
version. On creation Stripe returns the signing secret once:
the script pipes it from process memory into Secret Manager
(`STRIPE_WEBHOOK_SECRET` in `moriacrew-pinned-dev`) over
gcloud stdin - never printed, echoed or written to a file -
and mirrors the `STRIPE_SECRET_KEY` IAM grants onto it. When
the endpoint already exists the secret cannot be re-read, so
the script only verifies URL, events and status; an operator
rolls a lost secret in Workbench.

**Dev activation.** Since PIN-153 the dev backend runs the
full path: `apphosting.dev.yaml` sets `PLUS_MODE=stripe`,
references `STRIPE_WEBHOOK_SECRET` next to `STRIPE_SECRET_KEY`,
and enables credits with
`POLICY_OVERRIDES_JSON={"credits":{"enabled":true}}` (the code
default stays off; prod yaml is untouched and stays `off`).
Dev is sandbox money only - the pinneds-dev sandbox catalog
converges with `scripts/seed-stripe-catalog.mjs` (PIN-146).
Verify after each dev deploy: `GET /api/health` reports
`plusMode: "stripe"`, the buy route returns a hosted Checkout
URL on a joined board, a bad-signature webhook POST returns
400, and `npm run billing:reconcile` against dev data reports
its summary (exit 1 only on named anomalies).

**Early-dispute race (found by the PIN-153 E2E).** The
fraud-dispute test card disputes within about a second of
the charge, and Stripe delivered `charge.dispute.created`
(+ `funds_withdrawn`) before fulfilment had persisted the
session->intent mapping, so `findByStripeIds` missed and
both events dead-lettered `unknown_mapping` (reconciliation
flagged them; the grant itself was fine). The handler now
falls back on a mapping miss to Stripe's own session lookup
by PaymentIntent (`findCheckoutSessionByPaymentIntent` on
the webhook client), resolves the intent the session names,
and backfills the mapping; the PIN-147 pre-grant freeze /
pre-clawback semantics then apply unchanged. A dispute for
a genuinely unknown charge still dead-letters.

## Going live on prod (PIN-210)

Prod (pinneds.com) sells the Board Plus pack with **live** Stripe
only once the prod switch (merge order below) reaches `main`, after
both live secrets exist: App Hosting fails the build when a
referenced secret does not exist. The operator
scripts default to sandbox. A live run needs a live key **and**
`--live --i-understand-live`, touches only `moriacrew-pinned-prod`
and `https://pinneds.com/api/billing/stripe/webhook`, and prints
ids, never keys or secrets (`scripts/stripe/operator-mode.mjs`).
Operator machine only, never CI or a cloud agent.

**Prerequisites (operator gates).** Stripe account activated for
live payments (business details, bank account, statement
descriptor; Checkout branding and receipts checked); pinneds.com
shows terms, refund/withdrawal and contact pages (PIN-26); the
tax/VAT route is signed off (PIN-154; prices are EUR
tax-inclusive); `gcloud auth login`,
`gcloud auth application-default login` and `firebase login` as
an owner of the prod project. Three live restricted keys
(Workbench → API keys → Create restricted key; everything not
listed stays None):

| Key | Kept in | Permissions (from the code) |
| --- | --- | --- |
| runtime | prod Secret Manager `STRIPE_SECRET_KEY` | Checkout Sessions: Write (create; the webhook's retrieve and list-by-PaymentIntent) · Prices: Read (lookup-key price) · PaymentIntents: Read · Charges: Read · Balance: Read (settled-EUR balance transactions) |
| setup | `.env.local` `STRIPE_PINNED_PROD_SETUP_KEY`; delete after go-live | Products: Write · Prices: Write · Webhook Endpoints: Write |
| read | `.env.local` `STRIPE_PINNED_PROD_READ_KEY` | Checkout Sessions: Read |

Signatures are checked locally and refunds are made in the
Dashboard, so no key needs Refunds or Disputes. A 403 names the
missing permission: add read on that one resource only.

**Commands, in order** (`P=moriacrew-pinned-prod`):

1. Runtime key, first (step 3 copies its grants):
   `firebase apphosting:secrets:set STRIPE_SECRET_KEY --project "$P"`
   (value typed at the prompt), then
   `firebase apphosting:secrets:grantaccess STRIPE_SECRET_KEY --backend pinned-web --project "$P"`.
2. Catalog: `node --env-file=.env.local scripts/seed-stripe-catalog.mjs --env-var STRIPE_PINNED_PROD_SETUP_KEY --live --i-understand-live`
   plans `plus_20 product=create price=create`, the retired packs
   `retired`, and skips the draft host plan; re-run with
   `--apply` (ends with `CATALOG_IDS_JSON`); a third run plans
   only `reuse`.
3. Webhook: `node --env-file=.env.local scripts/ensure-stripe-webhook-endpoint.mjs --env-var STRIPE_PINNED_PROD_SETUP_KEY --live --i-understand-live --secret-project "$P"`
   plans `create`; with `--apply` it creates the endpoint with the
   11 events, pipes the one-time signing secret over gcloud stdin
   into `STRIPE_WEBHOOK_SECRET` in `$P` and mirrors the
   `STRIPE_SECRET_KEY` grants onto it. Then (idempotent)
   `firebase apphosting:secrets:grantaccess STRIPE_WEBHOOK_SECRET --backend pinned-web --project "$P"`.
4. Both exist (metadata only):
   `gcloud secrets describe STRIPE_SECRET_KEY --project "$P" --format="value(name)"`,
   same for `STRIPE_WEBHOOK_SECRET`. Say so on PIN-210.

**Merge order.** Live billing comes in two pieces (Robin, Oct 31):

1. **This runbook and the operator scripts** (PIN-210, #182) merge
   to `dev` before the Nov 3 freeze. They change nothing on prod or
   dev: the scripts only run from an operator machine.
2. **The prod switch** is a separate config-only PR (PIN-210, "turn
   on live billing on prod"). It adds one block to
   `apphosting.prod.yaml`: `PLUS_MODE=stripe`, both secret references
   and `POLICY_OVERRIDES_JSON={"credits":{"enabled":true,"starterMakes":5}}`
   (the dev backend ignores that file). Merge it only after step 4.
   If that happens before the freeze, it rides promotion #2. If not,
   run a config-only promotion as soon as step 4 is done, even during
   judging week (`docs/DEPLOY.md` §4 recipe, §8). `dev` is frozen by
   then, so that promotion carries only the switch.

**Smoke after the rollout.** `GET https://pinneds.com/api/health`
shows `plusMode: "stripe"`; a webhook POST with a bad
`Stripe-Signature` answers 400; a new board shows 5 creations.
Robin buys the €2.99 pack **on the demo board** with a real card
and keeps it (`docs/DEPLOY.md` §6.4: the demo board is a normal
board, and this makes it a paying customer's board). Checkout says
"Board Plus · 20 creations", the demo board shows Plus and 20 more
creations, and the endpoint's delivery in Workbench is 200. Refund
check, on a throwaway board: buy the pack again, then refund it in
the Dashboard (Payments → the payment → Refund, full). The refund
events claw back the 20 creations; the board keeps Plus (see
Follow-ups). Then
`node --env-file=.env.local scripts/billing-reconciliation.mjs --env-var STRIPE_PINNED_PROD_READ_KEY --live --i-understand-live --project "$P"`
exits 0 (`clean=true`), and the setup key is deleted.

**Rollback.** Set `PLUS_MODE` to `off` in `apphosting.prod.yaml`
and roll out `main`: buying answers "unavailable" and the webhook
503s, so Stripe retries a delivery for up to three days (a paid
session grants once billing is back, or refund it). The pool
stays on; `"enabled":false` in the override stops it too.
Stopping for good: disable the endpoint in Workbench.

## Follow-ups

- Host hand-off / re-issue (and sign-in linking, above).
- A distributed limiter for the host routes. Today's brake uses the
  shared in-process `checkRateLimit`, a soft limit per instance.
- Adopt `request-guards.ts` on the other state-changing routes.
- UI behaviour for a Plus skin whose grant stopped counting.
- PIN-181: revoke (or keep, by decision) Plus when a purchase is
  fully refunded or a dispute is lost. v1 claws back the makes
  only; the board keeps its `stripe` grant.
- PIN-181 UI slice: the one-purchase sheet, "creations" copy and
  the removal of `plus.priceLabels` landed in PIN-182; the
  indicator's thresholds, the out-of-creations invitation, Board
  Plus in the you menu and Change look for members landed in
  PIN-183.

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
- PIN-153: `src/domain/billing-reconciliation.test.ts` (pure
  report over fakes: matched pair clean, paid-no-grant,
  grant-no-payment, mapped-id matching, dead-letters by
  reason, pending past TTL, dedupe, operator-script mirror)
  and `src/billing/webhook-endpoint.test.ts` (exact 11-event
  list + dev URL, create/reuse/drift/wildcard plans,
  ensure-script mirror incl. the pinned API version).
- PIN-210: `src/billing/stripe-operator-mode.test.ts` (key-prefix
  and flag matrix; prod URL/project defaults; all three scripts
  spawned with a fake `fetch` and a fake `gcloud`: refusals make
  no call, live/sandbox dry-runs only read, live apply pipes the
  signing secret into prod over stdin and mirrors IAM there) and
  the live-mode cases in `src/billing/catalog.test.ts`.
- PIN-178: `src/server/stripe-webhook.test.ts` (paid at 30:30,
  after the return redirect, after a cap check expired the
  intent, async success two days later all grant; paid after
  `expired` dead-letters; won card dispute restores in full;
  `lost` claws once in either order with `funds_withdrawn`;
  dead letters re-run on Resend, processed events stay
  duplicates), `src/server/checkout-intent.test.ts` (expired
  intents close, freed slot stays freed, memory + fake
  Firestore), `src/server/credit-checkout.test.ts` (return
  resolver only reads) and the route's 413 + slug-redacted 500
  log in `src/app/api/billing/stripe-webhook-routes.test.ts`.
- PIN-181: `src/billing/catalog.test.ts` (one live pack,
  retired archive plans, full mirror equality),
  `src/policy/policy.test.ts` (defaults + `plusOnPurchase`),
  `src/domain/plus.test.ts` (`decidePurchasePlusGrant`),
  `src/server/stripe-webhook.test.ts` (stored terms after a
  Policy change, legacy fallback, zero/three-decimal FX dead
  letters, Plus once, retry repair, no downgrade, mock
  replaced, flag off, `plus_grant_unavailable`),
  `src/server/board-plus.test.ts` and
  `src/app/api/boards/plus-routes.test.ts` (member skin with and
  without Plus, uniform 403, `canChangeLook`).
