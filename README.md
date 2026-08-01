# Apple Pay Automation

Automates Apple Pay **merchant domain verification**: registers a domain on an
Apple Pay merchant identifier, stores the association file Apple generates so the
domain can serve it, confirms it is actually live, and then asks Apple to verify.

Conventions, tooling, and project layout follow the `php-ts-backend` reference
repo: pnpm workspace, NestJS 11, ESLint 9 flat config, Prettier, fail-fast Zod
boot validation.

## The flow

```
1. Apple portal    register the domain on the merchant identifier      (Playwright)
2. Apple portal    download apple-developer-merchantid-domain-association
3. MySQL           store it in apple_pay_domain_verifications
4. HTTPS probe     confirm the file is live at the domain root, by SHA-256
5. Apple portal    click Verify
```

The ordering is not incidental. Apple fetches the file **from the domain** during
step 5, so steps 3 and 4 must both complete first. Step 4 compares content rather
than just reachability, because a CDN serving a stale copy of a previous
association file answers `200` and Apple still rejects it.

A failure at any step leaves a durable record of how far it got (`status`,
`last_probe_ok`, `last_verified_at`) — the recovery action differs per step, so an
operator needs to know which one to take.

## Quick start

```bash
pnpm install
pnpm --filter=@apple-pay/api playwright:install     # Chromium for Playwright

cp api/.env.example api/.env                        # then fill it in
curl -o api/certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem

pnpm apple:login                                    # once — see below
pnpm start:dev
```

Every placeholder left as `REPLACE_ME` is **refused at boot**, so a half-filled
`.env` cannot start the service.

### `pnpm apple:login` — why it exists

Apple ID sign-in is 2FA-gated. There is no password-only path to an unattended
run, so the **browser session is the credential**, not the password. This command
opens a real browser window, pre-fills what it can, and waits for a human to
complete 2FA once. The authenticated session is saved to
`api/.playwright/apple-portal-state.json` and every later run reuses it.

That file is a bearer credential for the whole Apple Developer account. It is
written `0600` and gitignored. When it expires, runs fail with a `503` whose
message says to run this command again.

## Commands

| Command                    | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `pnpm build`               | Build every package in topological order                         |
| `pnpm lint`                | ESLint across the workspace                                      |
| `pnpm test`                | Unit tests                                                       |
| `pnpm test:e2e`            | HTTP-surface tests against a real Nest app, stubbed MySQL        |
| `pnpm format`              | Prettier write                                                   |
| `pnpm start:dev`           | Run the API with watch                                           |
| `pnpm apple:login`         | Interactive one-time Apple session capture                       |
| `pnpm apple:verify <host>` | Run the whole flow from the CLI (same code path as the endpoint) |

## HTTP surface

Mounted under `/api`, except the association file, which Apple requires at the
domain root. Write routes require `x-api-key` and are capped at 5/min per client.

| Method   | Path                                                         | Purpose                                               |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| `POST`   | `/api/domain-verifications`                                  | Run the full flow. Safe to retry.                     |
| `GET`    | `/api/domain-verifications/:domain`                          | Current record                                        |
| `POST`   | `/api/domain-verifications/:domain/probe`                    | Is the file live? Touches no Apple resource.          |
| `POST`   | `/api/domain-verifications/:domain/reverify`                 | Re-probe + re-verify the stored file                  |
| `DELETE` | `/api/domain-verifications/:domain`                          | Stop serving (soft delete)                            |
| `GET`    | `/api/healthz`                                               | Process liveness. Never touches a dependency.         |
| `GET`    | `/api/readyz`                                                | Dependency readiness, per-probe detail, 503 when down |
| `GET`    | `/.well-known/apple-developer-merchantid-domain-association` | The association file (off by default)                 |

Swagger at `/docs` on dev-like tiers; refused outright when
`ENVIRONMENT=production`.

## Layout

```
api/                          NestJS deployable (@apple-pay/api)
  src/
    apple-portal/             Playwright driver — the only code that touches Apple
      selectors.ts            EVERY portal selector, in one file
    domain-verification/      Orchestration, repository, probe, HTTP surface
    database/                 mysql2 pool + readiness probe
    observability/            pino logger, request-id ALS, access log
    health/                   /healthz, /readyz, probe registry
    common/                   filters, guards, CORS, trust-proxy, constants
    config/                   Zod boot schema
    bin/                      CLI entrypoints
packages/
  config-validation/          Shared fail-fast Zod env validation
  eslint-config/              Shared flat ESLint 9 config
```

## Operational notes

**Run one replica.** The renewal sweep and the register flow both drive a single
shared Apple session and launch browsers. `CRON_ENABLED` defaults to off and
belongs on exactly one instance. The in-flight registration guard is in-process
only, by design.

**The portal DOM is not ours.** Apple changes it without notice or versioning.
Every selector lives in `api/src/apple-portal/selectors.ts`, each structural
selector is paired with a semantic fallback, and a failed run saves a Playwright
trace (`api/.artifacts/traces/`) — open it with `npx playwright show-trace <zip>`
to see the DOM as it was at the moment of failure.

**This service is a guest in `phoenix_release`.** It never runs a migration and
never issues a `DELETE`; `is_deleted` is a soft delete because the CRM backend may
still be serving an association file. There is no ORM, so there is no
`synchronize` flag to get wrong.

## Credentials

The Apple ID and database credentials for this project arrived over a Notion page
and a chat message, which means they are already outside any secret store.
**Rotate them and move them into one.** `api/.env` is gitignored, but a `.env`
file is not a secret manager.

Nothing in this repo logs a credential: the logger redacts a fixed key list
(`authorization`, `password`, `token`, `paymentData`, …), config validation
failures name variables without echoing values, and a 5xx response body never
carries an internal error message unless that message is explicitly declared
client-safe.
