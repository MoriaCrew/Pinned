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
  created the board) and today unlocks three extra skins:
  `darkroom`, `postcard`, `marigold` (`PLUS_SKIN_IDS` in
  `src/domain/plus.ts`). The free skins are `paper` (default),
  `cork`, `fridge` and `zine`. Skins are stored in the existing
  `Board.themeId`; the skin registry itself is
  `src/domain/board-themes.ts`.

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

- `POST /api/boards` sets `pinned_host_{slug}` (same naming
  pattern as the participant cookie `pinned_player_{slug}`). Its
  value is `HMAC-SHA256(SESSION_SECRET, "host:" + slug)`,
  base64url; verification is a timing-safe compare
  (`src/server/host-session.ts`).
- Attributes match the participant cookie: `HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Secure` on https; life is
  `Max-Age` = `Policy.plus.hostCookieDays` (default 365).
- Domain separation: participant cookies sign a base64url JSON
  body (no `:` possible) and user cookies a `pinned-user-v1:`
  prefix, so no other cookie this server mints verifies as a
  host token.
- No `SESSION_SECRET` (or one under 32 chars): no host cookie is
  set, the board is still created, and every host-only route
  answers 403 — the same degrade as joining without a secret.

**Limits (deliberate for v1):**

- Host = the creating browser. Another device, a cleared cookie
  jar or a private window is not the host. There is no hand-off.
- The token is stateless and deterministic per (secret, slug):
  no server-side expiry and no per-board revocation. Rotating
  `SESSION_SECRET` revokes every host token — and signs every
  participant out too.
- **Follow-up:** attach host status to a signed-in user
  (`AUTH_MODE=optional`): record the creator's uid at create time
  when signed in, or let a request carrying both the host cookie
  and the user cookie claim the board. That also gives the host
  plan something to hang on (a user, not a board) so it can
  really cover all of that host's boards, and makes host status
  portable across devices.

## API

Every `[slug]` route runs the slug gate first (malformed slug →
the uniform 404). Host-only routes then check, in order: host
cookie (403, also for unknown boards — no existence oracle) →
board exists (404) → input (400) → entitlement (402) → write.
Error bodies are `{ error, code }`.

- `PATCH /api/boards/{slug}/skin` `{ skinId }` → 200 `{ board }`.
  403 `host_only`; 400 `skin_unknown` (not `isBoardThemeId`);
  402 `plus_required` for a Plus skin on a board without Plus.
- `POST /api/boards/{slug}/plus` `{ plan: "board" | "host" }` →
  200 with one of `{ status: "granted", plus }`,
  `{ status: "unavailable" }` (PLUS_MODE=off; nothing written) or
  `{ status: "redirect", url }` (reserved for Stripe). 403
  `host_only`; 400 `plan_unknown`.
- `POST /api/boards` (create): unchanged body; additionally sets
  the host cookie. A Plus skin as the initial `themeId` is 402
  `plus_required` (a new board holds no entitlement).
- `GET /api/boards/{slug}` (board view), additive fields:
  - `viewer: { isHost: boolean }`
  - `plus: { active: boolean, plan?: "board" | "host", mode:
    "off" | "mock", priceLabels: { board, host } }`

  The entitlement's `source` and `grantedAt` never leave the
  server.
- `GET /api/health` additionally reports `plusMode`.

## Data

`Board.plus?: { plan, source: "mock" | "stripe", grantedAt }`.
Absent = free board. Skin and Plus are written only through
`BoardRepository.updateBoardSettings(slug, patch)`: one atomic
read-modify-write (a Firestore transaction on the board doc) that
bumps `Board.version` by exactly one and never touches counters.
A skin change also replaces the stored theme tokens with the new
skin's tokens, or removes them, so an old palette never lingers.

## `PLUS_MODE`

Read only in `src/config.ts`; anything but the exact value `mock`
is `off`. Adapters live in `src/billing/` behind the `Checkout`
port (`startCheckout({ slug, plan })`).

- `off` (default; prod): every checkout answers `unavailable` and
  writes nothing. The UI should present Plus honestly as not
  available yet — never a buy button that pretends.
- `mock` (dev backend via `apphosting.dev.yaml`; locally via
  `.env.local`): grants the entitlement at once with
  `source: "mock"`. No money moves; the UI must say it is a demo.
  The stored source keeps mock grants distinguishable forever.
  Never set `mock` on prod.

Check a backend with `GET /api/health` → `plusMode`.

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
   the raw body. `checkout.session.completed` writes
   `{ plan, source: "stripe", grantedAt }` through
   `updateBoardSettings`; subscription `deleted` / unpaid and
   refunds/disputes revoke (needs a revoke field in the patch).
   The success redirect never grants — only the webhook does.
4. **Idempotency by Checkout Session id:** record each processed
   session id with a create-if-absent doc (e.g.
   `billing/sessions/{sessionId}`) in the same transaction as the
   grant, so a webhook retry or replay is a no-op. Use an
   idempotency key when creating sessions too.
5. The host plan becomes truly cross-board only once host status
   lives on a signed-in user (see the follow-up above).

## Tests

`src/domain/plus.test.ts`, `src/server/host-session.test.ts`,
`src/billing/checkout.test.ts`, `src/server/board-plus.test.ts`,
the shared repository contract
(`src/domain/board-repository.contract.ts`, memory + fake
Firestore), Policy/config tests, and route tests
`src/app/api/boards/plus-routes.test.ts` (mock) /
`plus-routes.off.test.ts` (off).
