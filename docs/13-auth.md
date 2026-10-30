# 13 — Sign-in (`AUTH_MODE`, PIN-57)

Server foundation landed in PIN-83; the sign-in button (PIN-84)
and the cross-board library (PIN-85) build on it. Spec:
`docs/11-studio.md` section 5.4; the original claim flow is in
`docs/archive/02`.

## Modes

- `AUTH_MODE=link-only` (the default; prod today): board
  participants never authenticate. Every route below returns the
  uniform 404 and no user code runs on the board flow — the
  flag-off parity tests in `src/server/user-session.test.ts` and
  `src/app/api/auth/auth-routes.test.ts` are the contract.
- `AUTH_MODE=optional`: a player *may* sign in with Google.
  Link-only playing keeps working unchanged; sign-in only adds
  identity linking.

Unknown `AUTH_MODE` values fail closed to `link-only`
(`src/config.ts`, FR8).

## Flow (optional mode)

1. The client signs in with Firebase Auth (Google) and posts the
   ID token to `POST /api/auth/session`.
2. The server verifies it through the `TokenVerifier` port
   (`src/server/token-verifier.ts`): Firebase Admin
   `verifyIdToken`, lazily initialised, failing closed to 401
   when unconfigured or invalid. The repo's Firestore access
   uses `@google-cloud/firestore` directly; `firebase-admin` was
   added by PIN-83 solely for this verification. PIN-94: exchange
   always verifies with revocation checking, and only Policy
   `authAllowedProviders` (default `google.com`) may mint a
   session — enabling another Firebase provider (e.g. Anonymous)
   in a console cannot sign anyone in by itself.
3. On success the server upserts `users/{uid}` and sets the
   `pinned_user` cookie: httpOnly, SameSite=Lax, Secure on
   https, HMAC-signed via `src/domain/tokens.ts` with a
   domain-separated user payload, life `Policy.userSessionDays`
   (default 30). `GET /api/me` reads it back; `DELETE
   /api/auth/session` clears it.
4. Claim: `POST /api/boards/{slug}/claim` with both the board
   participant cookie and the user cookie sets
   `Participant.userId` when empty or already the same user,
   else 409. Joining a board while signed in does the same
   automatically (never overwriting a different user's claim,
   never failing the join). Both paths maintain the
   `users/{uid}/boards/{slug}` index (doc-get/subcollection
   reads only — no new Firestore index). PIN-94 freshness: the
   user cookie carries the token's `auth_time`, and claim,
   join/board-open auto-claim and restore (which mints a fresh
   participant cookie) all require it within Policy
   `authFreshWindowMs` (default 1h). A stale session still
   reads `/api/me` and the library normally; the explicit claim
   route answers 401 `stale_auth`, while the silent paths just
   skip — signing in again refreshes `auth_time`.

## What is stored

`users/{uid}` holds `uid`, optional `displayName` / `photoUrl`
from the token, and timestamps. **Email is never stored** —
nothing sends mail or keys identity off an address; the token's
email claim is not even read. The profile and board index
persist until a future account-deletion flow lands (not yet
built); `userSessionDays` bounds the cookie only.

## Operator steps to enable (per backend)

