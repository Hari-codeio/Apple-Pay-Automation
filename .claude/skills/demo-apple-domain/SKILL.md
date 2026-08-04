---
name: demo-apple-domain
description: DEMO AND PRESENTATION ONLY. Runs the real Apple Pay domain registration flow at human-observable speed — the domain typed character by character, clicks paced so a narrator can talk over them — inside the operator's already-signed-in Chrome. Use only when asked to demo, present, screencast, or show the flow to people. For an actual registration use register-apple-domain; to verify an already-registered domain use verify-apple-domain.
---

# Demo the domain flow at human speed

```bash
node .claude/skills/demo-apple-domain/scripts/run-demo.mjs <domain> \
    [--dry-run] [--skip-verify] [--witness <active-domain>] [--store-code <n>]
```

**The bare command does the whole thing** — register _and_ verify, all five steps, at
human speed. `pnpm apple:verify` is a single process that runs
register → store → probe → Verify → store-expiry, and the pacing reaches all of it.
No flags are needed.

Run from the repo root. Exits **0** on SUCCESS or a clean dry run, **1** if the flow
failed, **2** if preflight refused or usage was wrong.

**Always rehearse with `--dry-run` first.** It runs every check and registers
nothing.

## This is not a simulation

- It is the **real** flow. It registers the domain on the **live** Apple Developer
  account, and this codebase cannot un-register it — removal is manual in the
  portal. **Every rehearsal permanently consumes a subdomain.** Budget one
  throwaway host for the rehearsal and one for the demo, both acceptable to leave
  on the merchant identifier forever.
- It writes to a shared database this service does not own.
- Apple's verification is rate-limited per account. Run it **once**. Never loop.
- `--skip-verify` does **not** avoid registering. It only skips steps 3 and 4.

## What it actually changes

Nothing about the flow. It spawns `register-apple-domain`'s `run-workflow.mjs` and
pipes its stdout through byte for byte, so the five-step report is produced by the
real script and the real renderer. Two environment variables are injected **for that
one run**:

| Variable                     | Value | Effect                                   |
| ---------------------------- | ----- | ---------------------------------------- |
| `PLAYWRIGHT_TYPING_DELAY_MS` | `100` | the domain is typed key by key, ~100 WPM |
| `PLAYWRIGHT_SLOW_MO_MS`      | `800` | a pause after each browser action        |

`api/.env` is never edited — `process.env` beats the file all the way down
(`run-workflow.mjs` spawns with `env: process.env`, and `@nestjs/config` merges
`process.env` over the parsed file). At their defaults of `0` both knobs are inert,
which is why `register-apple-domain` is completely unaffected.

For a 21-character host that is ~2.1 s of typing plus ~4.8 s of pauses on top of
Apple's own latency.

## The one thing it cannot give you

**A browser window that visibly opens and closes.** This is an Apple constraint, not
a limitation of the script.

Apple's `myacinfo` is a **session cookie** — Chrome never writes it to disk, so it
dies with the browser (`api/src/bin/apple-chrome.ts`). There is no sign-in-once. The
authenticated browser must stay open, and the flow attaches to it over CDP, which is
why it opens a **tab** and closes only that tab. Forcing a launched browser instead
means closing the signed-in Chrome, which destroys the session — the run would land
on Apple's sign-in page.

**The pre-stage that solves it.** Before the audience joins:

```bash
pnpm apple:chrome        # this DOES visibly open a real window
```

Sign in, leave it open. The window-open moment now exists on screen; it just
happened five minutes early. Then narrate: _"the automation is taking over the
browser I signed into."_

## What the audience sees

**Will see:** a new tab open · the real merchant identifier with its existing domains
· Add Domain clicked · the domain appearing in the field **one character at a time**
· Save · Apple's confirmation screen · the association file downloaded · Verify
clicked · the row coming back `verified` with its expiry date · the tab closing ·
then the five-step report in the terminal.

**Will not see:**

- a browser **window** opening or closing — see above
- **mouse movement.** Clicks are synthesised CDP events dispatched at the element
  centre. `slowMo` buys the pause, never the cursor travel.
- **the download shelf.** Playwright intercepts the download; expect the click, then
  nothing visible. Read the saved path from the log.
- **typing anywhere else.** There is exactly one value-entry in the whole flow.
- **steps 2 and 4 of the report.** The database write and the expiry read are not
  browser events; they appear in the terminal only.
