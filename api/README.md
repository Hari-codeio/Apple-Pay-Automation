# @apple-pay/api

The Apple Pay domain verification service. Repo-level setup lives in the
[root README](../README.md); this covers the flow in depth and the runbook.

## Module map

| Module                 | Responsibility                                                                 |
| ---------------------- | ------------------------------------------------------------------------------ |
| `apple-portal/`        | The only code that touches Apple. Playwright driver, session store, selectors. |
| `domain-verification/` | Orchestration, MySQL repository, HTTPS probe, controllers, renewal sweep.      |
| `database/`            | mysql2 pool, `SqlParam` type, readiness probe, boot warm-up.                   |
| `observability/`       | pino logger, request-id AsyncLocalStorage, one access-log line per response.   |
| `health/`              | `/healthz`, `/readyz`, and the probe registry other modules register into.     |
| `common/`              | Exception filter, API-key guard, CORS policy, trust-proxy coercion, constants. |
| `config/`              | The Zod schema applied to `process.env` at boot.                               |

## Running the flow

```bash
# Full flow, watching the output
pnpm apple:verify pay.example.com

# Attribute the domain to a store
pnpm apple:verify pay.example.com --store-code 1042

# Register and store, but do not ask Apple to verify yet — for when the
# association file needs a separate deploy before it is reachable
pnpm apple:verify pay.example.com --skip-verify
```

Or over HTTP:

```bash
curl -X POST http://localhost:3000/api/domain-verifications \
  -H 'content-type: application/json' \
  -H "x-api-key: $API_KEY" \
  -d '{"domain":"pay.example.com","storeCode":1042}'
```

`POST /domain-verifications` is **safe to retry**. An already-registered domain
skips the Add Domain step and re-downloads the existing file, so a retried run
does not fail on "domain already exists".

## What lands in the database

One row per domain — `domain` is `UNIQUE`, so re-registering replaces the
association file rather than accumulating history. `created_at` and
`apple_date_created` are left untouched on update, so first-seen stays first-seen.

| Column                    | Written by                                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| `id`                      | `randomUUID()` on insert                                                   |
| `domain`                  | Normalized: lower-cased, no scheme/port/path/wildcard                      |
| `verification_file`       | The downloaded file, byte-for-byte                                         |
| `content_sha256`          | SHA-256 of that file — what the probe compares against                     |
| `status`                  | `pending` → `active` on confirmed verification, `failed` on a failed probe |
| `last_probe_at/_ok`       | Every probe, success or failure                                            |
| `last_verified_at`        | Only when Apple explicitly confirms                                        |
| `verification_expires_at` | Apple's own `Verification Expires` date, scraped after it verifies         |
| `is_deleted`              | Soft delete. Nothing here ever issues a `DELETE`.                          |

`verification_expires_at` is Apple's value, not ours. Apple issues it only when it
verifies a domain and shows it only in the Merchant Domains list, so the column is
`NULL` between registration and successful verification. It is never computed:
`VERIFICATION_TTL_DAYS` previously set it to `now + 365 days` against a real Apple
window of roughly 90, which made every row look fresh for months after Apple had
stopped trusting it.

When the date cannot be read — Apple changed the DOM, or the copy — the run logs at
`error` and the column is left as it was rather than being overwritten with `NULL`.
A `NULL` here is invisible to the renewal query, which filters on `IS NOT NULL`, so
grep the logs for `expiry` before trusting an empty column.

## Runbook

Errors are typed so each one names its own fix, and each maps to a distinct
status. This is deliberate: "automation failed" gives every alert the same
useless triage.

