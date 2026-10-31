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
- `AUTH_MODE=optional`: a participant *may* sign in with Google.
  The link-only board flow keeps working unchanged; sign-in only adds
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
   in a console cannot sign anyone in by itself. PIN-160: the
   exchange refuses a cross-site request (403 `cross_site`) or a
   non-JSON body (415) before any body read, so another site
   cannot plant its own session in a visitor's browser (login
   CSRF).
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
   reads only — no new Firestore index). Freshness (PIN-94,
   narrowed by PIN-160): the user cookie carries the token's
   `auth_time`, and the Policy `authFreshWindowMs` window
   (default 1h) now protects restore only — the one path that
   mints a participant cookie from the account alone; a stale
   restore restores nobody. The explicit claim route keeps its
   check (401 `stale_auth`), but join and board-open link the
   same participant at any sign-in age anyway (the browser
   already holds both cookies), so boards land in My boards
   for any signed-in session. Signing in again refreshes
   `auth_time`; a stale session still reads `/api/me` and the
   library. The join route refuses cross-site and non-JSON
   requests (403/415, PIN-160), so another site cannot set an
   attacker-known participant cookie for that link to pick up.

## What is stored

`users/{uid}` holds `uid`, optional `displayName` / `photoUrl`
from the token, and timestamps. **Email is never stored** —
nothing sends mail or keys identity off an address; the token's
email claim is not even read. The profile and board index
persist until a future account-deletion flow lands (not yet
built; one board's row goes with "Remove from My boards",
PIN-166); `userSessionDays` bounds the cookie only.

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

## Auth domain: sign-in on the app's own host (PIN-163)

