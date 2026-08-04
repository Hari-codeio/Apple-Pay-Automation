#!/usr/bin/env node
/**
 * The whole domain-registration workflow as one command, with a fixed report.
 *
 *   node run-workflow.mjs pay.example.com
 *   node run-workflow.mjs pay.example.com --skip-verify
 *   node run-workflow.mjs pay.example.com --store-code 1042
 *
 * WHY THIS IS A SCRIPT AND NOT SKILL PROSE
 * The report has to be byte-identical across runs so it can be compared and
 * parsed. Instructions telling a model to "print this table" drift — wording,
 * spacing, an omitted row on an unusual failure. Deriving the rows in code from
 * observed facts cannot drift, and every run emits all five rows even when the
 * flow died on the first one.
 *
 * WHAT IT ACTUALLY RUNS
 * `pnpm apple:verify` is a single process that does register → insert → probe →
 * verify → store-expiry internally, so per-step status is not something it
 * reports. This derives each step from evidence instead:
 *   - the RegistrationResult JSON it prints on stdout
 *   - its structured log lines
 *   - the row that landed, read back via the register-domain skill's
 *     check-row.mjs (reused, not reimplemented — it already owns the expiry
 *     assertions, including the ~120-day sanity bound)
 *
 * STDOUT is the report only, so it stays parseable. The child process's live
 * output is teed to STDERR so a long browser run can still be watched.
 *
 * Exit codes: 0 SUCCESS · 1 FAILED · 2 could not run (bad usage).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  STATUS as BASE_STATUS,
  daysFromNow,
  renderReport,
} from '../../../lib/report.mjs';

/** Shared statuses, plus the one skip reason this workflow can produce. */
const STATUS = {
  ...BASE_STATUS,
  skipped: BASE_STATUS.skipped('--skip-verify'),
};

const TITLE = 'Domain Registration Workflow';

const STEP_LABELS = [
  'Register Domain',
  'Upload to Database',
  'Verify Registration',
  'Add Expiry Date',
  'Complete',
];

function die(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(2);
}

/** ─── workspace ──────────────────────────────────────────────────────────── */

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

function parseArgs(argv) {
  const positional = [];
  let skipVerify = false;
  let storeCode = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-verify') {
      skipVerify = true;
    } else if (arg === '--store-code') {
      const raw = argv[i + 1];
      i += 1;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        die(`--store-code expects a positive integer (got '${raw}')`);
      }
      storeCode = parsed;
    } else if (arg.startsWith('-')) {
      die(`unknown flag '${arg}'`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length !== 1) {
    die(
      'usage: node run-workflow.mjs <domain> [--skip-verify] [--store-code <n>]',
    );
  }
  return { domain: positional[0].trim().toLowerCase(), skipVerify, storeCode };
}

/** ─── reading the RegistrationResult off stdout ───────────────────────────
 * The CLI pretty-prints it at column 0. Scan for the last such object and
 * brace-match rather than regex the whole blob: log lines contain braces too.
 */
