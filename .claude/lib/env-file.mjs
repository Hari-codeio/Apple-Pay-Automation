/**
 * Tolerant `.env` reader for the skill scripts.
 *
 * Matches the parsing the app itself tolerates: `export ` prefixes, surrounding
 * quotes, comment lines, blank lines, CRLF. Deliberately NOT a dotenv clone — it
 * does not expand variables or handle multi-line values, because nothing in
 * `api/.env` uses them.
 *
 * This logic already exists inline in register-domain's check-row.mjs and
 * verify-apple-domain's run-verify.mjs. Those two copies are left alone on
 * purpose: editing them would drag two working skills into an unrelated change.
 * New scripts import this one so a third copy never appears.
 */
import { readFileSync } from 'node:fs';

export function parseEnvFile(text) {
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

export function readEnvFile(path) {
  return parseEnvFile(readFileSync(path, 'utf8'));
}

/**
 * The CDP endpoint the app would attach to, derived exactly as
 * browser.factory.ts resolveCdpTarget does: an explicit BROWSER_CDP_URL wins,
 * otherwise loopback on BROWSER_CDP_PORT, defaulting to 9222.
 */
export function cdpTargetFrom(env) {
  const explicit = (env.BROWSER_CDP_URL ?? '').trim();
  if (explicit !== '') return explicit;
  const port = (env.BROWSER_CDP_PORT ?? '').trim() || '9222';
  return `http://127.0.0.1:${port}`;
}