By default the web config's `authDomain` is the
`NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` secret, the project's
`{project}.firebaseapp.com`, so Google's account chooser names
that address. Putting the app host in the secret alone does not
work: Firebase's sign-in helper lives at the reserved `/__/auth/*`
paths, which Firebase Hosting serves and App Hosting does not
(`https://dev.pinneds.com/__/auth/handler` was the app's 404).

`AUTH_SAME_ORIGIN=1` (only with `AUTH_MODE=optional`) closes the gap:

1. Proxy: `next.config.ts` adds exactly one rewrite,
   `/__/auth/:path*` to
   `https://{FIREBASE_PROJECT_ID}.firebaseapp.com/__/auth/:path*`
   (`src/domain/auth-proxy.ts`). Nothing else is proxied. Flag off,
   link-only, or a project id that is not a valid GCP id means no
   rewrite at all, so the destination is never env-typo or
   attacker controlled. Rewrites are computed at build: the flag,
   `AUTH_MODE` and `FIREBASE_PROJECT_ID` must be BUILD-available
   (plain `value:` entries in `apphosting*.yaml` are). The proxied
   request carries the browser's headers, cookies included, to the
   project's own firebaseapp host, where only Firebase's reserved
   helper answers on these paths.
2. authDomain: `src/config.ts` then serves the host of
   `APP_BASE_URL` instead of the secret — only for an https
   `APP_BASE_URL` and a valid project id (the proxy must exist);
   otherwise the secret's value, unchanged. The client project id
   always comes from `FIREBASE_PROJECT_ID`: `resolveAuthUi` never
   derives one from a non-firebaseapp authDomain.
3. Flag off (the default, and prod today) is byte-identical to
   before; rollback is removing the flag and rebuilding.

Operator step, per environment (console, not code):

- Google Cloud console → APIs & Services → Credentials → the
  project's web OAuth client → add the authorized redirect URI
  `https://{app host}/__/auth/handler`, and keep the app host in
  Firebase Authentication → Settings → Authorized domains.
- Dev: done Oct 30 for `dev.pinneds.com`; `apphosting.dev.yaml`
  sets `AUTH_SAME_ORIGIN=1`.
- Prod, at promotion: add `https://pinneds.com/__/auth/handler`
  to the prod project's web client, confirm `pinneds.com` is an
  authorized domain, then set `AUTH_SAME_ORIGIN: "1"` beside
  `AUTH_MODE: optional` in `apphosting.prod.yaml`.
- Smoke after the rebuild: `GET https://{app host}/__/auth/handler`
  answers 200 (not the app's 404), and the Google chooser names
  the app host.

## Sign-in UI + My boards + restore (PIN-84)

The client half of PIN-57b, still behind the same gates:

1. Visibility: `resolveAuthUi` (src/domain/auth-ui.ts) enables
   the UI only when `AUTH_MODE=optional` AND the public web
   config is complete (`NEXT_PUBLIC_FIREBASE_API_KEY`,
   `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` or the app host with
   `AUTH_SAME_ORIGIN` (PIN-163, above), project id from
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
   signed out. Each card's More menu has "Remove from My boards"
   (PIN-166): `DELETE /api/me/boards/{slug}` deletes the caller's
   own index row AND clears `userId` on the caller's own
   participant there (only when it carries that uid) — never the
   board, nor anyone else's row or claim. The row alone would not
   hold (the next signed-in join or fresh `/claim` rewrites it).
   Side effects: the board's pins leave My pins and restore on
   another device stops for it. Opening the board in a browser
   that still holds that place links it again (PIN-160). Guards:
   cross-site 403 and `Policy.myBoardsRemovePerIp` 429 before any
   read; success is always 204, row or not.
4. Restore + auto-claim: in optional mode, `GET
   /api/boards/{slug}` with a user session but no participant
   cookie re-issues the participant cookie when the user holds
   a claim on that board (the slug link is still required —
   sign-in never substitutes for it), and an unclaimed
   participant opening a board while signed in is claimed
   silently. Restore rotates `cookieSecretHash` like the
   reclaim-PIN path, so the previous device's cookie stops
   working — the single-hash record cannot hold two live
   cookies. Restore needs a fresh sign-in (PIN-94); the silent
   claim works at any sign-in age (PIN-160). Neither runs for a
   request the browser labels cross-site (`Sec-Fetch-Site` other
   than `same-origin`): the view is served, nothing is linked
   and no cookie is set. Failures degrade to the plain
   link-only view.
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
   capped at Policy `libraryPageSize` (default 60). Only
   PINNED things are listed (PIN-125): a candidate still in
   review, left out, or cleared from the board's leftovers
   line keeps its element but never shows in the library
   (one pin read per board filters them). Cards
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
   cascade), and the last record out frees the bytes. Records
   on a deleted board never count (PIN-169).
   `BoardRepository.listElementsBySource` backs the guard;
   its Firestore form needs the `sourceElementId` collection-
   group field index declared in `firestore.indexes.json`.

## Scene delete (PIN-142, parent PIN-132)

`DELETE /api/boards/{slug}/scenes/{sceneId}`: the scene's maker
(participant cookie) or the board host (host cookie, see
`docs/15-board-plus.md`). After the slug gate and the cross-site 403
(no I/O), every failure before authorization is the uniform 404: no
or garbled cookies, unknown board or scene, another board's scene,
anyone else. Only the maker or host can see a 409 (still developing)
or the 204; a repeat is a 204 no-op for them, a 404 for others.
The full image and its preview are deleted (best-effort, only inside
the scene's own `scenes/boards/{slug}/{sceneId}/` folder); the Scene
stays as a
tombstone (`hidden`, `deletedAt`, `deletedBy: "maker" | "host"`) so
remix chains hold, and the repository never rewrites a tombstone.
Browsers that already fetched the image may keep it until the image
route's `max-age` ends. The board view marks each scene `canDelete`
(maker or host; only a UI hint, PIN-143), so a host's Delete shows
after the first client poll (the page render has no host cookie).

## Board delete (PIN-167)

`DELETE /api/boards/{slug}`: the board's host only (host cookie).
Bodyless. After the slug gate come the cross-site 403 and the
`Policy.boardDeletePerIp` 429, before any read; every other failure
is the uniform 404 (no or bad host cookie, another board's host, an
unknown or already deleted board), never the Plus routes' 403. On
success (204) the repository tombstones the board (`deletedAt`, set
once, in a transaction against the counter writers). From then on
`getBoard` returns null and every write that names the board or one
of its records is refused, so every board route, page and image
answers exactly as for a slug that never existed, and nothing brings
it back. Handlers that never read the board see it gone too: no
participant cookie resolves on it, and nothing on it is anyone's
(My pins thumbnail, pin-from-library source). Each linked member's
`users/{uid}/boards/{slug}` row is deleted; the index writer skips a
deleted board and re-checks after writing, and My boards skips one
anyway. Jobs in flight are not waited for: their board-record writes
(elements, pins, scenes, events) are refused and they end quietly,
but a job already running can still finish its AI call, update its
own job doc and debit one make from the board's credit account. The
Firestore records stay (no route serves them; the shared-asset check
below reads them). A library copy of a thing made on another live
board before the delete keeps working for its owner (it shares the
original's bytes). Concurrent deletes: only the call that set the
tombstone gets 204; the other gets the uniform 404. Errors on these
paths are logged with slug-shaped tokens blanked
(`src/server/safe-log.ts`).

Storage (PIN-169, `src/server/board-storage.ts`): then the board's
three folders, built from the valid slug with the trailing slash —
`tmp/boards/{slug}/`, `elements/boards/{slug}/`,
`scenes/boards/{slug}/` — are listed and emptied, best-effort (never
fails the 204; errors logged by name only). Only an element folder
whose cut-out a library copy on a live board still points at stays
whole, decided from storage, so it holds even when the source record
was deleted earlier. Records on deleted boards never count as
needing bytes (here and in `deleteMyElement`), so the last live copy
going frees them: deleting that copy, or deleting its board (the
sweep frees a copy's bytes in another board's element folder once
nothing live needs them). A job that outlives its board (decompose,
tap-add, scene, first preview render) sweeps again before it
returns, so the objects it wrote with no record go too. The sweep is
a no-op for a bad slug or a live board and can be re-run; nothing
schedules a re-run yet.

Client (PIN-168): the host's "you" menu has a danger **Delete board**
(after the first poll says `viewer.isHost`; never for anyone else).
It opens a sheet that names the board, says it is gone for everyone,
pictures included, and can't be undone; focus starts on Keep board,
Escape and the scrim keep the board, and nothing closes it while the
delete runs. The page pauses its poll before the DELETE goes out: the
server marks the board deleted before it answers (the picture sweep
runs after), so a poll in that window would 404 on the host's own
delete. On 204 the page clears the board's query cache and replaces
itself with `/me/boards?deleted=1` (signed in) or `/?deleted=1`, which
show a one-line "Board deleted" notice and strip the flag (no slug
travels). A 404 (already deleted, or no longer the host) or any other
failure keeps the board, resumes the poll and says so in the sheet.
Everyone else with the board open: the board poll's 404 (not a
generic load error) renders the same not-found as an unknown link,
which unmounts the board and so ends the polling.

## Thing rename (PIN-156, parent PIN-134)

`PATCH /api/boards/{slug}/elements/{elementId}` with JSON
`{ label }`: the thing's owner only (participant cookie). After the
slug gate come the checks that read nothing, so they answer the same
for every element: cross-site 403, non-JSON 415, a body over
`Policy.elementRenameMaxBytes` 413. Then every miss is the uniform
404: no or garbled cookie, unknown board or element, another board's
element, anyone else's, whatever label they send. Only the owner can
see the 400 (no visible character; C0/C1 or bidi controls, tag
characters or lone surrogates; or over
`Policy.elementLabelMaxChars` code points; never truncated) or the
200 with the board view's public element. The label is trimmed and
its whitespace collapsed (`src/domain/element-label.ts`). No AI call
and no BoardEvent. Scenes store only `elementIds`, so a scene made
before the rename credits the new name; library copies keep their
own label.
