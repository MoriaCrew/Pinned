# 10 — Custom domains (pinneds.com)

Status: Firebase side **created 2026-10-28**; waiting on GoDaddy
DNS, then certificate provisioning (automatic, can take up to
24h). The `hosted.app` URLs keep working regardless.

## Mapping

| Domain | Firebase project | Backend |
|---|---|---|
| `dev.pinneds.com` | moriacrew-pinned-dev | pinned-web |
| `pinneds.com` | moriacrew-pinned-prod | pinned-web |
| `www.pinneds.com` | moriacrew-pinned-prod | 301 redirect to apex |

Domains were created with the App Hosting REST API
(`projects.locations.backends.domains.create`). Firebase
reported `HOST_UNHOSTED/NON_FAH`, `OWNERSHIP_MISSING`,
`CERT_VALIDATING` with the DNS updates below.

## GoDaddy DNS records to apply (owner step)

In GoDaddy: Domain → pinneds.com → DNS → Records.
Hosts are relative to `pinneds.com` (`@` = apex). TTL default.

**Delete first**

| Type | Host | Value |
|---|---|---|
| A | @ | 15.197.148.33 |
| A | @ | 3.33.130.190 |
| CNAME | www | pinneds.com |

**Add**

| Type | Host | Value |
|---|---|---|
| A | @ | 35.219.200.109 |
| A | www | 35.219.200.109 |
| A | dev | 35.219.200.109 |
| TXT | @ | fah-claim=016-02-d90e69bb-b003-4f1f-aaa8-a07eb421db28 |
| TXT | www | fah-claim=016-02-124584ea-46db-48a7-bfef-ad7bf69b0468 |
| TXT | dev | fah-claim=016-02-9c36fed3-19ca-4afe-99b5-7bc0d0d3d847 |
| CNAME | _acme-challenge_ydwwebxhdyr3ykua | 4f425af2-0dca-4cca-b10e-7acee9633b6f.4.authorize.certificatemanager.goog |
| CNAME | _acme-challenge_ydwwebxhdyr3ykua.dev | 4e47ba4a-cb15-42c5-a326-ea7cd9702ce7.15.authorize.certificatemanager.goog |

Notes: do not add AAAA records for these hosts (App Hosting
serves IPv4 here). Keep the `_acme-challenge` records after
setup — certificates renew through them. The two prod domains
share one challenge host/value, so it appears once.

## After DNS

1. Re-check status per domain (GET the same REST resource);
   complete = `HOST_ACTIVE`, `OWNERSHIP_ACTIVE`, `CERT_ACTIVE`.
2. Flip `APP_BASE_URL` in `apphosting.dev.yaml` /
   `apphosting.prod.yaml` to the custom domains (separate PRs;
   prod flip still rides the weekend promotion).
3. Smoke: create a game on each domain and confirm generated
   links use it (public-origin prefers configured origin).

## Naming

The product is now **Pinneds** (pinned.com was taken).
User-visible strings use Pinneds; internal identifiers
(repo, cookie names, env vars, backend ids, PIN-xxx) keep
`pinned` — renaming those buys nothing and risks breakage.
