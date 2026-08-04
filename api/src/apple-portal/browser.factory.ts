import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page,
} from 'playwright';
import { AppLogger } from '../observability/app-logger';
import { AppleSessionStore } from './apple-session.store';
import {
  AppleSessionMissingError,
  BrowserProfileLockedError,
  CdpTargetNotLoopbackError,
} from './apple-portal.errors';
import {
  ensureDebugChrome,
  findChromeExecutable,
  isCdpReachable,
  isLoopbackUrl,
} from './chrome-launcher';

export interface OpenBrowserOptions {
  /** Override the configured headless setting. The assisted login needs a real window. */
  headless?: boolean;
  /**
   * Require and load the stored session. False for the login flow itself, which
   * is what creates that session.
   */
  useStoredSession?: boolean;
}

/**
 * An open browser plus the single page we drive. `close` is idempotent, so the
 * failure path can save a trace and the success path can discard one without
 * either having to know which ran first.
 */
export interface BrowserSession {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Persist the current storageState back to disk (after a successful login). */
  saveSession(): Promise<void>;
  /**
   * Close everything. With a label, the Playwright trace is written to
   * PLAYWRIGHT_TRACE_DIR and its path returned; without one the trace is
   * discarded. A trace of a successful run is just disk usage.
   */
  close(traceLabel?: string): Promise<string | undefined>;
}

