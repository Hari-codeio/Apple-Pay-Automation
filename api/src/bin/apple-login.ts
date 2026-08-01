import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { ApplePortalClient } from '../apple-portal/apple-portal.client';
import {
  findChromeExecutable,
  isCdpReachable,
  spawnChrome,
} from '../apple-portal/chrome-launcher';
import { createBootstrapLogger } from '../observability/app-logger';
import { CliModule } from './cli.module';

/**
 * One-time sign-in: `pnpm apple:login`
 *
 * Opens an ORDINARY Chrome — no debug port, no Playwright, none of its ~40
 * automation switches — on the automation's own profile directory, at the
 * merchant page. You sign in once; the profile keeps the session, and every
 * later run attaches to it.
 *
 * Why an ordinary Chrome rather than a Playwright-driven one: an identity
 * provider blocks the SIGN-IN FLOW in an automation-launched browser but reuses
 * an EXISTING login without complaint. This is the approach
 * `google-pay-automation/worker/chrome.ts` uses against Google's console, and
 * the reasoning is identical for Apple.
 *
 * Consequences of doing it this way, all of them improvements:
 *   - Nothing to wait for. The previous version drove the browser and blocked on
 *     `#form-merchantId`, which hung whenever Apple redirected to its account
 *     landing page instead of back to the deep link.
 *   - No profile lock fight: this is the only Chrome touching that directory.
 *   - No storageState file needed — the profile itself holds the session.
 */
async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(CliModule, {
    logger: createBootstrapLogger(),
  });

  try {
    const config = app.get(ConfigService);
    const portal = app.get(ApplePortalClient);

    const userDataDir = config.get<string>('BROWSER_USER_DATA_DIR');
    if (userDataDir === undefined) {
      throw new Error(
        'BROWSER_USER_DATA_DIR is not set. Sign-in needs a persistent profile ' +
          'directory to write the session into — set it to something like ' +
          '.playwright/chrome-profile and retry.',
      );
    }

    const profileDir = resolve(process.cwd(), userDataDir);
    await mkdir(profileDir, { recursive: true });

    const executablePath = findChromeExecutable({
      ...process.env,
      CHROME_EXECUTABLE_PATH:
        config.get<string>('CHROME_EXECUTABLE_PATH') ??
        process.env.CHROME_EXECUTABLE_PATH,
    });
    if (executablePath === undefined) {
      throw new Error(
        'Chrome not found. Set CHROME_EXECUTABLE_PATH to the chrome.exe path and retry.',
      );
    }

    // A debug Chrome holding this profile takes the singleton lock, so our
    // sign-in window would be handed off to it and never open — and signing in
    // inside THAT browser is exactly what does not work, because it was
    // automation-launched.
    //
    // Close it rather than refusing: an earlier `apple:verify` leaves one warm by
    // design, so refusing would deadlock the two commands against each other.
    // Safe to close unconditionally — a debug Chrome on OUR profile directory is
    // one we started; the operator's everyday browser is a different profile and
    // has no debug port.
    const port = config.getOrThrow<number>('BROWSER_CDP_PORT');
    const cdpUrl = `http://127.0.0.1:${port}`;
    if (await isCdpReachable(cdpUrl)) {
      process.stdout.write(
        `\n  Closing the warm debug Chrome on port ${port} (sign-in must not happen in it)…\n`,
      );
      const debugBrowser = await chromium.connectOverCDP(cdpUrl);
      // Over CDP this terminates the real browser — which is what we want here,
      // and the opposite of what the run path wants (see BrowserFactory.wrap).
      await debugBrowser.close().catch(() => undefined);

      // Wait for the lock to actually clear; Chrome takes a moment to exit, and
      // spawning into a half-closed profile hands off again.
      for (let i = 0; i < 20; i += 1) {
        if (!(await isCdpReachable(cdpUrl, 500))) break;
        await new Promise((r) => setTimeout(r, 500).unref());
      }
    }

    const profileDirectory = config.getOrThrow<string>(
      'BROWSER_PROFILE_DIRECTORY',
    );
    const targetUrl = portal.merchantEditUrl();
    spawnChrome({
      executablePath,
      userDataDir: profileDir,
      // Must match what the run path opens, or you sign into one profile and the
      // automation reads another — which is exactly what happened when this was
      // left to Local State's `last_used`.
      profileDirectory,
      // NO debugPort on purpose: that is what keeps this an ordinary Chrome and
      // keeps Apple's sign-in from treating it as automation.
      startUrl: targetUrl,
      noSandbox: config.get<boolean>('BROWSER_SANDBOX') === false,
    });

    process.stdout.write(
      [
        '',
        '  Opened an ordinary Chrome (no automation) on the automation profile:',
        `    directory: ${profileDir}`,
        `    profile:   ${profileDirectory}`,
        `    page:      ${targetUrl}`,
        '',
        `  1. Sign in as ${config.getOrThrow<string>('APPLE_ID_EMAIL')}`,
        '  2. Approve the two-factor prompt on your trusted device',
        '  3. Choose "Trust" so the session survives',
        '  4. Wait until the merchant identifier page renders, then CLOSE the window',
        '',
        '  Closing it lets Chrome flush cookies to the profile. After that,',
        '  `pnpm apple:verify <domain>` reuses this session with no sign-in —',
        '  including with your normal Chrome open, because this profile is its own.',
        '',
      ].join('\n'),
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\napple:login failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
