import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ApplePortalClient } from '../apple-portal/apple-portal.client';
import {
  ensureDebugChrome,
  findChromeExecutable,
  isCdpReachable,
} from '../apple-portal/chrome-launcher';
import { createBootstrapLogger } from '../observability/app-logger';
import { CliModule } from './cli.module';

/**
 * Start the long-lived debug Chrome and leave it running: `pnpm apple:chrome`
 *
 * This exists because of a hard Apple constraint discovered by inspecting the
 * cookies in an attached browser: the developer-portal session cookie
 * (`myacinfo`) is a SESSION cookie. Chrome never writes it to disk, so it dies
 * with the browser. Everything else persists — locale, geo, and the
 * `DES…` device-trust cookie on idmsa.apple.com — which is why a signed-in
 * profile still lands on the sign-in page after a restart.
 *
 * The consequence: for Apple there is no "sign in once, close, reuse forever".
 * The browser holding the session must STAY OPEN, and every run attaches to it.
 * That is the model `google-pay-automation` uses (`npm run chrome` → leave open →
 * agent attaches over CDP); Google's session merely happens to survive a
 * restart, so its `chrome:signin` can close the window. Apple's cannot.
 *
 * Workflow:
 *   1. pnpm apple:chrome                → starts it, prints the URL, LEAVE IT OPEN
 *   2. sign into Apple in that window   → session lives in memory
 *   3. pnpm apple:verify <domain>       → attaches; no sign-in needed
 *   4. repeat 3 as often as you like; only redo 1–2 if the window is closed
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
        'BROWSER_USER_DATA_DIR is not set — the debug Chrome needs a profile ' +
          'directory of its own (e.g. .playwright/chrome-profile).',
      );
    }

    const profileDir = resolve(process.cwd(), userDataDir);
    await mkdir(profileDir, { recursive: true });

    const port = config.getOrThrow<number>('BROWSER_CDP_PORT');
    const url = `http://127.0.0.1:${port}`;
    const alreadyUp = await isCdpReachable(url);

    const target = await ensureDebugChrome({
      url,
      executablePath: findChromeExecutable({
        ...process.env,
        CHROME_EXECUTABLE_PATH:
          config.get<string>('CHROME_EXECUTABLE_PATH') ??
          process.env.CHROME_EXECUTABLE_PATH,
      }),
      userDataDir: profileDir,
      profileDirectory: config.getOrThrow<string>('BROWSER_PROFILE_DIRECTORY'),
      debugPort: port,
      noSandbox: config.get<boolean>('BROWSER_SANDBOX') === false,
      onLog: (message) => process.stdout.write(`  ${message}\n`),
    });

    if (target === undefined) {
      throw new Error(
        `Chrome did not expose its DevTools port on ${url}. If a Chrome is already ` +
          `running on '${profileDir}' WITHOUT a debug port, close it and retry — ` +
          `Chrome hands off to the existing process instead of opening a new one.`,
      );
    }

    process.stdout.write(
      [
        '',
        alreadyUp
          ? '  A debug Chrome was ALREADY running — reusing it.'
          : '  Debug Chrome started.',
        `    devtools:  ${target}`,
        `    directory: ${profileDir}`,
        `    profile:   ${config.getOrThrow<string>('BROWSER_PROFILE_DIRECTORY')}`,
        '',
        '  LEAVE THIS BROWSER OPEN.',
        '',
        `  1. In that window, open: ${portal.merchantEditUrl()}`,
        '  2. Sign in if it asks (device trust is already stored, so 2FA may be skipped)',
        '  3. Then run:  pnpm apple:verify <domain>',
        '',
        "  Apple's session cookie (myacinfo) is memory-only — it is never written to",
        '  disk. Closing this browser loses the session and you will have to sign in',
        '  again. Your everyday Chrome is a different profile and is unaffected.',
        '',
      ].join('\n'),
    );
  } finally {
    // Only this Node process exits. The browser was spawned detached and unref'd,
    // so it keeps running — which is the entire point of this command.
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    `\napple:chrome failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
