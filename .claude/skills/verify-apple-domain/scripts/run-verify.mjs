#!/usr/bin/env node
/**
 * Verify a domain that is ALREADY registered, and store the expiry Apple
 * publishes for it.
 *
 *   node run-verify.mjs pay.example.com
 *
 * This is the other half of register-apple-domain --skip-verify: registration
 * writes the row and downloads the file, and this probes the file, clicks Verify,
 * and records Apple's real `Verification Expires` date. It never re-registers —
 * Apple offers the association file only on the confirmation screen right after an
 * add, so a re-registration would be refused anyway.
 *
 * WHY IT DRIVES THE HTTP API
 * `reverify` has no CLI; it exists only as POST /domain-verifications/:domain/
 * reverify. So this manages the server itself rather than making the caller
 * remember `pnpm start:dev`: it reuses a server already listening, and otherwise
 * starts one, waits for /api/healthz, and shuts it down again on the way out.
 *
 * STDOUT is the report only, so it stays parseable. Server and browser output is
 * teed to STDERR for watching a long run. Same renderer as
 * register-apple-domain, so the two reports are directly comparable.
 *
 * Exit codes: 0 SUCCESS · 1 FAILED · 2 could not run (bad usage).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STATUS, daysFromNow, renderReport } from '../../../lib/report.mjs';

const TITLE = 'Domain Verification Workflow';

const STEP_LABELS = [
  'Locate Registration',
  'Probe Association File',
  'Verify With Apple',
  'Add Expiry Date',
  'Complete',
];

/** Nest boot against a cross-region cluster is not instant. */
const SERVER_READY_TIMEOUT_MS = 150_000;
/** Reverify drives a real browser; Apple is not quick. */
const REVERIFY_TIMEOUT_MS = 15 * 60_000;

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

/** Same tolerant .env reader as check-row.mjs: quotes stripped, comments skipped. */
function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    let value = body.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    env[body.slice(0, eq).trim()] = value;
  }
  return env;
}

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('-'));
  for (const arg of argv.filter((a) => a.startsWith('-'))) {
    die(`unknown flag '${arg}'`);
  }
  if (positional.length !== 1) {
    die('usage: node run-verify.mjs <domain>');
  }
  return { domain: positional[0].trim().toLowerCase() };
}