| Symptom                                                       | Status | Cause                                        | Fix                                                     |
| ------------------------------------------------------------- | ------ | -------------------------------------------- | ------------------------------------------------------- |
| `No stored Apple portal session at …`                         | 503    | Never authenticated, or the file was lost    | `pnpm apple:login`                                      |
| `Apple portal session is not authenticated`                   | 503    | Session expired; Apple redirected to sign-in | `pnpm apple:login`                                      |
| `found none of its selectors`                                 | 502    | Apple changed the portal DOM                 | Open the trace, update `apple-portal/selectors.ts`      |
| `Apple portal rejected '<step>'`                              | 502    | The portal answered, and its answer was no   | Read the quoted portal message                          |
| `Association file … is not live at <url>`                     | 409    | File stored but not served yet               | Deploy it, then `POST /:domain/reverify`                |
| `downloaded … is an HTML document`                            | 502    | An error page came back as the "download"    | Usually an expired session — `pnpm apple:login`         |
| `verification: "unknown"`                                     | 200    | Apple gave no explicit verdict               | Check the portal; the row stays `pending`, not `failed` |
| `/readyz` → `{"checks":{"mysql":"fail"}}`                     | 503    | Database unreachable or credentials wrong    | See below                                               |
| `HANDSHAKE_SSL_ERROR: unable to get local issuer certificate` | —      | Cluster CA is not in Node's trust store      | Set `DB_SSL_CA_PATH` to the RDS bundle                  |

There is deliberately **no** option to skip TLS certificate verification. An
unverifiable certificate is a configuration problem to fix, not one to switch off.

## Failed runs leave evidence

With `PLAYWRIGHT_TRACE_ON_FAILURE=true` (the default), a failed portal
interaction writes a trace to `PLAYWRIGHT_TRACE_DIR`:

```bash
npx playwright show-trace .artifacts/traces/register-pay.example.com-<ts>.zip
```

Traces contain full page snapshots of an authenticated session — treat them as
sensitive. `.artifacts/` is gitignored. Downloaded association files are kept in
`PLAYWRIGHT_DOWNLOAD_DIR` for post-mortem comparison against what the row holds.

## Which browser gets driven

| `BROWSER_CHANNEL` | `BROWSER_USER_DATA_DIR` | Result                                                                 |
| ----------------- | ----------------------- | ---------------------------------------------------------------------- |
| `chromium`        | unset                   | Playwright's bundled Chromium, throwaway profile + `storageState` JSON |
| `chrome`/`msedge` | unset                   | Real installed Chrome/Edge, throwaway profile + `storageState` JSON    |
| `chrome`          | set                     | Real Chrome with a persistent profile — **the profile is the session** |

The persistent-profile mode is the more durable one. Apple's "trust this browser"
decision lives in the profile alongside device-binding state that a
`storageState` JSON does not capture, so it survives 2FA re-prompts that would
otherwise force another `apple:login`.

Two constraints, both enforced by Chrome rather than by us:

1. **Chrome cannot be running against that directory.** Chrome holds a
   process-singleton lock on a profile, so a shared directory means quitting your
   browser before every run. Use a dedicated directory — the default
   `.playwright/chrome-profile` is gitignored.
2. **Branded channels are not downloaded.** `playwright install` only fetches
   `chromium`; `chrome` and `msedge` must already be on the machine, or the launch
   fails. The channel is validated at boot so a typo fails there instead.

The profile directory holds a live Apple session. Treat it exactly like the
session file: never commit it, never copy it.

## Maintaining selectors

`apple-portal/selectors.ts` is the single place to edit when the portal changes.
Each control is resolved most-specific-first:

1. **Scoped to the section mentioning the domain.** The only correct choice once
   more than one domain is registered — the structural selector matches every row.
2. **The structural selector** captured from the portal (`#form-merchantId > div > …`).
3. **An accessible-name fallback** (`button:has-text("Add Domain")`), which
   survives layout changes that positional selectors do not.

Sign-in selectors are intentionally **not** on the unattended path. They are
best-effort prefill inside `apple:login`, where a stale selector costs a keystroke
rather than a failed run.

## Tests

```bash
pnpm test           # unit
pnpm test:e2e       # HTTP surface, real Nest app, stubbed MySQL
```

Neither suite reaches the network, the Apple portal, or the shared database. The
repository's SQL is asserted directly against mocks — including that no statement
anywhere is a `DELETE`, and that the upsert avoids MySQL 8.0.20's deprecated
`VALUES()` form.

The e2e suite gives each test its own `X-Forwarded-For` so the per-client rate
limiter stays switched **on** rather than mocked away; that also proves
`trust proxy` is wired, without which one noisy caller would exhaust the limit for
everyone.
