#!/usr/bin/env node
/**
 * Read back what the verification flow actually wrote, and judge it.
 *
 * The CLI prints what the service *returned*. This reads the row that landed in
 * `phoenix_release.apple_pay_domain_verifications`, which is the thing that has
 * to be right — and asserts the expiry specifically, because a wrong
 * verification_expires_at is invisible until Apple Pay silently stops working.
 *
 *   node check-row.mjs --ping                 connectivity only, writes nothing
 *   node check-row.mjs pay.example.com        inspect + assert one domain
 *   node check-row.mjs pay.example.com --json machine-readable
 *
 * Exit codes: 0 all assertions passed · 1 an assertion failed · 2 could not run.
 *
 * Read-only by construction: the only statements issued are SELECTs.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const TABLE = 'apple_pay_domain_verifications';

/** Apple's real domain-verification window is ~90 days. */
const PLAUSIBLE_MAX_DAYS = 120;

/** ─── locating the workspace ───────────────────────────────────────────────
 * Walk up for the directory holding `api/package.json` so this keeps working if
 * the skill is moved or the repo is checked out somewhere else.
 */
function findApiDir(startDir) {
  let dir = startDir;
  for (let hops = 0; hops < 12; hops += 1) {
    if (existsSync(join(dir, 'api', 'package.json'))) return join(dir, 'api');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function parseEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

function die(message) {
  console.error(`\n  cannot run: ${message}\n`);
  process.exit(2);
}

/** ─── connection, mirroring MysqlService ───────────────────────────────────
 * dateStrings so a timezone-less DATETIME is never reinterpreted through the
 * process timezone, and TLS on unless explicitly disabled — the same two choices
 * the service makes, for the same reasons.
 */
function buildConnectionOptions(env, apiDir) {
  for (const key of ['DB_HOST', 'DB_PORT', 'DB_NAME', 'DB_USER']) {
    if (!env[key]) die(`${key} is not set in api/.env`);
  }

  let ssl;
  if (env.DB_SSL !== 'false') {
    ssl = { minVersion: 'TLSv1.2', rejectUnauthorized: true };
    const caPath = env.DB_SSL_CA_PATH;
    if (caPath !== undefined && caPath !== '') {
      const resolved = isAbsolute(caPath) ? caPath : resolve(apiDir, caPath);
      if (!existsSync(resolved)) {
        die(
          `DB_SSL_CA_PATH points at '${resolved}', which does not exist. ` +
            `Without the RDS bundle the handshake fails with HANDSHAKE_SSL_ERROR.`,
        );
      }
      ssl.ca = readFileSync(resolved, 'utf8');
    }
  }

  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD ?? '',
    connectTimeout: Number(env.DB_CONNECT_TIMEOUT_MS ?? 10_000),
    dateStrings: true,
    multipleStatements: false,
    ...(ssl === undefined ? {} : { ssl }),
  };
}

/** `2026-10-28 00:00:00` as stored: no zone, so read it as UTC explicitly. */
function parseStoredUtc(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = new Date(`${value.trim().replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function assessExpiry(row, now) {
  const checks = [];
  const raw = row.verification_expires_at;
  const isActive = row.status === 'active';

  if (raw === null || raw === undefined) {
    checks.push({
      ok: !isActive,
      label: 'verification_expires_at is populated',
      detail: isActive
        ? 'NULL on an \'active\' row — Apple verified but no date was read. Grep the run output for "expiry".'
        : `NULL, which is correct for status '${row.status}': Apple publishes an expiry only once it verifies.`,
    });
    return { checks, expiry: undefined };
  }

  const expiry = parseStoredUtc(raw);
  if (expiry === undefined) {
    checks.push({
      ok: false,
      label: 'verification_expires_at is a readable DATETIME',
      detail: `stored value '${raw}' did not parse`,
    });
    return { checks, expiry: undefined };
  }

  checks.push({
    ok: true,
    label: 'verification_expires_at is populated',
    detail: `${raw} UTC  (${expiry.toISOString()})`,
  });

  // Start-of-day anchor. The portal states a day with no time, and this codebase
  // deliberately stores 00:00:00 so it never claims more runway than Apple gave.
  const atStartOfDay = /\b00:00:00$/.test(String(raw).trim());
  checks.push({
    ok: atStartOfDay,
    label: 'anchored to start of day UTC',
    detail: atStartOfDay
      ? 'time component is 00:00:00 as intended'
      : `time component is not 00:00:00 — got '${raw}'. Expected the start-of-day anchor.`,
  });

  const days = (expiry.getTime() - now.getTime()) / 86_400_000;
  const rounded = Math.round(days * 10) / 10;

  const notExpired = days > 0;
  checks.push({
    ok: notExpired,
    label: 'expiry is in the future',
    detail: notExpired
      ? `${rounded} days from now`
      : `already ${Math.abs(rounded)} days in the past`,
  });

  // The tell for the bug this flow was built to fix: a computed `now + 365 days`
  // lands ~9 months past anything Apple actually issues.
  const plausible = days > 0 && days <= PLAUSIBLE_MAX_DAYS;
  checks.push({
    ok: plausible,
    label: `within Apple's plausible window (<= ${PLAUSIBLE_MAX_DAYS} days)`,
    detail: plausible
      ? `${rounded} days out, consistent with Apple's ~90-day window`
      : days > PLAUSIBLE_MAX_DAYS
        ? `${rounded} days out — too far. This is what a computed TTL looks like, not a scraped date. Confirm it matches the portal.`
        : `${rounded} days out`,
  });

  return { checks, expiry };
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const ping = argv.includes('--ping');
  const positional = argv.filter((arg) => !arg.startsWith('-'));

  if (!ping && positional.length !== 1) {
    die(
      'usage: node check-row.mjs <domain> [--json]   |   node check-row.mjs --ping',
    );
  }

  const apiDir = findApiDir(dirname(fileURLToPath(import.meta.url)));
  if (apiDir === undefined)
    die('could not locate the api/ directory from this script');

  const envPath = join(apiDir, '.env');
  if (!existsSync(envPath)) {
    die(`no api/.env at ${envPath}. Copy api/.env.example and fill it in.`);
  }

  const env = parseEnvFile(readFileSync(envPath, 'utf8'));
  const options = buildConnectionOptions(env, apiDir);

  // mysql2 lives in api/node_modules, which is not on this file's resolution
  // path — require it from the api package's context instead.
  const requireFromApi = createRequire(
    pathToFileURL(join(apiDir, 'package.json')),
  );
  let mysql;
  try {
    mysql = requireFromApi('mysql2/promise');
  } catch {
    die('mysql2 is not installed. Run `pnpm install` at the repo root.');
  }

  let connection;
  try {
    connection = await mysql.createConnection(options);
  } catch (error) {
    die(
      `could not connect to ${options.host}:${options.port}/${options.database} — ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    if (ping) {
      const [rows] = await connection.execute('SELECT 1 AS ok');
      const ok = Array.isArray(rows) && rows.length === 1;
      console.log(
        ok
          ? `  db reachable: ${options.database} at ${options.host} (TLS ${options.ssl ? 'on' : 'off'})`
          : '  db responded unexpectedly to SELECT 1',
      );
      process.exit(ok ? 0 : 1);
    }

    const domain = positional[0].trim().toLowerCase();
    const [rows] = await connection.execute(
      `SELECT domain, store_code, merchant_id, apple_team_id, status,
              content_sha256, verification_expires_at, last_verified_at,
              last_probe_at, last_probe_ok, created_at, updated_at, is_deleted,
              CHAR_LENGTH(verification_file) AS verification_file_length
         FROM ${TABLE}
        WHERE domain = ?`,
      [domain],
    );

    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row === undefined) {
      if (asJson)
        console.log(JSON.stringify({ domain, found: false }, null, 2));
      else
        console.error(
          `\n  no row for '${domain}' — the database write did not land\n`,
        );
      process.exit(1);
    }

    const now = new Date();
    const { checks: expiryChecks } = assessExpiry(row, now);

    const checks = [
      {
        ok: row.is_deleted === 0 || row.is_deleted === false,
        label: 'row is not soft-deleted',
        detail: `is_deleted = ${row.is_deleted}`,
      },
      {
        ok:
          typeof row.content_sha256 === 'string' &&
          row.content_sha256.length === 64,
        label: 'association file SHA-256 stored',
        detail: String(row.content_sha256 ?? 'NULL'),
      },
      {
        ok: Number(row.verification_file_length ?? 0) > 100,
        label: 'association file body stored',
        detail: `${row.verification_file_length ?? 0} chars`,
      },
      ...expiryChecks,
      {
        ok: row.status !== 'active' || row.last_verified_at !== null,
        label: 'last_verified_at set when active',
        detail: String(row.last_verified_at ?? 'NULL'),
      },
    ];

    const failed = checks.filter((check) => !check.ok);

    if (asJson) {
      console.log(
        JSON.stringify(
          { domain, found: true, row, checks, failed: failed.length },
          null,
          2,
        ),
      );
      process.exit(failed.length === 0 ? 0 : 1);
    }

    console.log(`\n  ${TABLE} — ${row.domain}\n`);
    for (const [label, value] of [
      ['status', row.status],
      ['verification_expires_at', row.verification_expires_at ?? 'NULL'],
      ['last_verified_at', row.last_verified_at ?? 'NULL'],
      [
        'last_probe_at / ok',
        `${row.last_probe_at ?? 'NULL'} / ${row.last_probe_ok ?? 'NULL'}`,
      ],
      ['merchant_id', row.merchant_id ?? 'NULL'],
      ['apple_team_id', row.apple_team_id ?? 'NULL'],
      ['store_code', row.store_code ?? 'NULL'],
      [
        'created_at / updated_at',
        `${row.created_at ?? 'NULL'} / ${row.updated_at ?? 'NULL'}`,
      ],
    ]) {
      console.log(`    ${String(label).padEnd(26)} ${value}`);
    }

    console.log('\n  assertions\n');
    for (const check of checks) {
      console.log(`    ${check.ok ? 'PASS' : 'FAIL'}  ${check.label}`);
      console.log(`          ${check.detail}`);
    }

    console.log(
      failed.length === 0
        ? '\n  all checks passed\n'
        : `\n  ${failed.length} check(s) failed\n`,
    );
    process.exit(failed.length === 0 ? 0 : 1);
  } finally {
    await connection.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(
    `\n  unexpected failure: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(2);
});
