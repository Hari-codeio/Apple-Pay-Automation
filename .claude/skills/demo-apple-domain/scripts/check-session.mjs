#!/usr/bin/env node
/**
 * Is the attached Chrome actually signed in to the Apple Developer portal?
 *
 *   node check-session.mjs                 human-readable
 *   node check-session.mjs --json          machine-readable
 *
 * Exit codes: 0 signed in · 1 not signed in · 2 could not check.
 *
 * WHY THIS EXISTS SEPARATELY
 * `myacinfo` is a SESSION cookie — Chrome never writes it to disk, so it dies with
 * the browser (see api/src/bin/apple-chrome.ts). A debug Chrome that was restarted
 * since the last sign-in therefore answers /json/version perfectly happily and
 * still fails the run at assertAuthenticated, minutes in and in front of an
 * audience. Reading the cookie locally converts that into a sentence beforehand.
 *
 * It NEVER calls browser.close(). Over CDP that terminates the operator's real
 * browser and takes the session with it — the same reason browser.factory.ts
 * detaches instead of closing. The open CDP connection is an active libuv handle,
 * so this exits explicitly rather than falling off the end of main().
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readEnvFile, cdpTargetFrom } from '../../../lib/env-file.mjs';

const APPLE_ORIGIN = 'https://developer.apple.com';
/** The one cookie that proves an authenticated portal session. */
const SESSION_COOKIE = 'myacinfo';

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

function die(message) {
  process.stderr.write(`\n  ${message}\n\n`);
  process.exit(2);
}

const asJson = process.argv.includes('--json');
const apiDir = findApiDir(dirname(fileURLToPath(import.meta.url)));
if (apiDir === undefined) die('could not locate the api/ directory');

const envPath = join(apiDir, '.env');
if (!existsSync(envPath)) die(`no api/.env at ${envPath}`);

const env = readEnvFile(envPath);
const target = cdpTargetFrom(env);

// playwright lives in api/node_modules, which is not on this file's resolution
// path — require it from the api package's context instead.
const requireFromApi = createRequire(
  pathToFileURL(join(apiDir, 'package.json')),
);
let chromium;
try {
  ({ chromium } = requireFromApi('playwright'));
} catch {
  die('playwright is not installed. Run `pnpm install` at the repo root.');
}

let browser;
try {
  browser = await chromium.connectOverCDP(target, { timeout: 10_000 });
} catch (error) {
  const reason =
    error instanceof Error ? error.message.split('\n')[0] : String(error);
  if (asJson) {
    console.log(JSON.stringify({ target, attached: false, reason }, null, 2));
  } else {
    process.stderr.write(
      `\n  could not attach to ${target} — ${reason}\n` +
        '  Start it and sign in:  pnpm apple:chrome\n\n',
    );
  }
  process.exit(2);
}

const context = browser.contexts()[0];
if (context === undefined) {
  if (asJson)
    console.log(JSON.stringify({ target, attached: true, contexts: 0 }));
  else
    process.stderr.write(`\n  attached to ${target} but it has no context\n\n`);
  process.exit(2);
}

const cookies = await context.cookies(APPLE_ORIGIN);
const hasCookie = cookies.some((c) => c.name === SESSION_COOKIE);

/**
 * The cookie is NOT proof. Apple invalidates sessions server-side while
 * `myacinfo` sits in the jar looking perfectly healthy — observed here: this
 * check reported "signed in" while the very next run landed on
 * idmsa.apple.com/IDMSWebAuth/signin.
 *
 * So do what assertAuthenticated does and ask the only question that matters:
 * navigate to the merchant page and see where we land. Read-only, no rate limit,
 * and it is the same first request the real run makes.
 */
const teamId = env.APPLE_TEAM_ID ?? '';
const merchantId = env.APPLE_MERCHANT_ID ?? '';
const base = (env.APPLE_PORTAL_BASE_URL ?? APPLE_ORIGIN).replace(/\/+$/, '');
const merchantUrl = `${base}/account/resources/identifiers/merchant/edit/${teamId}/${merchantId}`;
const SIGN_IN_MARKERS = [
  '/auth/signin',
  'idmsa.apple.com',
  'appleid.apple.com/auth',
];

let landedUrl;
let navError;
const probe = await context.newPage();
try {
  await probe.goto(merchantUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 25_000,
  });
  landedUrl = probe.url();
} catch (error) {
  navError =
    error instanceof Error ? error.message.split('\n')[0] : String(error);
} finally {
  // Only the tab we opened. Never browser.close() — see the header.
  await probe.close().catch(() => undefined);
}

const redirectedToSignIn =
  landedUrl !== undefined && SIGN_IN_MARKERS.some((m) => landedUrl.includes(m));
const signedIn = hasCookie && landedUrl !== undefined && !redirectedToSignIn;

// Pages open on the portal, useful for telling the operator what they are looking at.
const portalPages = context
  .pages()
  .map((p) => p.url())
  .filter((u) => u.startsWith(APPLE_ORIGIN));

const result = {
  target,
  attached: true,
  contexts: browser.contexts().length,
  signedIn,
  hasCookie,
  sessionCookie: SESSION_COOKIE,
  appleCookieCount: cookies.length,
  merchantUrl,
  landedUrl,
  redirectedToSignIn,
  navError,
  portalPages,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (signedIn) {
  console.log(
    `  signed in: loaded the merchant page without a sign-in redirect ` +
      `(${cookies.length} Apple cookies, ${SESSION_COOKIE} present)`,
  );
} else if (navError !== undefined) {
  process.stderr.write(
    `\n  COULD NOT TELL: navigating to the merchant page failed — ${navError}\n` +
      '  That is usually a network problem, not a session problem. Retry.\n\n',
  );
} else if (redirectedToSignIn) {
  process.stderr.write(
    `\n  NOT signed in: the merchant page redirected to a sign-in screen.\n` +
      `  landed on: ${landedUrl}\n` +
      (hasCookie
        ? `  Note ${SESSION_COOKIE} IS in the cookie jar — Apple invalidated the\n` +
          '  session server-side, so the cookie proves nothing on its own.\n'
        : `  No ${SESSION_COOKIE} cookie either; it is a session cookie and dies\n` +
          '  with the browser.\n') +
      '  Sign in inside the attached Chrome, leave it open, then re-check.\n\n',
  );
} else {
  process.stderr.write(
    `\n  NOT signed in: no ${SESSION_COOKIE} cookie on ${APPLE_ORIGIN}.\n` +
      '  Sign in inside the attached Chrome, then re-check.\n\n',
  );
}

// Deliberately no browser.close(): over CDP that would kill the operator's Chrome.
process.exit(signedIn ? 0 : 1);
