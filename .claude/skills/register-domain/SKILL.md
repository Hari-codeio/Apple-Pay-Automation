---
name: register-domain
description: Reference and troubleshooting for the Apple Pay domain flow — the typed-error table (expired Apple session, locked Chrome profile, changed portal DOM, missing RDS CA, private-RDS timeouts), the browser-mode/credential explainer, the manual step-by-step, and the check-row.mjs database reader that asserts verification_expires_at. Use when a register or verify run failed and you need the cause, when inspecting a row by hand, or when driving pnpm apple:verify manually. To just run the flow, use register-apple-domain; to verify an already-registered domain, use verify-apple-domain.
---

# Apple Pay domain flow — reference and troubleshooting

> **To run the flow, use `register-apple-domain`.** To verify a domain that is
> already registered, use `verify-apple-domain`. This skill is the manual
> procedure and the failure reference behind both, and it owns `check-row.mjs`.

Drives the real flow and then judges the result: register on Apple's portal →
download the association file → write the row → probe the file is live → ask Apple
to verify → **read the expiry Apple published and store it**.

## This touches production. Confirm before running.

A run is not a dry test:

- It registers a domain on the **live Apple Developer account** in `api/.env`
  (`APPLE_MERCHANT_ID`). This codebase deliberately cannot un-register it — removal
  is a manual action in the portal.
- It writes to **`phoenix_release`**, a shared database this service does not own.
- Apple's verification is **rate-limited**. A retry loop gets the account throttled.

So: never start step 3 without an explicit go from the user in this conversation.
Approval for one domain is not approval for the next.

## Step 1 — Get the domain

Use the domain passed as an argument. If none was given, ask for it and stop until
answered — never invent or guess one, and never reuse a domain from earlier in the
conversation without asking.

Also ask whether a `--store-code <n>` is wanted; it is optional and defaults to NULL.

## Step 2 — Preflight (read-only, safe)

Run these and report anything wrong before going further:

```bash
# env present
test -f api/.env && echo "env ok" || echo "MISSING api/.env — copy api/.env.example"

# TLS trust bundle for RDS. Gitignored, so a fresh clone will not have it.
test -s api/certs/rds-global-bundle.pem && echo "ca ok" || echo "MISSING RDS CA — see below"

# database reachable, writes nothing
node .claude/skills/register-domain/scripts/check-row.mjs --ping
```

**Where the Apple credential lives depends on the browser mode.** Check `api/.env`:

- **`BROWSER_USER_DATA_DIR` is set** (the current config) — authentication lives in
  that **Chrome profile**, not in a file. The flow attaches to a warm debug Chrome
  over CDP, falling back to launching the profile itself. So the check is "is a debug
  Chrome up, and is that profile signed in to the portal":

  ```bash
  pnpm apple:chrome     # launches/attaches debug Chrome on loopback
  ```

  Then confirm by eye that the merchant page loads without a sign-in redirect.
  `api/.playwright/apple-portal-state.json` being absent is **not** a problem in this
  mode — do not report it as one.

- **`BROWSER_USER_DATA_DIR` is unset** — the flow uses an isolated browser seeded from
  `APPLE_SESSION_STATE_PATH`, and that JSON _is_ the credential. If it is missing or
  unreadable, run `pnpm apple:login` and complete 2FA by hand.

**Always invoke these from the repo root, never `cd api && …`.** The root package
forwards each one with `--filter`, so pnpm runs it with `api/` as the working
directory and every relative path resolves identically. It also keeps the commands
copy-pasteable for the user, whose shell is **Windows PowerShell 5.1** — where `&&`
is a parser error, not a separator.

If the RDS CA bundle is missing, fetch AWS's official one to the path `DB_SSL_CA_PATH`
already points at (gitignored, never committed):

```bash
curl -fsSL -o api/certs/rds-global-bundle.pem \
  https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

Never work around a TLS failure by disabling verification — there is deliberately no
switch for it.

If `--ping` reports `ETIMEDOUT`, the cluster is not reachable from this machine.
`phoenix-test-cluster…us-west-1.rds.amazonaws.com` resolves to a **private** address,
so it needs VPC access (VPN or bastion tunnel). Stop and say so: without the database
the flow would register the domain at Apple and then fail to record it, which is the
worst outcome — an Apple-side registration with no row backing it.

Then check whether the domain already has a row:

```bash
node .claude/skills/register-domain/scripts/check-row.mjs <domain>
```

**If a row already exists, stop and tell the user.** `registerDomain` refuses a
domain Apple already lists, because Apple offers the association file only on the
confirmation screen shown right after an add — it cannot be re-downloaded. The right
move for an existing domain is `reverify`, not `register`:

```bash
pnpm apple:verify <domain>   # WRONG for an already-registered domain
```

Use the reverify path instead — see Step 3b.

Note `PLAYWRIGHT_HEADLESS=false` and `BROWSER_USER_DATA_DIR` in `api/.env`: this
attaches to a real Chrome over CDP rather than launching headless. If the run fails
to find a browser, Chrome needs to be up first:

```bash
pnpm apple:chrome
```

## Step 3 — Run the flow

Only after explicit confirmation. This opens a browser and takes minutes, so give it
a long timeout and run it in the foreground so its output is visible.

```bash
pnpm apple:verify <domain>
# optional: --store-code <n>   --skip-verify
```

It prints the `RegistrationResult` JSON. Read `status`, `verification`,
`verificationExpiresAt`, and `probe`.

### Step 3b — Already registered, or verification did not land

For a domain that already has a row and a stored file, re-probe and re-verify
without re-registering. **Use the `verify-apple-domain` skill** — it handles the
server, the probe, the Verify click, and storing the expiry, and reports the same
fixed table:

```bash
node .claude/skills/verify-apple-domain/scripts/run-verify.mjs <domain>
```

Manually, if you want the raw call: there is no CLI, so it goes through the API,
which needs the server up (`pnpm start:dev`).

```bash
curl -s -X POST "http://localhost:3000/api/domain-verifications/<domain>/reverify" \
  -H "x-api-key: $API_KEY"