- **shorter Apple pauses.** Parsing a merchant page with dozens of domain blocks is
  portal latency. `slowMo` cannot pace or shorten it.

## Preflight — it refuses rather than failing in front of people

Every check is read-only and none of them touch Apple.

| Check                             | Refuses when                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| domain shape                      | scheme, path, port, userinfo, wildcard, or not fully qualified                                                                                                                                                                                                                                                                                                         |
| files present                     | `api/.env` or a sibling skill script is missing                                                                                                                                                                                                                                                                                                                        |
| `BROWSER_USER_DATA_DIR`           | unset — the flow would use an isolated browser seeded from a session file that does not exist here                                                                                                                                                                                                                                                                     |
| **debug Chrome answering**        | nothing on the CDP port. **The most important one:** otherwise the flow launches a _new_ Chrome with no Apple session and the demo becomes a sign-in page. Fix: `pnpm apple:chrome`                                                                                                                                                                                    |
| **Apple session live**            | attached but no `myacinfo`. A Chrome restarted since sign-in passes the check above and still dies mid-run                                                                                                                                                                                                                                                             |
| database reachable                | unreachable — and it prints the host and schema, so nobody demos against the wrong cluster                                                                                                                                                                                                                                                                             |
| no existing row                   | the domain already has one. Apple offers the association file only right after an add, so register would be refused. Use `verify-apple-domain`                                                                                                                                                                                                                         |
| **association path not shadowed** | the demo domain already answers `200` with something that is **not** `text/plain` at `/.well-known/…association.txt`. An SPA catch-all doing that passes a reachability check and then fails the probe on SHA-256 with `content-mismatch` — it is what actually broke a run here. A `404` is the healthy answer: no row yet, so no file yet. Waived by `--skip-verify` |
| demo domain resolves              | unreachable — a typo would burn a permanent Apple registration                                                                                                                                                                                                                                                                                                         |
| pacing within caps                | `slowMo > 5000` or typing `> 500`, which would fail at boot                                                                                                                                                                                                                                                                                                            |

Two checks are deliberately **warn-only**, because refusing on them would block a
demo that would have worked: an unreachable association path (the flow's own probe
retries 5× with a SHA comparison, which is far better evidence than one GET), and a
path already serving `text/plain` (possibly a stale file).

`--witness <active-domain>` is **optional** extra proof: it fetches that domain's
file and requires the SHA-256 to match its stored row, which shows DNS, TLS, the
load-bearing `.txt` suffix and the CRM's read of _this_ cluster all work. It is not
required, and on a clean database no such domain exists. Find one with
`node .claude/skills/register-domain/scripts/check-row.mjs <domain>`.

## How the file comes to exist — worth knowing

In this deployment the association file is served **from the database row**. Measured
here: the path returned `404` with no row, then `200` with a byte-identical SHA the
moment a row was written.

That is why the register → store → probe ordering is load-bearing rather than merely
careful — **the row is what makes the file exist.** It also means a single full-flow
run works: the row lands at step 2, before the probe at step 3.

Tracing is unavailable over CDP, so a failed demo leaves **no trace zip** — only the
log path the report prints.

## Do not pass `--skip-verify` for a real demo

It renders steps 3 and 4 as `⏭️ Skipped`, hiding the Verify click and the expiry
date — the most persuasive part of the flow. Use it only when nothing serves the
association file yet, then finish later with `verify-apple-domain`.

## Running it

```bash
# 1. before the audience joins — this opens a real window
pnpm apple:chrome

# 2. rehearse: every check, nothing registered
node .claude/skills/demo-apple-domain/scripts/run-demo.mjs <domain> --dry-run

# 3. bring the Chrome window into view. No check can detect a minimised
#    or off-screen browser.

# 4. once, live — register AND verify, all five steps
node .claude/skills/demo-apple-domain/scripts/run-demo.mjs <domain>
```

The domain must be **fresh** — not already on the merchant identifier, or Apple
refuses the add — and it must be served by something that reads the association file
from the database row.

## When a step fails

`register-domain` carries the typed-error table — expired Apple session, locked
Chrome profile, changed portal DOM, missing RDS CA, private-RDS timeouts. Go there.
Do not retry the demo in front of the audience: Apple rate-limits verification.
