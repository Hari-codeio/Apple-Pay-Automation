# apple-pay-automation

pnpm workspace. NestJS API (`api/`) that drives the Apple Developer portal with
Playwright to register a merchant domain, store the association file Apple
generates, confirm it is live at the domain, and record the real
`Verification Expires` date Apple publishes. Shared packages in `packages/`.

## Commands

Always from the repo root — the root package forwards each with `--filter`, so
relative paths resolve identically.

| Command                    | What                                                |
| -------------------------- | --------------------------------------------------- |
| `pnpm build`               | Build every package, topological order              |
| `pnpm lint`                | ESLint across the workspace                         |
| `pnpm test`                | Unit tests                                          |
| `pnpm test:e2e`            | HTTP surface against a real Nest app, stubbed DB    |
| `pnpm format:check`        | Prettier, whole repo                                |
| `pnpm start:dev`           | API with watch                                      |
| `pnpm apple:chrome`        | Launch/attach the debug Chrome the flow uses        |
| `pnpm apple:login`         | One-time interactive Apple session capture          |
| `pnpm apple:verify <host>` | Whole flow from the CLI (same path as the endpoint) |

Skills: `register-apple-domain` (full flow), `verify-apple-domain` (reverify an
already-registered domain), `register-domain` (reference + troubleshooting, owns
`check-row.mjs`).

## Architecture invariants (do not "fix" these)

- **`verification_expires_at` is Apple's value, never computed.** Apple issues it
  only when it verifies, and shows it only in the Merchant Domains list. It is
  `NULL` between registration and verification. A `now + N days` guess is the bug
  this service was built to remove — the old 365-day TTL was ~4x Apple's real
  ~90-day window, so rows looked fresh for months after Apple stopped trusting
  them.
- **The association file is downloadable only on the post-Save confirmation
  screen.** Never from the domain list. So a domain Apple already lists cannot be
  re-registered — the recovery path is `reverify` against the stored file.
- **Register → store → probe → verify, in that order.** Apple fetches the file
  from the domain during verify, so it must be stored and live first. The probe
  compares SHA-256, not just reachability: a stale cached copy passes a
  reachability check and then fails at Apple.
- **One replica, `Recreate` strategy.** Concurrent registrations are
  de-duplicated in an in-process Map, the Apple session lives on one
  ReadWriteOnce volume, and the renewal cron must fire on exactly one pod.
- **`verification: 'unknown'` is a failure, not a pass.** Apple gave no verdict;
  the row stays `pending` and a human looks at the portal.
- **The `.txt` suffix on `/.well-known/apple-developer-merchantid-domain-association.txt`
  is load-bearing.** The extensionless path 404s on this merchant's domains.
- **No ORM, no migrations.** `phoenix_release` is shared with the CRM backend and
  this service is a guest in its schema. Every statement is parameterized and
  names its columns; there is one `INSERT`, four `UPDATE`s, and no `DELETE`
  anywhere (`is_deleted` instead).
- **Timestamps are written as explicit UTC.** The driver runs `dateStrings: true`
  because converting a timezone-less DATETIME with the process timezone silently
  shifts every value.
- **All portal selectors live in `api/src/apple-portal/selectors.ts`.** When a run
  fails on a selector timeout, that file is the only one to edit — read the
  Playwright trace first.

## Deploys

`chart/` is the Helm chart; `deploy/<env>/values.yaml` holds per-env overrides.

```bash
helm upgrade --install apple-pay-automation ./chart \
    --namespace <env> \
    -f ./deploy/<env>/values.yaml \
    --set app.image.repository=ghcr.io/phoenixtechnologies-io/apple-pay-automation \
    --set app.image.tag=$GIT_SHA \
    --set deployment.sha=$GIT_SHA
```

Chart changes are gated by `scripts/helm-precommit.sh` (helm lint +
helm-unittest against all three envs), wired through lint-staged.

The image is built from `api/Dockerfile` with the **repo root** as context.

## Never

- Never compute or default `verification_expires_at`. Store `NULL` and log loudly.
- Never claim `verified` without reading it back from the portal.
- Never retry Apple verification in a loop — it is rate-limited per account.
- Never run the renewal cron on more than one deployment against one Apple account.
- Never commit `api/.env`, `api/certs/*.pem`, or anything under `api/.playwright`
  — the session file is a live credential.
- Never disable TLS verification to work around an RDS handshake failure; set
  `DB_SSL_CA_PATH` to the RDS bundle.
