import { chromium } from 'playwright';
import { BrowserFactory } from './browser.factory';
import { isCdpReachable } from './chrome-launcher';
import type { ConfigService } from '@nestjs/config';
import type { AppLogger } from '../observability/app-logger';
import type { AppleSessionStore } from './apple-session.store';

jest.mock('playwright', () => ({
  chromium: {
    connectOverCDP: jest.fn(),
    launch: jest.fn(),
    launchPersistentContext: jest.fn(),
  },
}));
jest.mock('./chrome-launcher', () => ({
  isCdpReachable: jest.fn(),
  ensureDebugChrome: jest.fn(),
  findChromeExecutable: jest.fn(),
  isLoopbackUrl: jest.fn(() => true),
}));

const connectOverCDP = chromium.connectOverCDP as jest.MockedFunction<
  typeof chromium.connectOverCDP
>;
const reachable = isCdpReachable as jest.MockedFunction<typeof isCdpReachable>;

/**
 * Values the factory reads on the attach path. Only what `open()` touches before
 * it hands back a session — the rest of the schema is irrelevant here.
 */
function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    PLAYWRIGHT_HEADLESS: false,
    PLAYWRIGHT_SLOW_MO_MS: 0,
    PLAYWRIGHT_NAV_TIMEOUT_MS: 45_000,
    PLAYWRIGHT_ACTION_TIMEOUT_MS: 20_000,
    PLAYWRIGHT_TRACE_ON_FAILURE: false,
    PLAYWRIGHT_TRACE_DIR: '.artifacts/traces',
    BROWSER_USER_DATA_DIR: '.playwright/profile',
    BROWSER_PROFILE_DIRECTORY: 'Default',
    BROWSER_CHANNEL: 'chrome',
    BROWSER_CDP_PORT: 9222,
    BROWSER_CDP_AUTOSTART: false,
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing config key ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;
}

/** A CDP browser stub: one existing context, one page. */
/** Exposed so a test can assert on the page the factory drove. */
let lastPage: { bringToFront: jest.Mock } | undefined;

function browserStub() {
  const page = {
    close: jest.fn(async () => undefined),
    setDefaultTimeout: jest.fn(),
    bringToFront: jest.fn(async () => undefined),
  };
  const context = {
    pages: () => [page],
    newPage: jest.fn(async () => page),
    setDefaultTimeout: jest.fn(),
    setDefaultNavigationTimeout: jest.fn(),
    close: jest.fn(async () => undefined),
    tracing: {
      start: jest.fn(async () => undefined),
      stop: jest.fn(async () => undefined),
    },
  };
  lastPage = page;
  return {
    contexts: () => [context],
    newContext: jest.fn(async () => context),
    close: jest.fn(async () => undefined),
  };
}

function build(config: ConfigService) {
  const logger = { emit: jest.fn() } as unknown as AppLogger;
  const sessionStore = {
    read: jest.fn(async () => undefined),
  } as unknown as AppleSessionStore;
  return new BrowserFactory(config, logger, sessionStore);
}

describe('BrowserFactory attach over CDP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    reachable.mockResolvedValue(true);
    connectOverCDP.mockResolvedValue(
      browserStub() as unknown as Awaited<
        ReturnType<typeof chromium.connectOverCDP>
      >,
    );
  });

  it('passes slowMo to connectOverCDP', async () => {
    // The regression this guards: slowMo used to be set only in launchOptions(),
    // so the two LAUNCH tiers honoured PLAYWRIGHT_SLOW_MO_MS while the attach
    // tier — the preferred one — silently ignored it.
    await build(configWith({ PLAYWRIGHT_SLOW_MO_MS: 800 })).open();

    expect(connectOverCDP).toHaveBeenCalledTimes(1);
    expect(connectOverCDP).toHaveBeenCalledWith(expect.any(String), {
      slowMo: 800,
    });
  });

  it('still passes slowMo at the default of 0, where it is a no-op', async () => {
    // 0 must be forwarded rather than omitted: Playwright guards the pause with
    // `if (slowMo)`, so this is inert, and asserting it keeps the option wired.
    await build(configWith({ PLAYWRIGHT_SLOW_MO_MS: 0 })).open();

    expect(connectOverCDP).toHaveBeenCalledWith(expect.any(String), {
      slowMo: 0,
    });
  });

  it('raises the tab when pacing is on, because someone is watching', async () => {
    // newPage() creates a BACKGROUND tab and does not raise the window, so a
    // paced run against a minimised Chrome is invisible — which is what happened
    // the first time this was demoed.
    await build(configWith({ PLAYWRIGHT_SLOW_MO_MS: 800 })).open();

    expect(lastPage?.bringToFront).toHaveBeenCalledTimes(1);
  });

  it('does not steal focus on an unattended run', async () => {
    // slowMo 0 is the unattended path: it must never pull the operator's window
    // to the foreground.
    await build(configWith({ PLAYWRIGHT_SLOW_MO_MS: 0 })).open();

    expect(lastPage?.bringToFront).not.toHaveBeenCalled();
  });

  it('never launches a browser when a CDP target answers', async () => {
    // Attaching is what preserves the Apple session; launching would start an
    // unauthenticated Chrome.
    await build(configWith()).open();

    expect(chromium.launch).not.toHaveBeenCalled();
    expect(chromium.launchPersistentContext).not.toHaveBeenCalled();
  });
});
