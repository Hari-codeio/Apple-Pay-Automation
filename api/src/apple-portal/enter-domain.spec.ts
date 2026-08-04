import { ApplePortalClient } from './apple-portal.client';
import type { ConfigService } from '@nestjs/config';
import type { AppLogger } from '../observability/app-logger';
import type { BrowserFactory } from './browser.factory';

/**
 * Covers the one value-entry in the flow: `fill()` by default, per-character typing
 * when PLAYWRIGHT_TYPING_DELAY_MS is above 0.
 *
 * `enterDomain` is private, so it is reached through the instance rather than
 * re-declared. That is deliberate: the test asserts the behaviour of the real
 * method, and a public wrapper existing only for tests would be worse.
 */
type EnterDomain = (input: unknown, domain: string) => Promise<void>;

function clientWith(typingDelayMs: number): {
  enterDomain: EnterDomain;
  input: {
    fill: jest.Mock;
    pressSequentially: jest.Mock;
  };
} {
  const values: Record<string, unknown> = {
    PLAYWRIGHT_TYPING_DELAY_MS: typingDelayMs,
    PLAYWRIGHT_ACTION_TIMEOUT_MS: 20_000,
  };
  const config = {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing config key ${key}`);
      return values[key];
    },
  } as unknown as ConfigService;

  const client = new ApplePortalClient(
    config,
    { emit: jest.fn() } as unknown as AppLogger,
    {} as unknown as BrowserFactory,
  );

  const input = {
    fill: jest.fn(async () => undefined),
    pressSequentially: jest.fn(async () => undefined),
  };

  // Bound so `this.config` resolves inside the real method.
  const enterDomain = (
    client as unknown as { enterDomain: EnterDomain }
  ).enterDomain.bind(client);

  return { enterDomain, input };
}

const DOMAIN = 'secureorder.avixa.com';

describe('entering the domain into the form', () => {
  it('uses one atomic fill() at the default', async () => {
    // Production must keep taking this branch: fill() sets the value in a single
    // operation and fires one `input` event, which is what every unattended run
    // has always done.
    const { enterDomain, input } = clientWith(0);

    await enterDomain(input, DOMAIN);

    expect(input.fill).toHaveBeenCalledTimes(1);
    expect(input.fill).toHaveBeenCalledWith(DOMAIN);
    expect(input.pressSequentially).not.toHaveBeenCalled();
  });

  it('types key by key when a typing delay is set', async () => {
    const { enterDomain, input } = clientWith(100);

    await enterDomain(input, DOMAIN);

    expect(input.pressSequentially).toHaveBeenCalledTimes(1);
    expect(input.pressSequentially).toHaveBeenCalledWith(DOMAIN, {
      delay: 100,
      // Action timeout plus the typing itself, so the per-character delay can
      // never be the thing that trips the timeout.
      timeout: 20_000 + DOMAIN.length * 100,
    });
  });

  it('clears the field first so typing is an entry, not an append', async () => {
    // pressSequentially types at the caret and does not replace existing content.
    const { enterDomain, input } = clientWith(100);

    await enterDomain(input, DOMAIN);

    expect(input.fill).toHaveBeenCalledTimes(1);
    expect(input.fill).toHaveBeenCalledWith('');
    expect(input.fill.mock.invocationCallOrder[0]).toBeLessThan(
      input.pressSequentially.mock.invocationCallOrder[0],
    );
  });

  it('never types the domain with fill() when the delay is set', async () => {
    // Guards the branch from collapsing back into fill(domain), which would look
    // like it worked while showing nothing.
    const { enterDomain, input } = clientWith(250);

    await enterDomain(input, DOMAIN);

    expect(input.fill).not.toHaveBeenCalledWith(DOMAIN);
  });

  it('scales the timeout with the length of the domain', async () => {
    const short = clientWith(500);
    await short.enterDomain(short.input, 'a.co');

    expect(short.input.pressSequentially).toHaveBeenCalledWith('a.co', {
      delay: 500,
      timeout: 20_000 + 4 * 500,
    });
  });
});