/** Reuses the register-domain skill's reader; it owns the expiry assertions. */
function readRow(repoRoot, checkRowPath, domain) {
  const run = spawnSync(process.execPath, [checkRowPath, domain, '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const text = `${run.stdout ?? ''}`;
  try {
    const start = text.indexOf('{');
    if (start === -1) return { found: false, raw: text, code: run.status };
    return { ...JSON.parse(text.slice(start)), code: run.status };
  } catch {
    return { found: false, raw: text, code: run.status };
  }
}

/** ─── server lifecycle ───────────────────────────────────────────────────── */

async function isServerUp(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/api/healthz`, {
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startServer(repoRoot, baseUrl, tee) {
  const child = spawn('pnpm', ['start:dev'], {
    cwd: repoRoot,
    shell: true,
    env: process.env,
    // POSIX only: makes the child lead its own process group, which is what
    // makes the negative-pid group kill in stopServer actually work. Without it
    // `process.kill(-pid)` raises ESRCH and only the shell dies, orphaning the
    // node listener on PORT. Not set on Windows — there it would spawn a new
    // console, and `taskkill /T` already walks the tree.
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child, ready: false };
    if (await isServerUp(baseUrl)) return { child, ready: true };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { child, ready: false };
}

/**
 * Take down the whole tree, not just the top process.
 *
 * The chain is deeper than it looks: sh → pnpm → pnpm --filter → nest → node,
 * and it is the leaf `node` that holds PORT, the MySQL pool, and the CDP
 * attachment. Killing only the pnpm pid leaves that leaf listening, and because
 * this script reuses any listener it finds, the orphan would be silently adopted
 * by the next run instead of failing loudly.
 */
async function stopServer(child) {
  if (child === undefined || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    return;
  }

  // Negative pid = the process group, which `detached: true` at spawn made this
  // child the leader of. SIGTERM first so main.ts can drain its pool, then
  // SIGKILL as the backstop; ESRCH just means it already went.
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  };

  if (!killGroup('SIGTERM')) {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + 5000;
  while (child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (child.exitCode === null) {
    if (!killGroup('SIGKILL')) child.kill('SIGKILL');
  }
}

/** ─── the call ───────────────────────────────────────────────────────────── */

async function callReverify(baseUrl, domain, apiKey) {
  const headers = {};
  // Only sent when actually configured. On a dev-like ENVIRONMENT with API_KEY
  // blank, ApiKeyGuard admits an unauthenticated call.
  if (apiKey !== undefined && apiKey !== '') headers['x-api-key'] = apiKey;

  try {
    const response = await fetch(
      `${baseUrl}/api/domain-verifications/${encodeURIComponent(domain)}/reverify`,
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(REVERIFY_TIMEOUT_MS),
      },
    );
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, ok: response.ok, body, text };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      body: undefined,
      text: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The human-readable reason out of whatever the error shape turned out to be. */
export function errorMessage(response) {
  const body = response?.body;
  if (body !== undefined) {
    for (const key of ['message', 'detail', 'error']) {
      const value = body[key];
      if (typeof value === 'string' && value !== '') return value;
      if (Array.isArray(value) && value.length > 0) return String(value[0]);
    }
  }
  const text = (response?.text ?? '').trim();
  return text === '' ? undefined : text.slice(0, 400);
}

/** ─── deriving the five steps ────────────────────────────────────────────── */

export function deriveSteps({ preflightError, response, row }) {
  const steps = [
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
  ];
  const details = [];
  const bail = () => {
    steps[4] = STATUS.incomplete;
    return { steps, details, overall: 'FAILED' };
  };

  // 1 — Locate the registration. Nothing here can proceed without a stored file:
  // Apple fetches it from the domain, and the domain serves what this row holds.
  if (preflightError !== undefined) {
    steps[0] = STATUS.failed;
    details.push(`locate: ${preflightError}`);
    return bail();
  }
  steps[0] = STATUS.success;

  const result = response.ok ? response.body : undefined;
  const reason = errorMessage(response);

  // 2 — Probe. reverify always probes, regardless of DOMAIN_PROBE_ENABLED, so a
  // 200 always carries a probe object.
  const probe = result?.probe;
  if (probe?.ok === true) {
    steps[1] = STATUS.success;
    details.push(
      `probe: HTTP ${probe.httpStatus ?? '?'} in ${probe.attempts ?? '?'} attempt(s)`,
    );
  } else {
    steps[1] = STATUS.failed;
    if (probe !== undefined) {
      details.push(
        `probe: file not live at ${probe.url} (${probe.reason ?? 'unknown'})`,
      );
    } else if (reason !== undefined && /not live at/i.test(reason)) {
      details.push(`probe: ${reason}`);
    } else if (response.status === 0) {
      details.push(`probe: never ran — ${reason ?? 'could not reach the API'}`);
    } else {
      details.push(`probe: ${reason ?? `API returned ${response.status}`}`);
    }
    return bail();
  }

  // 3 — Apple's verdict.
  const verification = result?.verification;
  if (verification === 'verified') {
    steps[2] = STATUS.success;
  } else {
    steps[2] = STATUS.failed;
    if (verification === 'failed') {
      details.push('verify: Apple rejected the domain — see the log above');
    } else if (verification === 'unknown') {
      details.push(
        'verify: Apple gave no verdict; row stays pending — check the portal',
      );
    } else {
      details.push(
        `verify: ${reason ?? `unexpected verification '${verification}'`}`,
      );
    }
    return bail();
  }

  // 4 — The expiry, judged on the row rather than on the response.
  const storedExpiry =
    row.found === true ? (row.row.verification_expires_at ?? null) : null;
  if (row.found !== true) {
    steps[3] = STATUS.failed;
    details.push(
      'expiry: the row vanished between verifying and reading it back',
    );
    return bail();
  }
  if (storedExpiry === null) {
    steps[3] = STATUS.failed;
    details.push(
      'expiry: verified but no date stored — Apple published none, or it did not parse',
    );
    return bail();
  }
  const failedChecks = (row.checks ?? []).filter((c) => c.ok === false);
  if (failedChecks.length > 0) {
    steps[3] = STATUS.failed;
    for (const check of failedChecks) {
      details.push(`expiry assertion failed: ${check.label} — ${check.detail}`);
    }
    return bail();
  }
  steps[3] = STATUS.success;
  details.push(`row status: ${row.row.status}`);
  details.push(
    `expiry stored: ${storedExpiry} UTC (${daysFromNow(storedExpiry)} days out)`,
  );

  steps[4] = STATUS.finished;
  return { steps, details, overall: 'SUCCESS' };
}

export function render({ domain, steps, details, overall }) {
  return renderReport({
    title: TITLE,
    domain,
    labels: STEP_LABELS,
    steps,
    details,
    overall,
  });
}

/** ─── main ───────────────────────────────────────────────────────────────── */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(dirname(fileURLToPath(import.meta.url)));
  if (repoRoot === undefined) {
    die('could not locate the repo root from this script');
  }

  const checkRowPath = resolve(
    repoRoot,
    '.claude/skills/register-domain/scripts/check-row.mjs',
  );
  const envPath = join(repoRoot, 'api', '.env');

  let captured = '';
  const tee = (chunk) => {
    const text = chunk.toString();
    captured += text;
    process.stderr.write(text);
  };

  // ── preflight: read-only, and it must find a registration to act on ──
  let preflightError;
  let env = {};
  let row = { found: false };

  if (!existsSync(envPath)) {
    preflightError = 'no api/.env — copy api/.env.example and fill it in';
  } else if (!existsSync(checkRowPath)) {
    preflightError = `missing ${checkRowPath} (register-domain skill)`;
  } else {
    env = parseEnvFile(readFileSync(envPath, 'utf8'));
    const ping = spawnSync(process.execPath, [checkRowPath, '--ping'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (ping.status !== 0) {
      preflightError = `database unreachable — ${(ping.stdout || ping.stderr || '').trim() || 'see check-row.mjs --ping'}`;
    } else {
      row = readRow(repoRoot, checkRowPath, args.domain);
      if (row.code === 2) {
        preflightError = `could not read the table — ${(row.raw ?? '').trim().split('\n')[0]}`;
      } else if (row.found !== true) {
        preflightError =
          `no row for '${args.domain}' in the database api/.env points at. ` +
          'Register it first (register-apple-domain), or switch clusters if the row is elsewhere.';
      } else if (
        typeof row.row.content_sha256 !== 'string' ||
        row.row.content_sha256.length !== 64
      ) {
        preflightError =
          'the row has no stored association file SHA — nothing to verify against';
      } else if (row.row.is_deleted === 1 || row.row.is_deleted === true) {
        preflightError =
          'the row is soft-deleted; un-delete it before verifying';
      }
    }
  }

  const port = env.PORT === undefined || env.PORT === '' ? '3000' : env.PORT;
  const baseUrl = `http://localhost:${port}`;
  let response = {
    status: 0,
    ok: false,
    body: undefined,
    text: 'not attempted',
  };
  let ownedServer;

  if (preflightError === undefined) {
    const alreadyUp = await isServerUp(baseUrl);
    if (!alreadyUp) {
      process.stderr.write(
        `\n  no server on ${baseUrl} — starting one (pnpm start:dev)\n\n`,
      );
      const started = await startServer(repoRoot, baseUrl, tee);
      ownedServer = started.child;
      if (!started.ready) {
        preflightError = `server did not become ready on ${baseUrl} within ${SERVER_READY_TIMEOUT_MS / 1000}s`;
      }
    } else {
      process.stderr.write(`\n  reusing the server already on ${baseUrl}\n\n`);
    }
  }

  try {
    if (preflightError === undefined) {
      response = await callReverify(baseUrl, args.domain, env.API_KEY);
      // Re-read: step 4 is judged on the row, never on the response.
      row = readRow(repoRoot, checkRowPath, args.domain);
    }
  } finally {
    if (ownedServer !== undefined) {
      process.stderr.write('\n  stopping the server this run started\n\n');
      await stopServer(ownedServer);
    }
  }

  const derived = deriveSteps({ preflightError, response, row });

  if (captured !== '' || response.text !== 'not attempted') {
    try {
      const logDir = join(repoRoot, 'api', '.artifacts', 'workflow-logs');
      mkdirSync(logDir, { recursive: true });
      const safe = args.domain.replace(/[^A-Za-z0-9.-]+/g, '_');
      const logPath = join(logDir, `verify-${safe}-${Date.now()}.log`);
      writeFileSync(
        logPath,
        `${captured}\n\n--- HTTP ${response.status} ---\n${response.text}\n`,
        'utf8',
      );
      derived.details.push(`full log: ${logPath}`);
    } catch {
      // Not worth failing the report over.
    }
  }

  process.stdout.write(render({ domain: args.domain, ...derived }));
  process.exit(derived.overall === 'SUCCESS' ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  main().catch((error) => {
    die(
      `unexpected failure: ${error instanceof Error ? error.stack : String(error)}`,
    );
  });
}