export function extractResultJson(text) {
  const marker = '{\n  "domain":';
  let from = text.lastIndexOf(marker);
  if (from === -1) {
    const crlf = '{\r\n  "domain":';
    from = text.lastIndexOf(crlf);
    if (from === -1) return undefined;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(from, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** First line of the CLI's own failure summary, for the Details block. */
function extractCliError(text) {
  const match = /apple:verify failed:\s*(.+)/.exec(text);
  if (match !== null) return match[1].trim();
  const nest = /(?:Error|Exception):\s*(.+)/.exec(text);
  return nest === null ? undefined : nest[1].trim();
}

/** ─── child processes ────────────────────────────────────────────────────── */

/** Reuses the register-domain skill's reader; it owns the assertions. */
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

function runRegistration(repoRoot, { domain, skipVerify, storeCode }) {
  const args = ['apple:verify', domain];
  if (skipVerify) args.push('--skip-verify');
  if (storeCode !== null) args.push('--store-code', String(storeCode));

  return new Promise((resolveRun) => {
    // shell:true so `pnpm` resolves to pnpm.cmd on Windows.
    const child = spawn('pnpm', args, {
      cwd: repoRoot,
      shell: true,
      env: process.env,
    });

    let captured = '';
    const tee = (chunk) => {
      const text = chunk.toString();
      captured += text;
      // stderr, so stdout carries the report alone and stays parseable.
      process.stderr.write(text);
    };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);

    child.on('error', (error) => {
      captured += `\nspawn failed: ${error.message}\n`;
      resolveRun({ code: -1, captured });
    });
    child.on('close', (code) => resolveRun({ code, captured }));
  });
}

/** ─── deriving the five steps ────────────────────────────────────────────── */

export function deriveSteps({ skipVerify, preflightError, cli, result, row }) {
  const steps = [
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
    STATUS.notRun,
  ];
  const details = [];

  if (preflightError !== undefined) {
    steps[0] = STATUS.failed;
    steps[4] = STATUS.incomplete;
    details.push(`preflight: ${preflightError}`);
    return { steps, details, overall: 'FAILED' };
  }

  // 1 — Register. The association file only exists on Apple's post-Save screen,
  // so having its SHA is proof the portal leg completed.
  const downloaded =
    (result !== undefined && typeof result.contentSha256 === 'string') ||
    cli.captured.includes('Association file downloaded');
  steps[0] = downloaded ? STATUS.success : STATUS.failed;
  if (!downloaded) {
    const reason = extractCliError(cli.captured);
    details.push(
      `register: ${reason ?? `pnpm apple:verify exited ${cli.code}`}`,
    );
    steps[4] = STATUS.incomplete;
    return { steps, details, overall: 'FAILED' };
  }

  // 2 — Upload to database. Judged on the row, not on the CLI's word for it.
  const rowFound = row.found === true;
  steps[1] = rowFound ? STATUS.success : STATUS.failed;
  if (!rowFound) {
    details.push(
      'upload: no row for this domain — registered at Apple with nothing backing it',
    );
    steps[4] = STATUS.incomplete;
    return { steps, details, overall: 'FAILED' };
  }
  details.push(`row status: ${row.row.status}`);

  // 3 — Verify.
  const verification = result?.verification;
  if (skipVerify) {
    steps[2] = STATUS.skipped;
  } else if (verification === 'verified') {
    steps[2] = STATUS.success;
  } else {
    steps[2] = STATUS.failed;
    if (verification === 'failed') {
      details.push('verify: Apple rejected the domain — see the log above');
    } else if (verification === 'unknown') {
      details.push(
        'verify: Apple gave no verdict; row stays pending — check the portal',
      );
    } else if (result?.probe !== undefined && result.probe.ok === false) {
      details.push(
        `verify: probe failed — file not live at ${result.probe.url}`,
      );
    } else {
      const reason = extractCliError(cli.captured);
      details.push(`verify: ${reason ?? 'did not complete'}`);
    }
    steps[3] = STATUS.notRun;
    steps[4] = STATUS.incomplete;
    return { steps, details, overall: 'FAILED' };
  }

  // 4 — Expiry. Apple issues it ONLY on verification, so --skip-verify leaves
  // nothing to store: skipped, never a fabricated success.
  const storedExpiry = row.row.verification_expires_at ?? null;
  if (skipVerify) {
    steps[3] = STATUS.skipped;
    details.push(
      'expiry: none to store — Apple publishes it only when it verifies',
    );
  } else if (storedExpiry === null) {
    steps[3] = STATUS.failed;
    details.push(
      'expiry: verified but no date stored — Apple published none, or it did not parse',
    );
    steps[4] = STATUS.incomplete;
    return { steps, details, overall: 'FAILED' };
  } else {
    const failedChecks = (row.checks ?? []).filter((c) => c.ok === false);
    if (failedChecks.length > 0) {
      steps[3] = STATUS.failed;
      for (const check of failedChecks) {
        details.push(
          `expiry assertion failed: ${check.label} — ${check.detail}`,
        );
      }
      steps[4] = STATUS.incomplete;
      return { steps, details, overall: 'FAILED' };
    }
    steps[3] = STATUS.success;
    details.push(
      `expiry stored: ${storedExpiry} UTC (${daysFromNow(storedExpiry)} days out)`,
    );
  }

  steps[4] = STATUS.finished;
  return { steps, details, overall: 'SUCCESS' };
}

/** ─── the report ─────────────────────────────────────────────────────────── */

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
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = findRepoRoot(here);
  if (repoRoot === undefined)
    die('could not locate the repo root from this script');

  const checkRowPath = resolve(
    repoRoot,
    '.claude/skills/register-domain/scripts/check-row.mjs',
  );

  // ── preflight: everything cheap and read-only, before Apple is touched ──
  let preflightError;
  if (!existsSync(join(repoRoot, 'api', '.env'))) {
    preflightError = 'no api/.env — copy api/.env.example and fill it in';
  } else if (!existsSync(checkRowPath)) {
    preflightError = `missing ${checkRowPath} (register-domain skill)`;
  } else {
    const ping = spawnSync(process.execPath, [checkRowPath, '--ping'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (ping.status !== 0) {
      preflightError = `database unreachable — ${(ping.stdout || ping.stderr || '').trim() || 'see check-row.mjs --ping'}`;
    } else {
      const existing = readRow(repoRoot, checkRowPath, args.domain);
      if (existing.found === true && !args.skipVerify) {
        preflightError =
          `'${args.domain}' already has a row (status ${existing.row.status}). ` +
          'Apple offers the association file only right after an add, so register ' +
          'would be refused — use the reverify path instead.';
      } else if (existing.code === 2) {
        preflightError = `could not read the table — ${(existing.raw ?? '').trim().split('\n')[0] || 'see check-row.mjs'}`;
      }
    }
  }

  let cli = { code: 0, captured: '' };
  let result;
  let row = { found: false };

  if (preflightError === undefined) {
    cli = await runRegistration(repoRoot, args);
    result = extractResultJson(cli.captured);
    row = readRow(repoRoot, checkRowPath, args.domain);
  }

  const derived = deriveSteps({
    skipVerify: args.skipVerify,
    preflightError,
    cli,
    result,
    row,
  });

  // Keep the raw child output: the report is a summary, and a failure needs the
  // trace. stdout stays the report alone.
  if (cli.captured !== '') {
    try {
      const logDir = join(repoRoot, 'api', '.artifacts', 'workflow-logs');
      mkdirSync(logDir, { recursive: true });
      const safe = args.domain.replace(/[^A-Za-z0-9.-]+/g, '_');
      const logPath = join(logDir, `${safe}-${Date.now()}.log`);
      writeFileSync(logPath, cli.captured, 'utf8');
      derived.details.push(`full log: ${logPath}`);
    } catch {
      // Not worth failing the report over.
    }
  }

  process.stdout.write(render({ domain: args.domain, ...derived }));
  process.exit(derived.overall === 'SUCCESS' ? 0 : 1);
}

// Only when executed directly, so the derive/render functions above can be
// imported and asserted without launching a browser or touching Apple.
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
