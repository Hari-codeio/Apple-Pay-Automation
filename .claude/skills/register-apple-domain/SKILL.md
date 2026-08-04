---
name: register-apple-domain
description: Run the whole Apple Pay domain registration workflow as one command and report it in a fixed five-step table — register, insert the row, verify, store Apple's expiry date, complete. Use when asked to register a domain, run the full domain flow, or register with --skip-verify. Prompts for the domain when none is given. To verify a domain that was registered with --skip-verify, use verify-apple-domain instead. For troubleshooting a failed step, see the register-domain reference skill.
---

# Domain registration workflow

One command, five steps, the same report every time.

```bash
node .claude/skills/register-apple-domain/scripts/run-workflow.mjs <domain> [--skip-verify] [--store-code <n>]
```

Run it from the repo root. It exits **0** on `SUCCESS`, **1** on `FAILED`, **2** on
bad usage.

## This touches production. Confirm before running.

- Registers the domain on the **live** Apple Developer account in `api/.env`
  (`APPLE_MERCHANT_ID`). This codebase cannot un-register it; removal is manual in
  the portal.
- Writes to a **shared** database this service does not own.
- Apple's verification is **rate-limited**. Do not retry in a loop.

Get an explicit go from the user for **this** domain before running. Approval for
one domain is not approval for the next. If no domain was given, ask and stop —
never guess one, and never reuse a domain from earlier in the conversation
without asking.

## What the script does

The steps are not five separate commands. `pnpm apple:verify` is one process that
does register → insert → probe → verify → store-expiry internally, so the script
runs it once and derives each step's status from evidence:

- the `RegistrationResult` JSON the CLI prints
- its structured log lines
- **the row that actually landed**, read back through the `register-domain`
  skill's `check-row.mjs` — reused rather than reimplemented, because it already
  owns the expiry assertions (start-of-day UTC anchor, in the future, inside
  Apple's ~120-day plausible window)

Step 2 and step 4 are judged on the database, never on what the CLI claimed. The
whole point of the expiry work was that a wrong date looks fine until Apple Pay
silently stops working.

Before touching Apple it preflights, read-only: `api/.env` present, database
reachable, and **no existing row** for the domain. A domain Apple already lists
cannot be re-registered — Apple offers the association file only on the
confirmation screen right after an add — so that case fails fast with a pointer to
reverify instead of burning a portal round trip.

## Output contract

`stdout` carries the report and nothing else, so it stays parseable. The child
process's live output is teed to `stderr` — watch there during a long browser run.

Every run prints all five rows. No row is ever omitted, reordered, or renamed, and
the layout does not change between success and failure.

```text
===========================================
Domain Registration Workflow
===========================================

Domain: example.com

[1/5] Register Domain        ✅ Success
[2/5] Upload to Database     ✅ Success
[3/5] Verify Registration    ✅ Success
[4/5] Add Expiry Date        ✅ Success
[5/5] Complete               ✅ Finished

Overall Status: SUCCESS

Details:
  - row status: active
  - expiry stored: 2026-10-12 00:00:00 UTC (71 days out)
  - full log: api/.artifacts/workflow-logs/example.com-1785788662232.log

Workflow failed.        ← or: Workflow completed successfully.
```

Statuses, and nothing else:

| Status                       | Meaning                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `✅ Success`                 | the step did its job                                        |
| `✅ Finished`                | step 5 only, when every prior step succeeded or was skipped |
| `❌ Failed`                  | the step ran and did not succeed                            |
| `❌ Incomplete`              | step 5 only, when something failed                          |
| `⏭️ Skipped (--skip-verify)` | deliberately not run                                        |
| `⏸️ Not Run`                 | never reached, because an earlier step failed               |

`Details:` is always present — `(none)` when empty — so the shape never varies.
The last line is always `Workflow completed successfully.` or `Workflow failed.`

## `--skip-verify` skips steps 3 AND 4

This is the one place the report departs from a naive reading of "skip only the
verification step", and it is not a shortcut:

```text
[3/5] Verify Registration    ⏭️ Skipped (--skip-verify)
[4/5] Add Expiry Date        ⏭️ Skipped (--skip-verify)
[5/5] Complete               ✅ Finished
```

**Apple issues the expiry date only when it verifies the domain, and publishes it
only in the Merchant Domains list.** With no verification there is no date in
existence to store. Marking step 4 `✅ Success` would mean writing a value Apple
never gave — which is exactly the bug this flow was built to eliminate (the column
used to hold `now + 365 days`, against a real Apple window of ~90). So it is
`⏭️ Skipped`, and `Overall Status` is still `SUCCESS`, because skipping was asked
for.

To finish such a domain later: deploy the association file, then run
**`verify-apple-domain <domain>`**. That is the skill that probes, clicks Verify,
and stores the real expiry — steps 3 and 4 of this table, on a domain already
registered.

## Failure behaviour

On the first failure the script stops, marks every later step `⏸️ Not Run`, and
sets `Overall Status: FAILED`. It never continues past a failed step — step 3
cannot mean anything if step 2 did not write the row.

`Details:` names the cause, and the full child output is saved to
`api/.artifacts/workflow-logs/<domain>-<timestamp>.log`.

A `verification` of `unknown` is a **failure**, not a success: Apple gave no
verdict, the row stays `pending`, and a human has to look at the portal.

## Preconditions worth knowing before it fails on you

- **The association file must be reachable at the domain when the probe runs.**
  The flow refuses to click Verify until it has fetched the file from
  `https://<domain>/.well-known/apple-developer-merchantid-domain-association.txt`
  and matched its SHA-256. The `.txt` suffix is load-bearing — the extensionless
  path 404s on this merchant's domains.
- `WELL_KNOWN_SERVE_ENABLED=false` means **this API serves nothing**; whatever
  runs at the domain must serve it. If nothing does, use `--skip-verify`, deploy,
  then reverify.
- **Debug Chrome must be up** for the CDP attach: `pnpm apple:chrome`.
- The row lives in whichever database `api/.env` points at. Switching clusters
  mid-flow makes a domain look unregistered.

## When a step fails

`register-domain` carries the full typed-error table — expired Apple
session, locked Chrome profile, changed portal DOM, missing RDS CA, private-RDS
timeouts — and the trace-reading procedure for a selector break. Go there rather
than retrying this script.