```

The `x-api-key` header is only required when `API_KEY` is actually set. It is
currently blank in `api/.env`, and on a dev-like `ENVIRONMENT` (`local`,
`development`, `test`) `ApiKeyGuard` lets an unauthenticated call through rather
than serving a privileged route with no key configured.

## Step 4 — Verify what actually landed

The CLI reports what the service _returned_. This reads the row that was _written_,
and asserts the expiry:

```bash
node .claude/skills/register-domain/scripts/check-row.mjs <domain>
```

It exits non-zero if any assertion fails. It checks:

- the row exists and is not soft-deleted
- the association file body and its SHA-256 are stored
- `verification_expires_at` is populated when `status = 'active'` (and correctly
  NULL when the domain is still `pending` — Apple issues an expiry only on verify)
- the expiry is anchored to **00:00:00 UTC**, the start-of-day anchor this codebase
  stores deliberately
- the expiry is in the future and **within ~120 days**. This is the important one:
  Apple's real window is ~90 days, so anything much beyond that is a computed TTL
  rather than a scraped date — the exact bug this flow was built to fix.

Then confirm the stored date against the portal by eye. Open the merchant page,
find the domain in **Merchant Domains**, and check `Verification Expires` matches
what the row holds:

```
https://developer.apple.com/account/resources/identifiers/merchant/edit/<APPLE_TEAM_ID>/<APPLE_MERCHANT_ID>
```

A green assertion set only proves the value is _plausible_. Only the portal proves
it is _right_.

## Step 5 — Signal back

Report, compactly:

1. **Outcome** — `status` and `verification` from the CLI.
2. **Expiry** — the stored `verification_expires_at`, how many days out, and whether
   it matches the portal.
3. **DB write** — confirmed present, with `last_verified_at` and probe result.
4. **Assertions** — pass/fail, quoting any failure verbatim.
5. **Anything that needs a human** — expired session, a `pending` row awaiting a
   deploy, an unparsed expiry.

State plainly if a step did not run or could not be confirmed. A `verification` of
`unknown` is **not** success: Apple gave no verdict, the row stays `pending`, and
someone has to look at the portal.

## When it fails

Errors are typed and each names its own fix. Match the message:

| Message                                             | Cause                                   | Fix                                                                                 |
| --------------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------- |
| `No stored Apple portal session at …`               | Isolated mode with no `storageState`    | `pnpm apple:login`                                                                  |
| `Apple portal session is not authenticated`         | Apple redirected to sign-in             | Profile mode: sign in inside the attached Chrome. Isolated mode: `pnpm apple:login` |
| `connect ETIMEDOUT` on the DB                       | Private RDS, no VPC route               | Connect the VPN or open a bastion tunnel. Do not run the flow until `--ping` passes |
| `BrowserProfileLockedError`                         | The Chrome profile is in use            | Attach instead of launching: `pnpm apple:chrome`                                    |
| `found none of its selectors`                       | Apple changed the DOM                   | Open the trace, update `api/src/apple-portal/selectors.ts`                          |
| `Apple portal rejected '<step>'`                    | The portal said no                      | Read the quoted portal message                                                      |
| `is already registered on this merchant identifier` | Domain exists at Apple                  | Use Step 3b reverify                                                                |
| `Association file … is not live at <url>`           | Stored but not deployed                 | Deploy the file, then Step 3b                                                       |
| `downloaded … is an HTML document`                  | Error page came back as the download    | Usually an expired session — re-login                                               |
| `verification: "unknown"`                           | Apple gave no verdict                   | Check the portal; row stays `pending`                                               |
| `HANDSHAKE_SSL_ERROR`                               | Cluster CA missing from the trust store | Set `DB_SSL_CA_PATH` to the RDS bundle                                              |

Failed runs leave evidence — a Playwright trace under `PLAYWRIGHT_TRACE_DIR` and the
download under `PLAYWRIGHT_DOWNLOAD_DIR` (both relative to `api/`). For a selector
failure the trace shows the DOM at the moment it stopped matching; read it before
editing a selector.

## Resolved: the wrong-domain Verify click

Kept because it explains the shape of the current code and what a regression would
look like.

`verifyDomain` used to resolve the Verify button via a `<section>` containing the
domain. The list renders `div.cert-block.domain-block` with no such `<section>`, so
the lookup fell through to `.first()` on the verify buttons — the first domain on
the page. It acted on an unrelated domain and made the expiry read afterwards
untrustworthy.

It was observed live: a run stored `Oct 14, 2026` for
`phx-checkout-ssr-test1…`, which is `secureorder.divisioncheats.com`'s date. The
domain's own date was `Oct 12, 2026`.

Fixed by `findDomainBlock`, which matches a block by parsing its `Domain:` cell
exactly and scopes the click inside it. The reverify afterwards stored `Oct 12`,
matching the portal.

Two things this leaves behind:

- From the merchant list the flow needs **two** clicks — the row's Verify only
  opens that domain's Verify screen, it does not run the check.
- `MERCHANT_SELECTORS.verify` is still unscoped and resolves with `.first()`. It is
  safe only because both paths wait for the single-domain screen first. If a run
  reports `verified` but the portal shows the target unchanged — or a different
  domain's expiry moved — suspect that wait, and check the `listedDomains` count in
  the logs.
