#!/usr/bin/env node
/**
 * The domain registration flow at human-observable speed, for showing to people.
 *
 *   node run-demo.mjs pay.example.com --witness <already-active-domain>
 *   node run-demo.mjs pay.example.com --dry-run --witness <domain>
 *   node run-demo.mjs pay.example.com --skip-verify
 *
 * Exit codes: 0 SUCCESS or dry-run OK · 1 the flow FAILED · 2 refused / bad usage.
 *
 * WHAT IT IS
 * A thin wrapper. It preflights everything that could embarrass you mid-demo, then
 * spawns register-apple-domain's run-workflow.mjs with two env vars injected and
 * pipes its stdout through byte for byte. The five-step report you see is produced
 * by the real script and the real renderer — nothing here re-implements it, so the
 * demo cannot drift from what operations actually runs.
 *
 * WHAT IT DOES NOT DO
 * It does not edit api/.env. process.env beats the file all the way down the chain
 * (run-workflow.mjs spawns pnpm with `env: process.env`, and @nestjs/config merges
 * process.env over the parsed file), so the pacing applies to this run only.
 *
 * ONE THING IT CANNOT GIVE YOU
 * A browser WINDOW visibly opening and closing. Apple's `myacinfo` is a session
 * cookie that dies with the browser, so the authenticated browser must stay open
 * and the flow attaches to it — you get a TAB opening and closing inside it. See
 * SKILL.md for the pre-stage that puts a window-open moment on screen anyway.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvFile, cdpTargetFrom } from '../../../lib/env-file.mjs';

/** Pacing. Chosen in the plan: ~100 WPM typing, and a beat you can narrate over. */
const SLOW_MO_MS = 800;
const TYPING_DELAY_MS = 100;

/** Schema caps in api/src/config/validation-schema.ts. Exceeding them fails at boot. */
const SLOW_MO_CAP = 5_000;
const TYPING_CAP = 500;

const ASSOCIATION_PATH =
  '/.well-known/apple-developer-merchantid-domain-association.txt';

/** Roughly how many slowMo-flagged actions the flow performs. */
const SLOWMO_BEATS = 6;

