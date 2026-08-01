/**
 * Chrome process management, deliberately OUTSIDE Playwright.
 *
 * The design is lifted from `google-pay-automation/worker/chrome.ts`, which
 * solved this same problem against Google's console. The load-bearing insight
 * there applies verbatim to Apple:
 *
 *   An identity provider blocks the SIGN-IN FLOW in an automation-launched
 *   browser, but reuses an EXISTING login fine.
 *
 * So sign in once in an ordinary Chrome — no debug port, none of Playwright's
 * ~40 automation switches — and every later run attaches to a Chrome that is
 * already authenticated. That turns three separate problems into non-problems:
 *
 *   1. Chrome 136+ refuses DevTools remote debugging on the DEFAULT user-data-dir
 *      (anti-session-theft). A project-local profile sidesteps it.
 *   2. Chrome allows one process per user-data-dir. Attaching to a warm browser
 *      instead of launching a new one removes the lock fight entirely, so the
 *      operator never has to quit their browser.
 *   3. Launch cost. A warm browser means new TABS per domain, not new processes —
 *      which is what makes verifying many domains sane.
 *
 * Pure functions with no Nest dependency, so each is unit-testable without a
 * browser. `BrowserFactory` is the DI wrapper.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Chrome's DevTools endpoint, used to test whether a debug browser is up. */
const CDP_VERSION_PATH = '/json/version';

/**
 * Candidate Chrome locations per platform. `CHROME_EXECUTABLE_PATH` wins so an
 * unusual install (or Chromium/Edge) can be pointed at explicitly.
 *
 * Ported from google-pay-automation, which needed the same list to run on
 * developer laptops (Windows + macOS) and in a Linux container.
 */
export function chromeExecutableCandidates(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  return [
    env.CHROME_EXECUTABLE_PATH,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    env.LOCALAPPDATA
      ? `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`
      : undefined,
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter((candidate): candidate is string => Boolean(candidate));
}

/** First Chrome that exists on disk, or undefined. */
export function findChromeExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return chromeExecutableCandidates(env).find((candidate) => {
    try {
      return existsSync(candidate);
    } catch {
      return false;
    }
  });
}

/**
 * The ONLY kind of URL the CDP target may be.
 *
 * Attaching to a DevTools endpoint hands whoever answers full control of a
 * browser that holds a live Apple Developer session — so a non-loopback target
 * would be an SSRF primitive with credential theft attached. Ported from
 * `isLoopbackUrl` in google-pay-automation's capture-screenshots-runner, where
 * the same check guards its `--cdp` flag.
 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    const host = hostname
      .toLowerCase()
      .replace(/^\[/, '')
      .replace(/\]$/, '')
      .replace(/\.$/, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Is a debug Chrome answering at `url`? Short timeout: this runs on the hot path
 * before every operation, and an unreachable port must fail fast, not stall.
 */
export async function isCdpReachable(
  url: string,
  timeoutMs = 1_500,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}${CDP_VERSION_PATH}`, {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    // Cleared on the reject path too — google-pay-automation carries a comment
    // about having leaked this timer on ECONNREFUSED.
    clearTimeout(timer);
  }
}

export interface SpawnChromeOptions {
  executablePath: string;
  userDataDir: string;
  /**
   * Which profile inside `userDataDir` to open. ALWAYS passed explicitly.
   *
   * Chrome otherwise picks the profile named in `Local State`'s
   * `profile.last_used`. That is not hypothetical: a `Local State` copied from a
   * real Chrome installation carried `last_used: "Profile 4"`, so Chrome created
   * and used an empty `Profile 4` inside the target directory while the intended
   * cookies sat unused in `Default` — and a completed sign-in appeared to vanish.
   * Passing the flag makes the profile a property of our config, not of whatever
   * a copied file happens to say.
   */
  profileDirectory: string;
  /** Omit for a sign-in browser: no port means Chrome is not in automation mode. */
  debugPort?: number;
  /** Page to open. `about:blank` for a debug browser, the portal for sign-in. */
  startUrl: string;
  /** Chrome refuses to start as root in a container without --no-sandbox. */
  noSandbox?: boolean;
}

/**
 * Start Chrome detached and forget about it.
 *
 * Detached + unref so the browser outlives this Node process — that is the whole
 * point of a warm browser. Deliberately minimal flags: every extra switch is
 * another bit of automation fingerprint for Apple to notice.
 */
export function spawnChrome(options: SpawnChromeOptions): void {
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    `--profile-directory=${options.profileDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (options.debugPort !== undefined) {
    args.push(`--remote-debugging-port=${options.debugPort}`);
  }
  if (options.noSandbox === true) args.push('--no-sandbox');
  args.push(options.startUrl);

  const child = spawn(options.executablePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export interface EnsureDebugChromeOptions {
  url: string;
  executablePath: string | undefined;
  userDataDir: string;
  /** See SpawnChromeOptions.profileDirectory — never left to Local State. */
  profileDirectory: string;
  debugPort: number;
  noSandbox: boolean;
  /** Total wait for the port to come up. */
  startupTimeoutMs?: number;
  onLog?: (message: string) => void;
}

/**
 * Return a CDP URL that is definitely answering: attach to a running debug
 * Chrome, or start one and wait for its port.
 *
 * Idempotent by design — calling it when a debug browser is already up is a
 * single cheap HTTP probe, which is what makes it safe on every operation.
 * Returns undefined rather than throwing so the caller can fall through to
 * launching its own browser.
 */
export async function ensureDebugChrome(
  options: EnsureDebugChromeOptions,
): Promise<string | undefined> {
  const log = options.onLog ?? ((): void => undefined);

  if (await isCdpReachable(options.url)) return options.url;

  if (options.executablePath === undefined) {
    log('Chrome executable not found; set CHROME_EXECUTABLE_PATH');
    return undefined;
  }

  log(`Starting debug Chrome on ${options.url}`);
  spawnChrome({
    executablePath: options.executablePath,
    userDataDir: options.userDataDir,
    profileDirectory: options.profileDirectory,
    debugPort: options.debugPort,
    startUrl: 'about:blank',
    noSandbox: options.noSandbox,
  });

  // Poll rather than sleep-then-hope: a cold profile can take several seconds,
  // and a warm one is ready almost immediately.
  const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    if (await isCdpReachable(options.url)) return options.url;
    await sleep(500);
  }

  log('Debug Chrome did not expose its DevTools port in time');
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
