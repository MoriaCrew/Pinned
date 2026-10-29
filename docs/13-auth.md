# 13 — Sign-in (`AUTH_MODE`, PIN-57)

Server foundation landed in PIN-83; the sign-in button (PIN-84)
and the cross-board library (PIN-85) build on it. Spec:
`docs/11-studio.md` section 5.4; the original claim flow is in
`docs/archive/02`.

## Modes

- `AUTH_MODE=link-only` (default, everywhere today): board
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
   added by PIN-83 solely for this verification.
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
   reads only — no new Firestore index).

## What is stored

`users/{uid}` holds `uid`, optional `displayName` / `photoUrl`
from the token, and timestamps. **Email is never stored** —
nothing sends mail or keys identity off an address; the token's
email claim is not even read. The profile and board index
persist until account deletion lands (PIN-85 scope);
`userSessionDays` bounds the cookie only.

## Operator steps to enable (per backend)

1. Firebase console → Authentication → enable the Google
   provider for the backend's project.
2. Register/copy the web app config; set
   `NEXT_PUBLIC_FIREBASE_API_KEY` and
   `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` in that backend's
   `apphosting.*.yaml` (declared empty by PIN-83; they are
   public identifiers, inlined at build time — a rebuild is
   required) and set `AUTH_MODE=optional` for the backend.
3. Make sure the runtime service account can verify tokens
   (Application Default Credentials; App Hosting's compute
   service account works by default) and that `SESSION_SECRET`
   is set (already true on dev/prod).
4. Redeploy, then smoke: `GET /api/health` shows
   `authMode: "optional"`, `GET /api/me` answers 401 (not 404).

Until step 2 lands, the `NEXT_PUBLIC_*` values are empty and
the sign-in UI stays hidden even in optional mode — no dead
buttons.