Status Oct 29, 2026: done for both projects. The Google
provider + authorized domains are enabled in dev and prod;
the web config lives in Secret Manager under the
`NEXT_PUBLIC_FIREBASE_*` names (referenced from
`apphosting.yaml`, never literals in git — gitleaks enforces
this). Dev runs `AUTH_MODE=optional` (PR #76); prod flips at
promotion (PIN-76). The original runbook, for a new backend:

1. Firebase console → Authentication → enable the Google
   provider for the backend's project, and add the backend's
   custom domain under Authentication → Settings →
   Authorized domains.
2. Register/copy the web app config; store
   `NEXT_PUBLIC_FIREBASE_API_KEY` and
   `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` in Secret Manager
   (`firebase apphosting:secrets:set` + `grantaccess` for the
   backend) and set `AUTH_MODE=optional` in that backend's
   `apphosting.*.yaml`. The root layout reads the values
   server-side and may prerender at build, so the shared
   config grants BUILD + RUNTIME availability — a rebuild is
   required either way.
3. Make sure the runtime service account can verify tokens
   (Application Default Credentials; App Hosting's compute
   service account works by default) and that `SESSION_SECRET`
   is set (already true on dev/prod).
4. Redeploy, then smoke: `GET /api/health` shows
   `authMode: "optional"`, `GET /api/me` answers 401 (not 404).

Until step 2 lands for a backend, the `NEXT_PUBLIC_*`
values resolve empty and the sign-in UI stays hidden even in
optional mode — no dead buttons.

## Sign-in UI + My boards + restore (PIN-84)

The client half of PIN-57b, still behind the same gates:

1. Visibility: `resolveAuthUi` (src/domain/auth-ui.ts) enables
   the UI only when `AUTH_MODE=optional` AND the public web
   config is complete (`NEXT_PUBLIC_FIREBASE_API_KEY`,
   `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, project id from
   `FIREBASE_PROJECT_ID` or the authDomain prefix). The root
   layout mounts the provider only then; the account entries
   live in each page's "you" button (PIN-120, docs/14).
   Link-only has no provider and zero auth DOM.
2. Flow: the `firebase` web SDK (app/auth only) is dynamically
   imported when sign-in starts, so link-only visitors never
   download it. Google popup first; popup-blocked falls back
   to `signInWithRedirect`, completed on return. The ID token
   is exchanged once at `POST /api/auth/session`; the httpOnly
   user cookie is the session from then on (`GET /api/me`
   hydrates the "you" button: photo or initials, menu with My
   boards, My pins + Sign out).
3. My boards: `GET /api/me/boards` and the `/me/boards` page
   list the user's claimed boards (title, theme, my pinned-pin
   count, latest ready scene thumb, last activity), newest
   activity first. Both 404 in link-only mode; the API 401s
   signed out.
4. Restore + auto-claim: in optional mode, `GET
   /api/boards/{slug}` with a user session but no participant
   cookie re-issues the participant cookie when the user holds
   a claim on that board (the slug link is still required —
   sign-in never substitutes for it), and an unclaimed
   participant opening a board while signed in is claimed
   silently. Restore rotates `cookieSecretHash` like the
   reclaim-PIN path, so the previous device's cookie stops
   working — the single-hash record cannot hold two live
   cookies. Failures degrade to the plain link-only view.
5. First-pin nudge: after the viewer's first pinned pin, a
   one-time (localStorage) invite to sign in, gated by
   Policy `signInNudge` (default true) and only ever shown
   when sign-in is available.

Live Google proof still depends on the operator steps above;
until then the hosted dev backend stays link-only and none of
this renders there.

## My pins library + pin-to-this-board (PIN-85)

The cross-board library that closes PIN-57, behind the same
gates (404 in link-only mode, 401 signed out):

1. Library: `GET /api/me/elements` and the `/me/pins` page
   list the signed-in user's elements across every board
   where their claim is live (user board index -> claimed
   participant -> `listElementsByOwner`), newest first,
   capped at Policy `libraryPageSize` (default 60). Cards
   carry the source board's TITLE only — a slug never appears
   in a library payload or URL. Each card also carries
   `familyId` (PIN-121): the original element's id for a
   library copy (`sourceElementId`), else its own id — always
   one of the caller's own things — so the Add sheet can tell
   which things already sit on the board it is open on.
2. Thumbnails: `GET /api/me/elements/{id}/image` authorizes
   by signed-in OWNERSHIP (the element's owner participant
   must be claimed by the caller), not by board link — the
   cross-board counterpart of the board-link image route.
   Every miss is the uniform 404.
3. Pin-to-this-board: `POST /api/boards/{slug}/pins/
   from-library` needs both cookies (user + a participant on
   the current board) and pins with `pinnedBy` = that
   participant; pinning twice returns `alreadyPinned`, never
   an error. The board Add sheet shows it under the photo
   target as the "From your other boards" strip (PIN-121; one
   sticker per family, things already here greyed as "Already
   here", capped at Policy `libraryStripMax`, default 12) with
   "See all" for the full list; `/me/pins?board=<slug>` offers
   the same action per card.
4. **Copy-on-pin decision (issue fallback, taken on
   purpose):** elements live in the Firestore subcollection
   under their origin board and `createPin` requires the
   element under the pin's own board, so a true cross-board
   Pin cannot be written in this layout (and the delete
   cascade assumes the same). Pinning cross-board therefore
   creates a copy Element on the target board — new id,
   `sourceElementId` provenance, the SAME cutout/flattened
   storage refs — owned by the current participant (the same
   signed-in user, so credit stays theirs). Copies compose,
   remix and cascade natively from then on. `deleteMyElement`
   guards the shared objects: deleting the original or a
   copy leaves storage alone while the other side lives (its
   scenes keep working; only the deleted side's pins/scenes
   cascade), and the last record out frees the bytes.
   `BoardRepository.listElementsBySource` backs the guard;
   its Firestore form needs the `sourceElementId` collection-
   group field index declared in `firestore.indexes.json`.