function die(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(2);
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (let hops = 0; hops < 12; hops += 1) {
    if (existsSync(join(dir, 'api', 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** ─── args ───────────────────────────────────────────────────────────────── */

export function parseArgs(argv) {
  const positional = [];
  let dryRun = false;
  let skipVerify = false;
  let witness;
  let storeCode = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--skip-verify') skipVerify = true;
    else if (arg === '--witness') {
      witness = (argv[i + 1] ?? '').trim().toLowerCase();
      i += 1;
      if (witness === '' || witness.startsWith('-')) {
        return { error: '--witness expects a domain that is already active' };
      }
    } else if (arg === '--store-code') {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return {
          error: `--store-code expects a positive integer (got '${raw}')`,
        };
      }
      storeCode = parsed;
    } else if (arg.startsWith('-')) {
      return { error: `unknown flag '${arg}'` };
    } else positional.push(arg);
  }

  if (positional.length !== 1) {
    return {
      error:
        'usage: node run-demo.mjs <domain> [--witness <active-domain>] [--dry-run] [--skip-verify] [--store-code <n>]',
    };
  }
  return {
    domain: positional[0].trim().toLowerCase(),
    dryRun,
    skipVerify,
    witness,
    storeCode,
  };
}

/**
 * Shape check only — normalizeDomain in the service owns the real rules. This
 * exists so an obviously wrong argument is refused here rather than surfacing as a
 * BadRequestException once the audience is already watching.
 */
export function domainShapeError(domain) {
  if (domain === '') return 'domain must not be empty';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(domain))
    return 'domain must not include a scheme';
  if (domain.includes('/')) return 'domain must not include a path';
  if (domain.includes('@')) return 'domain must not include userinfo';
  if (domain.includes(':')) return 'domain must not include a port';
  if (domain.startsWith('*')) return 'domain must not be a wildcard';
  if (!domain.includes('.')) return 'domain must be a fully qualified hostname';
  return undefined;
}

/** ─── helpers ────────────────────────────────────────────────────────────── */

function runNode(repoRoot, scriptPath, args) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function readRowJson(repoRoot, checkRowPath, domain) {
  const run = runNode(repoRoot, checkRowPath, [domain, '--json']);
  const text = `${run.stdout ?? ''}`;
  try {
    const start = text.indexOf('{');
    if (start === -1) return { found: false, code: run.status, raw: text };
    return { ...JSON.parse(text.slice(start)), code: run.status };
  } catch {
    return { found: false, code: run.status, raw: text };
  }
}

async function httpStatus(url, { timeoutMs = 15_000, attempts = 2 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      return {
        ok: true,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        body: await response.text(),
      };
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  return { ok: false, status: 0, reason: last };
}

const step = (name) => process.stderr.write(`  ${name.padEnd(46)}`);
const good = (detail) =>
  process.stderr.write(`ok${detail ? ` — ${detail}` : ''}\n`);
const bad = (detail) => process.stderr.write(`REFUSED — ${detail}\n`);
const warn = (detail) => process.stderr.write(`WARN — ${detail}\n`);

/** ─── main ───────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error !== undefined) die(args.error);

  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  if (repoRoot === undefined) die('could not locate the repo root');

  const workflowPath = resolve(
    repoRoot,
    '.claude/skills/register-apple-domain/scripts/run-workflow.mjs',
  );
  const checkRowPath = resolve(
    repoRoot,
    '.claude/skills/register-domain/scripts/check-row.mjs',
  );
  const sessionPath = join(here, 'check-session.mjs');

  process.stderr.write('\n  demo preflight\n\n');

  // P1 — argument shape and the scripts we depend on
  step('domain shape');
  const shapeError = domainShapeError(args.domain);
  if (shapeError !== undefined) {
    bad(shapeError);
    process.exit(2);
  }
  good(args.domain);

  step('api/.env and sibling skills present');
  const envPath = join(repoRoot, 'api', '.env');
  for (const [label, path] of [
    ['api/.env', envPath],
    ['run-workflow.mjs', workflowPath],
    ['check-row.mjs', checkRowPath],
    ['check-session.mjs', sessionPath],
  ]) {
    if (!existsSync(path)) {
      bad(`missing ${label} at ${path}`);
      process.exit(2);
    }
  }
  good();

  const env = readEnvFile(envPath);

  // P2 — the browser mode that keeps the Apple session
  step('BROWSER_USER_DATA_DIR set');
  if ((env.BROWSER_USER_DATA_DIR ?? '').trim() === '') {
    bad(
      'unset, so the flow would use an isolated browser seeded from ' +
        'APPLE_SESSION_STATE_PATH — which does not exist on this machine',
    );
    process.exit(2);
  }
  good(env.BROWSER_USER_DATA_DIR);

  // P3 — a debug Chrome must ALREADY be answering. If it is not, the factory
  // spawns a fresh unauthenticated one and the audience watches a sign-in page.
  const target = cdpTargetFrom(env);
  step('debug Chrome answering');
  const version = await httpStatus(`${target}/json/version`);
  if (!version.ok || version.status !== 200) {
    bad(
      `nothing on ${target}. Start it and sign in:  pnpm apple:chrome\n` +
        '        (without it the flow launches a NEW Chrome with no Apple session)',
    );
    process.exit(2);
  }
  good(target);

  // P4 — attached is not the same as signed in: myacinfo dies with the browser.
  //
  // Retried once: a CDP attach can fail transiently while Chrome is busy, and
  // that produced a spurious "not signed in" refusal in testing. Two failures in
  // a row is a real answer; one is noise.
  step('Apple session live (myacinfo)');
  let session = runNode(repoRoot, sessionPath, ['--json']);
  if (session.status !== 0) {
    await new Promise((r) => setTimeout(r, 1_500));
    session = runNode(repoRoot, sessionPath, ['--json']);
  }
  if (session.status !== 0) {
    const detail = (session.stderr ?? '').trim().split('\n')[0];
    bad(
      'the attached Chrome is not signed in to the Apple Developer portal.\n' +
        '        Sign in inside that window, then re-run.' +
        (detail === '' ? '' : `\n        Detail: ${detail}`),
    );
    process.exit(2);
  }
  good('signed in');

  // P5 — say out loud which database this is going to write to
  step('database reachable');
  const ping = runNode(repoRoot, checkRowPath, ['--ping']);
  if (ping.status !== 0) {
    bad((ping.stdout || ping.stderr || 'see check-row.mjs --ping').trim());
    process.exit(2);
  }
  good((ping.stdout ?? '').trim().replace(/^db reachable:\s*/, ''));

  // P6 — a domain Apple already lists cannot be re-registered
  step('no existing row for the domain');
  const existing = readRowJson(repoRoot, checkRowPath, args.domain);
  if (existing.code === 2) {
    bad(
      `could not read the table — ${(existing.raw ?? '').trim().split('\n')[0]}`,
    );
    process.exit(2);
  }
  if (existing.found === true) {
    bad(
      `already has a row (status ${existing.row?.status}). Apple offers the ` +
        'association file only right after an add, so register would be refused.\n' +
        '        Use verify-apple-domain instead, or pick a fresh hostname.',
    );
    process.exit(2);
  }
  good('fresh');

  // P7 — is anything already SHADOWING the association path on the demo domain?
  //
  // This is checked on the demo domain itself, not on a witness. In this
  // deployment the file is served FROM the database row, so before the run the
  // path SHOULD 404 — that is the healthy state, and it means nothing else owns
  // the path. What kills a run is a 200 carrying something that is not the file:
  // an SPA catch-all answering every path with index.html passes a reachability
  // check and then fails the probe on SHA-256 with `content-mismatch`.
  if (!args.skipVerify) {
    step('association path not shadowed');
    const own = await httpStatus(`https://${args.domain}${ASSOCIATION_PATH}`);
    if (own.ok && own.status === 200) {
      const type = own.contentType ?? '';
      if (!type.includes('text/plain')) {
        bad(
          `it already answers 200 with '${type || 'an unknown type'}' — something\n` +
            '        (an SPA catch-all?) owns that path. The probe compares SHA-256, so\n' +
            '        it will fail with content-mismatch. Serve the stored file there,\n' +
            '        ahead of the fallback, or run with --skip-verify.',
        );
        process.exit(2);
      }
      good(
        `already serving text/plain (${own.body.length} bytes) — stale file?`,
      );
    } else if (own.ok) {
      // 404 is the expected, healthy answer: no row yet, so no file yet.
      good(`clear (HTTP ${own.status}) — the row will make the file appear`);
    } else {
      // Warn, do not refuse. A slow or flaky fetch here is weak evidence: the
      // flow's own probe retries 5 times over ~10s with a SHA comparison, which
      // is a far better test than one pre-flight GET. Refusing on a timeout would
      // block a demo on a domain that works.
      warn(
        `could not reach it (${own.reason}) — the probe retries 5x, continuing`,
      );
    }
  }

  // Optional extra proof: a domain that is ALREADY active and serving shows that
  // DNS, TLS, the load-bearing .txt suffix and the CRM's read of THIS cluster all
  // work. Not required — on a clean table no such domain exists.
  if (args.witness !== undefined) {
    step('witness serves its stored file');
    const witnessRow = readRowJson(repoRoot, checkRowPath, args.witness);
    if (witnessRow.found !== true) {
      bad(`witness '${args.witness}' has no row on this cluster`);
      process.exit(2);
    }
    const served = await httpStatus(
      `https://${args.witness}${ASSOCIATION_PATH}`,
    );
    if (!served.ok || served.status !== 200) {
      bad(
        `witness serves HTTP ${served.status || 'nothing'} at ${ASSOCIATION_PATH}` +
          `${served.reason ? ` (${served.reason})` : ''}`,
      );
      process.exit(2);
    }
    const servedSha = createHash('sha256').update(served.body).digest('hex');
    if (servedSha !== witnessRow.row?.content_sha256) {
      bad(
        'witness serves 200 but the SHA-256 does not match its stored file.\n' +
          `        served ${servedSha.slice(0, 12)}… vs stored ` +
          `${String(witnessRow.row?.content_sha256).slice(0, 12)}…`,
      );
      process.exit(2);
    }
    good(`${args.witness} SHA matches`);
  }

  // P8 — a typo would burn a permanent Apple registration
  step('demo domain resolves');
  const root = await httpStatus(`https://${args.domain}/`);
  if (!root.ok) {
    bad(
      `${args.domain} is unreachable (${root.reason}). Registering it at Apple ` +
        'cannot be undone from this repo.',
    );
    process.exit(2);
  }
  good(`HTTP ${root.status}`);

  // P9 — pacing inside the schema caps, and what it will cost in wall clock
  step('pacing within schema caps');
  if (SLOW_MO_MS > SLOW_MO_CAP || TYPING_DELAY_MS > TYPING_CAP) {
    bad(
      `slowMo ${SLOW_MO_MS} (cap ${SLOW_MO_CAP}), typing ${TYPING_DELAY_MS} (cap ${TYPING_CAP})`,
    );
    process.exit(2);
  }
  const typingSeconds = ((args.domain.length * TYPING_DELAY_MS) / 1000).toFixed(
    1,
  );
  const beatSeconds = ((SLOWMO_BEATS * SLOW_MO_MS) / 1000).toFixed(1);
  good(
    `${TYPING_DELAY_MS}ms/char, ${SLOW_MO_MS}ms/action ` +
      `(~${typingSeconds}s typing + ~${beatSeconds}s pauses)`,
  );

  const injected = {
    PLAYWRIGHT_SLOW_MO_MS: String(SLOW_MO_MS),
    PLAYWRIGHT_TYPING_DELAY_MS: String(TYPING_DELAY_MS),
    // Inert on the attach path, which has no launch options. Insurance only, in
    // case a future change routes this through a launch tier.
    PLAYWRIGHT_HEADLESS: 'false',
  };

  process.stderr.write('\n  plan\n\n');
  process.stderr.write(`    domain      ${args.domain}\n`);
  process.stderr.write(`    mode        attach over CDP (${target})\n`);
  process.stderr.write(
    `    verify      ${args.skipVerify ? 'SKIPPED (steps 3+4)' : 'yes'}\n`,
  );
  if (args.storeCode !== null) {
    process.stderr.write(`    store code  ${args.storeCode}\n`);
  }
  for (const [k, v] of Object.entries(injected)) {
    process.stderr.write(`    ${k.padEnd(28)} ${v}\n`);
  }
  process.stderr.write(
    '\n    Tracing is unavailable over CDP, so a failed run leaves no trace zip —\n' +
      '    only the log path in the report.\n',
  );

  // P10 — the rehearsal path stops here
  if (args.dryRun) {
    process.stderr.write(
      '\n  dry run: nothing was registered.\n' +
        '  Bring the Chrome window into view before the live run — no check can\n' +
        '  detect a minimised or off-screen browser.\n\n',
    );
    process.exit(0);
  }

  // ── hand off to the REAL script; its stdout is the report, untouched ──
  const childArgs = [workflowPath, args.domain];
  if (args.skipVerify) childArgs.push('--skip-verify');
  if (args.storeCode !== null)
    childArgs.push('--store-code', String(args.storeCode));

  process.stderr.write('\n  running the real workflow…\n\n');

  const child = spawn(process.execPath, childArgs, {
    cwd: repoRoot,
    env: { ...process.env, ...injected },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => process.stdout.write(c));
  child.stderr.on('data', (c) => process.stderr.write(c));

  child.on('error', (error) =>
    die(`could not start the workflow: ${error.message}`),
  );
  child.on('close', (code) => process.exit(code ?? 1));
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) =>
    die(
      `unexpected failure: ${error instanceof Error ? error.stack : String(error)}`,
    ),
  );
}