@Injectable()
export class BrowserFactory {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly sessionStore: AppleSessionStore,
  ) {}

  async open(options: OpenBrowserOptions = {}): Promise<BrowserSession> {
    const headless =
      options.headless ??
      this.config.get<boolean>('PLAYWRIGHT_HEADLESS') ??
      true;
    const userDataDir = this.config.get<string>('BROWSER_USER_DATA_DIR');

    // Tier 1: attach to a warm debug Chrome. Preferred whenever a profile
    // directory is configured, because attaching avoids the profile lock
    // entirely and reuses an already-authenticated browser — no relaunch, and a
    // new TAB per operation instead of a new process.
    const attached =
      userDataDir === undefined
        ? undefined
        : await this.attachOverCdp(userDataDir);

    const { browser, context, mode, ownsPage } =
      attached ??
      // Tier 2/3: launch our own browser (persistent profile, falling back to a
      // throwaway one if the profile is busy), or an isolated storageState
      // browser when no profile directory is configured at all.
      (userDataDir === undefined
        ? {
            ...(await this.launchIsolated(
              headless,
              options.useStoredSession ?? true,
            )),
            mode: 'launched' as const,
            ownsPage: false,
          }
        : {
            ...(await this.launchPersistent(headless, userDataDir)),
            mode: 'launched' as const,
            ownsPage: false,
          });

    context.setDefaultTimeout(
      this.config.getOrThrow<number>('PLAYWRIGHT_ACTION_TIMEOUT_MS'),
    );
    context.setDefaultNavigationTimeout(
      this.config.getOrThrow<number>('PLAYWRIGHT_NAV_TIMEOUT_MS'),
    );

    // Tracing is unavailable on a context Playwright did not create, which is
    // exactly what CDP attachment gives us. Attempt it and degrade rather than
    // failing the run for the sake of a diagnostic.
    let tracing = this.tracingEnabled();
    if (tracing) {
      try {
        await context.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: false,
        });
      } catch (error) {
        tracing = false;
        this.logger.emit('warn', 'Playwright tracing unavailable', {
          mode,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Attached mode: always our OWN tab, so closing it cannot take down a tab
    // the operator was using. Launched mode: reuse the blank tab the profile
    // opened with rather than leaving an orphan window beside the one we drive.
    const page =
      mode === 'cdp'
        ? await context.newPage()
        : (context.pages()[0] ?? (await context.newPage()));

    // A non-zero slowMo means a human is watching this run, so put the tab where
    // they can see it. `newPage()` creates a BACKGROUND tab and does not raise the
    // window — so a paced run against a minimised or covered Chrome is completely
    // invisible, which is exactly what happened the first time this was demoed.
    //
    // Gated on slowMo rather than a new knob: at the default of 0 nothing is taken
    // from the operator's foreground, which is what an unattended run needs.
    // Best-effort — a failure to focus is never a reason to fail the run.
    if (this.config.getOrThrow<number>('PLAYWRIGHT_SLOW_MO_MS') > 0) {
      await page.bringToFront().catch(() => undefined);
    }

    // `ownsPage` is true exactly when mode is 'cdp' (we open our own tab there),
    // so it needs no further widening — TypeScript correlates the two and rejects
    // a redundant `|| mode === 'cdp'` as unreachable.
    return this.wrap(browser, context, page, tracing, mode, ownsPage);
  }

  /**
   * Tier 1 — attach to a Chrome we did not launch.
   *
   * Ported from `google-pay-automation/worker/store-agent.ts`, which drives
   * Google's console the same way. Three properties matter:
   *
   *   - **No profile lock.** We are not starting a second Chrome on the
   *     directory, so the operator's browser can stay open.
   *   - **Not automation-launched.** The browser was started as an ordinary
   *     Chrome (plus a debug port), so it carries none of Playwright's ~40
   *     automation switches. Identity providers treat it as a normal browser.
   *   - **Warm.** Attaching costs one HTTP probe; launching costs a process.
   *
   * Returns undefined when no debug browser is available, so the caller falls
   * through to launching one.
   */
  private async attachOverCdp(userDataDir: string): Promise<
    | {
        browser: Browser;
        context: BrowserContext;
        mode: 'cdp';
        ownsPage: true;
      }
    | undefined
  > {
    const target = await this.resolveCdpTarget(userDataDir);
    if (target === undefined) return undefined;

    // slowMo has to be passed here too, not only in launchOptions(). It used to be
    // set exclusively there, which meant the two LAUNCH tiers honoured
    // PLAYWRIGHT_SLOW_MO_MS and this — the preferred tier — silently ignored it:
    // the repo advertised a knob its own default path threw away.
    //
    // Inert at the schema default of 0. Playwright's dispatcher guards the pause
    // with `if (slowMo)`, so zero costs not even a microtask, and the delay runs
    // after the action completes rather than inside its progress controller, so a
    // large value can never trip an action timeout.
    const browser = await chromium.connectOverCDP(target, {
      slowMo: this.config.getOrThrow<number>('PLAYWRIGHT_SLOW_MO_MS'),
    });
    // Reuse the EXISTING context. `browser.newContext()` over CDP creates an
    // incognito-like context that does not share the profile's cookies, which
    // would throw away the Apple session that is the entire point of attaching.
    const context = browser.contexts()[0] ?? (await browser.newContext());

    this.logger.emit('info', 'Attached to a running Chrome over CDP', {
      target,
      contexts: browser.contexts().length,
    });
    return { browser, context, mode: 'cdp', ownsPage: true };
  }

  /**
   * Where to attach. An explicit `BROWSER_CDP_URL` is honoured (loopback only);
   * otherwise probe the configured port and, if `BROWSER_CDP_AUTOSTART` is on,
   * start a debug Chrome on the configured profile.
   */
  private async resolveCdpTarget(
    userDataDir: string,
  ): Promise<string | undefined> {
    const explicit = this.config.get<string>('BROWSER_CDP_URL');
    if (explicit !== undefined) {
      // Refused rather than warned about: attaching hands the holder of that
      // endpoint full control of a browser carrying a live Apple session.
      if (!isLoopbackUrl(explicit)) {
        throw new CdpTargetNotLoopbackError(explicit);
      }
      return (await isCdpReachable(explicit)) ? explicit : undefined;
    }

    const port = this.config.getOrThrow<number>('BROWSER_CDP_PORT');
    const url = `http://127.0.0.1:${port}`;

    if (this.config.get<boolean>('BROWSER_CDP_AUTOSTART') === false) {
      return (await isCdpReachable(url)) ? url : undefined;
    }

    return ensureDebugChrome({
      url,
      // Config wins over the raw env: @nestjs/config's validated snapshot is the
      // authority, and process.env may not carry a defaulted value.
      executablePath: findChromeExecutable({
        ...process.env,
        CHROME_EXECUTABLE_PATH:
          this.config.get<string>('CHROME_EXECUTABLE_PATH') ??
          process.env.CHROME_EXECUTABLE_PATH,
      }),
      userDataDir: resolve(process.cwd(), userDataDir),
      profileDirectory: this.config.getOrThrow<string>(
        'BROWSER_PROFILE_DIRECTORY',
      ),
      debugPort: port,
      noSandbox: this.config.get<boolean>('BROWSER_SANDBOX') === false,
      onLog: (message) => this.logger.emit('info', message, { target: url }),
    });
  }

  /**
   * Default mode: a throwaway profile seeded from the saved `storageState`.
   * Nothing persists between runs except that JSON file.
   */
  private async launchIsolated(
    headless: boolean,
    useStoredSession: boolean,
  ): Promise<{ browser: Browser; context: BrowserContext }> {
    const contextOptions = await this.buildContextOptions(useStoredSession);
    const browser = await chromium.launch(this.launchOptions(headless));
    return { browser, context: await browser.newContext(contextOptions) };
  }

  /**
   * Persistent-profile mode (`BROWSER_USER_DATA_DIR`): the on-disk Chrome
   * profile IS the credential, so no `storageState` is loaded or required.
   *
   * This is the more durable way to hold an Apple session. Apple's "trust this
   * browser" decision lives in the profile alongside device-binding state that a
   * `storageState` JSON does not capture, so a persistent profile survives 2FA
   * re-prompts that would otherwise force another `apple:login`.
   *
   * Two operational constraints:
   *   1. Chrome CANNOT be running against this directory. Chrome holds a
   *      process-singleton lock on its profile, and the launch fails outright if
   *      it is held — which is why pointing this at your everyday profile means
   *      quitting your browser for every run. Prefer a dedicated directory.
   *   2. The directory accumulates real browsing state and a live Apple session.
   *      Treat it exactly like the session file: never commit it, never copy it.
   */
  private async launchPersistent(
    headless: boolean,
    userDataDir: string,
  ): Promise<{ browser: undefined; context: BrowserContext }> {
    const dir = resolve(process.cwd(), userDataDir);
    await mkdir(dir, { recursive: true });

    const profileDirectory = this.config.getOrThrow<string>(
      'BROWSER_PROFILE_DIRECTORY',
    );
    const launch = this.launchOptions(headless);

    this.logger.emit('info', 'Launching with a persistent browser profile', {
      userDataDir: dir,
      profileDirectory,
      channel: this.config.get<string>('BROWSER_CHANNEL'),
    });

    try {
      // launchPersistentContext returns a context that owns its own browser
      // process; there is no separate Browser handle to close.
      const context = await chromium.launchPersistentContext(dir, {
        ...launch,
        args: [
          ...launch.args,
          // ALWAYS explicit. Chrome otherwise follows `profile.last_used` from
          // Local State — see BROWSER_PROFILE_DIRECTORY in the config schema for
          // the failure that caused.
          `--profile-directory=${profileDirectory}`,
        ],
        acceptDownloads: true,
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
      });
      return { browser: undefined, context };
    } catch (error) {
      // Playwright reports a busy profile as a launch failure with the entire
      // Chromium command line attached — sixty flags of noise around a one-line
      // fix. Two wordings are observed for the same cause, neither reliably
      // distinguishable from an unrelated crash, so both are translated and the
      // original is carried through in the message:
      //   real Chrome holds it  -> "Opening in existing browser session … already in use"
      //   Playwright holds it   -> "Target page, context or browser has been closed"
      const message = error instanceof Error ? error.message : String(error);
      const firstLine = message.split('\n')[0].trim();
      if (
        /existing browser session|already in use|Target page, context or browser has been closed/i.test(
          message,
        )
      ) {
        // NO throwaway-profile fallback here, deliberately.
        //
        // google-pay-automation falls back to a temporary profile at this point,
        // and copying that was a mistake: its flow still produces useful output
        // unauthenticated, whereas ours cannot do anything at all without the
        // Apple session — which lives in THIS directory and nowhere else. A
        // throwaway profile therefore guarantees a later
        // "session is not authenticated" failure, and that message sends the
        // operator to re-run `apple:login` when the actual problem is a Chrome
        // holding the profile. Reporting the lock is the honest diagnosis.
        throw new BrowserProfileLockedError(dir, profileDirectory, firstLine);
      }
      throw error;
    }
  }

  private launchOptions(headless: boolean): {
    headless: boolean;
    slowMo: number;
    args: string[];
    chromiumSandbox: boolean;
    channel?: string;
  } {
    // 'chromium' means Playwright's own bundled build. Any other value is a
    // branded browser that must already be installed on the machine — Playwright
    // does not download those.
    const channel = this.config.getOrThrow<string>('BROWSER_CHANNEL');
    return {
      headless,
      slowMo: this.config.getOrThrow<number>('PLAYWRIGHT_SLOW_MO_MS'),
      // Chromium's default shared-memory budget is 64MB in a container, and
      // exceeding it crashes the renderer mid-run with no useful error.
      args: ['--disable-dev-shm-usage'],
      // Playwright defaults this to FALSE, which makes Chrome launch with
      // --no-sandbox and show a "stability and security will suffer" banner. This
      // browser loads a third-party site we do not control, so the renderer
      // sandbox is worth keeping. Overridable because a container usually cannot
      // sandbox without extra kernel capabilities.
      chromiumSandbox: this.config.get<boolean>('BROWSER_SANDBOX') ?? true,
      ...(channel === 'chromium' ? {} : { channel }),
    };
  }

  private wrap(
    browser: Browser | undefined,
    context: BrowserContext,
    page: Page,
    tracing: boolean,
    mode: 'cdp' | 'launched',
    ownsPage: boolean,
  ): BrowserSession {
    let closed = false;

    return {
      context,
      page,
      saveSession: async () => {
        await this.sessionStore.write(await context.storageState());
      },
      close: async (traceLabel?: string) => {
        if (closed) return undefined;
        closed = true;

        let tracePath: string | undefined;
        try {
          if (tracing) {
            if (traceLabel === undefined) {
              await context.tracing.stop();
            } else {
              const dir = resolve(
                process.cwd(),
                this.config.getOrThrow<string>('PLAYWRIGHT_TRACE_DIR'),
              );
              await mkdir(dir, { recursive: true });
              tracePath = join(
                dir,
                `${sanitizeLabel(traceLabel)}-${Date.now()}.zip`,
              );
              await context.tracing.stop({ path: tracePath });
              this.logger.emit('warn', 'Playwright trace saved', { tracePath });
            }
          }
        } catch (error) {
          // Never let trace bookkeeping mask the failure that triggered it.
          this.logger.emit('warn', 'Failed to finalise Playwright trace', {
            reason: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (mode === 'cdp') {
            // ATTACHED MODE: detach, never close. The browser belongs to the
            // operator — it is very likely the window they are looking at, and
            // it holds the Apple session every later run depends on. Closing
            // `context` here would shut their tabs; closing `browser` would kill
            // the browser outright.
            //
            // Only the tab we opened gets closed. `browser.close()` is
            // deliberately NOT called: over CDP it terminates the real browser.
            // Dropping the reference is enough — the connection closes with the
            // process, exactly as google-pay-automation's runner does it.
            if (ownsPage) await page.close().catch(() => undefined);
          } else {
            await context.close().catch(() => undefined);
            // undefined in persistent-profile mode: the context owns the browser
            // process and closing it terminates Chrome.
            await browser?.close().catch(() => undefined);
          }
        }
        return tracePath;
      },
    };
  }

  private async buildContextOptions(
    useStoredSession: boolean,
  ): Promise<BrowserContextOptions> {
    const base: BrowserContextOptions = {
      // Required for the association-file download to be capturable at all.
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      locale: 'en-US',
    };

    if (!useStoredSession) return base;

    const raw = await this.sessionStore.read();
    if (raw === undefined) {
      throw new AppleSessionMissingError(this.sessionStore.path());
    }
    return {
      ...base,
      storageState: JSON.parse(raw) as BrowserContextOptions['storageState'],
    };
  }

  private tracingEnabled(): boolean {
    return this.config.get<boolean>('PLAYWRIGHT_TRACE_ON_FAILURE') ?? true;
  }
}

/** Keep trace filenames safe on every filesystem — labels contain domains and step names. */
function sanitizeLabel(label: string): string {
  return label.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
}
