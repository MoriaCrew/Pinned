# 10 — Custom domains (pinneds.com)

Status: Firebase domains created 2026-10-28; DNS applied at
GoDaddy the same day. Ownership is ACTIVE for apex + dev;
certificates provision automatically once Firebase re-checks
(can take up to 24h). The `hosted.app` URLs keep working
regardless.

## Mapping

| Domain | Firebase project | Backend |
|---|---|---|
| `dev.pinneds.com` | moriacrew-pinned-dev | pinned-web |
| `pinneds.com` | moriacrew-pinned-prod | pinned-web |
| `www.pinneds.com` | moriacrew-pinned-prod | 301 redirect to apex |

Domains were created with the App Hosting REST API
(`projects.locations.backends.domains.create`).

## DNS shape (values intentionally not copied here)

DNS records are public — anyone can query them — but the repo
does not need to duplicate the exact claim/challenge values.
They go stale and Firebase can re-print them at any time:
GET the domain resource and read
`customDomainStatus.requiredDnsUpdates`.

What each hostname needs at the registrar:

- An `A` record per hostname (@, www, dev) to the App Hosting
  IP Firebase reports. No AAAA records on these hosts.
- A `TXT` ownership record per hostname (`fah-claim=...`).
- A `_acme-challenge_*` `CNAME` per zone for certificate
  issuance/renewal — keep these after setup.
- No other A/CNAME records on @, www, or dev (stale registrar
  parking records block validation).

## After DNS

1. Re-check status per domain (GET the same REST resource);
   complete = `HOST_ACTIVE`, `OWNERSHIP_ACTIVE`, `CERT_ACTIVE`.
2. Flip `APP_BASE_URL` in `apphosting.dev.yaml` /
   `apphosting.prod.yaml` to the custom domains (separate PRs;
   prod flip still rides the weekend promotion).
3. Smoke: create a game on each domain and confirm generated
   links use it (public-origin prefers configured origin).
4. Sign-in on the domain (PIN-163): add the OAuth redirect URI
   `https://{domain}/__/auth/handler` and set `AUTH_SAME_ORIGIN=1`
   for that backend (docs/13-auth.md, "Auth domain").

## Naming

The product is now **Pinneds** (pinned.com was taken).
User-visible strings use Pinneds; internal identifiers
(repo, cookie names, env vars, backend ids, PIN-xxx) keep
`pinned` — renaming those buys nothing and risks breakage.
