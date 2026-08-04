---
name: verify-apple-domain
description: Verify a domain that is already registered with Apple, and store the real Verification Expires date Apple publishes for it. Probes the association file, clicks Verify, records the expiry, and reports a fixed five-step table. Use after registering with --skip-verify, after deploying the association file, when a verification came back unknown or failed, or when asked to reverify or re-check a domain's expiry. Prompts for the domain when none is given. To register a new domain, use register-apple-domain.
---

# Verify an already-registered Apple Pay domain

The other half of `register-apple-domain --skip-verify`. Registration writes the
row and downloads the file; this proves the file is live, asks Apple to verify, and
records the expiry Apple issues.

```bash
node .claude/skills/verify-apple-domain/scripts/run-verify.mjs <domain>
```

Run it from the repo root. Exits **0** on `SUCCESS`, **1** on `FAILED`, **2** on bad
usage.

It **never re-registers**. Apple offers the association file only on the
confirmation screen shown right after an add, so a second registration would be
refused — and this path does not need it, because the file is already in the row.

## This touches production. Confirm before running.

- Clicks Verify on the **live** Apple Developer account in `api/.env`. Apple's
  verification is **rate-limited**; do not retry in a loop.
- Writes `status`, `last_verified_at`, `last_probe_*` and `verification_expires_at`
  to a **shared** database this service does not own.

Get an explicit go for **this** domain. If no domain was given, ask and stop — never
guess one, and never reuse a domain from earlier in the conversation without asking.

## When to reach for this instead of registering

| Situation                                                | Use                                 |
| -------------------------------------------------------- | ----------------------------------- |
| Brand-new domain, never registered                       | `register-apple-domain <domain>`    |
| Registered with `--skip-verify`, file now deployed       | **this skill**                      |
| Probe failed, file since deployed                        | **this skill**                      |
| `verification: unknown` or `failed`, cause fixed         | **this skill**                      |
| Just want to re-read the stored expiry, no portal action | `register-domain`'s `check-row.mjs` |

## The server is handled for you

`reverify` has no CLI — it exists only as
`POST /api/domain-verifications/:domain/reverify`. Rather than making you remember
`pnpm start:dev`, the script:

1. reuses a server already listening on `PORT` from `api/.env` (default 3000), or
2. starts one, waits for `/api/healthz`, and **shuts it down again on the way out**

A server it started is killed as a whole process tree — the chain is
`sh → pnpm → pnpm --filter → nest → node`, and it is the leaf `node` that holds the
port, the MySQL pool, and the CDP attachment. Killing only the `pnpm` pid would
leave that leaf listening, and since this script reuses any listener it finds, the
orphan would be silently adopted by the next run. On Windows that is `taskkill /T`;
on macOS/Linux the child is spawned `detached` so it leads its own process group and
a negative-pid `SIGTERM` reaches the whole group, escalating to `SIGKILL` after 5s.
A server you already had running is left alone.

The `x-api-key` header is sent only when `API_KEY` is actually set in `api/.env`.
With it blank on a dev-like `ENVIRONMENT`, `ApiKeyGuard` admits the call.

## Output contract

`stdout` carries the report and nothing else. Server and browser output is teed to
`stderr`. Same renderer as `register-apple-domain` (`.claude/lib/report.mjs`), so
the two reports are directly comparable — one source of truth for the format, no
drift between skills.

Every run prints all five rows, in order, whatever happens.

```text
===========================================
Domain Verification Workflow
===========================================

Domain: example.com

[1/5] Locate Registration       ✅ Success
[2/5] Probe Association File    ✅ Success
[3/5] Verify With Apple         ✅ Success
[4/5] Add Expiry Date           ✅ Success
[5/5] Complete                  ✅ Finished

Overall Status: SUCCESS

Details:
  - probe: HTTP 200 in 1 attempt(s)
  - row status: active
  - expiry stored: 2026-10-12 00:00:00 UTC (71 days out)
  - full log: api/.artifacts/workflow-logs/verify-example.com-1785788662232.log

Workflow completed successfully.
```

Statuses are the shared set: `✅ Success`, `✅ Finished`, `❌ Failed`,
`❌ Incomplete`, `⏸️ Not Run`. There is no skip in this workflow — every step here
is the point of running it.

On the first failure it stops, marks the rest `⏸️ Not Run`, and reports
`Overall Status: FAILED`.

## What each step actually checks

1. **Locate Registration** — read-only preflight: `api/.env` present, database
   reachable, a row exists for the domain, it holds a 64-char `content_sha256`, and
   it is not soft-deleted. No row means nothing to verify; it says so rather than
   registering behind your back.
2. **Probe Association File** — the API fetches
   `https://<domain>/.well-known/apple-developer-merchantid-domain-association.txt`
   and compares SHA-256 against the stored file. The `.txt` suffix is load-bearing;
   the extensionless path 404s on this merchant's domains. `reverify` always probes,
   regardless of `DOMAIN_PROBE_ENABLED`.
3. **Verify With Apple** — two clicks from the merchant list: the row's Verify
   opens that domain's Verify screen, then Verify runs the check. `unknown` is a
   **failure**, not a pass — Apple gave no verdict and the row stays `pending`.
4. **Add Expiry Date** — judged on the **row**, not the API response, and it runs
   `check-row.mjs`'s assertions: populated, anchored to `00:00:00` UTC, in the
   future, and inside Apple's ~120-day plausible window. A wrong-but-plausible date
   is the failure mode that hides until Apple Pay silently stops working.
5. **Complete**.

## Preconditions worth knowing before it fails on you

- **The file must actually be served at the domain.** `WELL_KNOWN_SERVE_ENABLED` is
  `false`, so this API serves nothing — whatever runs at that hostname must. If
  nothing does, step 2 fails and there is no point retrying until it is deployed.
- **Debug Chrome must be up** for the CDP attach: `pnpm apple:chrome`.
- **The row must be in the database `api/.env` points at.** Switching clusters
  between registering and verifying makes the domain look unregistered — step 1
  will say exactly that.

## When a step fails

`register-domain` carries the full typed-error table — expired Apple session,
locked Chrome profile, changed portal DOM, missing RDS CA, private-RDS timeouts —
plus the trace-reading procedure for a selector break. Go there rather than
retrying this script; Apple rate-limits verification.
