---
name: register-apple-domain
description: Run the Apple Pay merchant domain registration flow end to end for one domain, then verify what landed in the database — especially that verification_expires_at holds Apple's real date. Use when asked to register or verify a domain, test the Apple Pay domain flow, check a verification expiry, or confirm a domain reached 'active'. Prompts for the domain when none is given.
---

# Register an Apple Pay merchant domain

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
node .claude/skills/register-apple-domain/scripts/check-row.mjs --ping
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
node .claude/skills/register-apple-domain/scripts/check-row.mjs <domain>
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
without re-registering. There is no CLI for this; call the API, which needs the
server running (`pnpm start:dev`) and `API_KEY` from `api/.env`:

```bash
curl -s -X POST "http://localhost:3000/api/domain-verifications/<domain>/reverify" \
  -H "x-api-key: $API_KEY"
```

## Step 4 — Verify what actually landed

The CLI reports what the service _returned_. This reads the row that was _written_,
and asserts the expiry:

```bash
node .claude/skills/register-apple-domain/scripts/check-row.mjs <domain>
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

## Known issue to watch during a test run

`verifyDomain` may click the **wrong domain's** Verify button. The click resolves via
a `<section>` containing the domain, but the list renders `div.cert-block.domain-block`
— with no match it falls through to `.first()` on the verify buttons, i.e. the first
domain on the page. On a merchant with many domains this both acts on an unrelated
domain and makes the expiry read afterwards untrustworthy.

If a run reports `verified` but the portal shows the target domain unchanged — or a
different domain's expiry moved — this is why. Report it rather than retrying.
