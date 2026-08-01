import { HttpStatus } from '@nestjs/common';
import { OperationalError } from '../common/errors/operational-error';

/**
 * Failure modes of driving someone else's web UI, as distinct types.
 *
 * The distinction is operational, not cosmetic: an expired session needs a human
 * to run `apple:login`, a changed selector needs a developer, and a rejected
 * domain needs the caller to fix their input. Collapsing all three into
 * "automation failed" means every alert gets the same useless triage.
 *
 * All four extend `OperationalError`, so their messages reach the caller instead
 * of being flattened to "Internal server error" — each one names the next action,
 * and none carries a credential or page content.
 */

/**
 * 503, not 500: the service is temporarily unable to act, and it will keep being
 * unable until a human re-authenticates. A 5xx also keeps it out of the caller's
 * "my request was malformed" bucket, which it is not.
 */
export class AppleSessionExpiredError extends OperationalError {
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(landedUrl: string) {
    super(
      `Apple portal session is not authenticated (landed on ${landedUrl}). ` +
        `Re-authenticate with: pnpm apple:login`,
    );
  }
}

export class AppleSessionMissingError extends OperationalError {
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  constructor(statePath: string) {
    super(
      `No stored Apple portal session at '${statePath}'. ` +
        `Create one with: pnpm apple:login`,
    );
  }
}

/**
 * Chrome refused to open the profile because it is already open.
 *
 * Chrome allows one browser process per user-data-dir and enforces it with a
 * process singleton — two processes writing the same cookie database and
 * Preferences would corrupt them. When the singleton is already held, Chrome
 * hands the URL to the running instance and exits, so Playwright never gets a
 * debugging connection and reports it as a launch failure buried under sixty
 * command-line flags.
 *
 * The lock covers the whole user-data-dir, not one profile: every profile lives
 * under the same directory, so ANY open Chrome window holds it.
 */
export class BrowserProfileLockedError extends OperationalError {
  readonly httpStatus = HttpStatus.SERVICE_UNAVAILABLE;

  /**
   * `reason` is the underlying Playwright message. It is included because the
   * two failure shapes are not distinguishable with certainty: a real Chrome
   * holding the lock reports "Opening in existing browser session … already in
   * use", while a Playwright-launched one reports the generic "Target page,
   * context or browser has been closed". The message therefore leads with the
   * overwhelmingly likely cause without claiming it as fact.
   */
  constructor(userDataDir: string, profileDirectory: string, reason: string) {
    super(
      `Chrome could not open profile '${profileDirectory}' in '${userDataDir}', and no debug ` +
        `Chrome was reachable to attach to instead. Something is holding that profile — ` +
        `most often the sign-in window from \`pnpm apple:login\`, which must be CLOSED once ` +
        `you have signed in (Chrome only flushes cookies to disk on a clean exit, so leaving ` +
        `it open also means the session is never saved). Find what holds it with:\n` +
        `  powershell "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | ` +
        `Where-Object { $_.CommandLine -like '*${profileDirectory}*' } | Select ProcessId"\n` +
        `This is NOT your everyday browser — that profile is separate and can stay open. ` +
        `Underlying error: ${reason}`,
    );
  }
}

/**
 * A CDP target outside loopback was configured.
 *
 * Attaching to a DevTools endpoint gives whoever answers it full control of a
 * browser holding a live Apple Developer session, so a remote target would be an
 * SSRF primitive with credential theft attached. Refused at 500 rather than
 * downgraded to a warning: there is no legitimate non-loopback use, so this can
 * only be a misconfiguration or an attack.
 *
 * Mirrors the `--cdp` loopback rule in google-pay-automation's
 * capture-screenshots-runner.
 */
export class CdpTargetNotLoopbackError extends OperationalError {
  readonly httpStatus = HttpStatus.INTERNAL_SERVER_ERROR;

  constructor(target: string) {
    super(
      `BROWSER_CDP_URL must point at loopback (localhost, 127.0.0.1, or ::1); got '${target}'. ` +
        `Attaching to a remote DevTools endpoint would hand control of a browser holding a live ` +
        `Apple session to whoever answers it.`,
    );
  }
}

/**
 * 502: the upstream we depend on changed shape. Carries the selector so the log
 * line and the response both name the thing to fix.
 */
export class PortalElementNotFoundError extends OperationalError {
  readonly httpStatus = HttpStatus.BAD_GATEWAY;

  constructor(
    readonly step: string,
    readonly selectors: readonly string[],
  ) {
    super(
      `Apple portal step '${step}' found none of its selectors: ${selectors.join(' | ')}. ` +
        `The portal DOM has probably changed — check the Playwright trace and update selectors.ts`,
    );
  }
}

/** 502: the portal answered, and its answer was no. */
export class PortalRejectedError extends OperationalError {
  readonly httpStatus = HttpStatus.BAD_GATEWAY;

  constructor(
    readonly step: string,
    reason: string,
  ) {
    super(`Apple portal rejected '${step}': ${reason}`);
  }
}
