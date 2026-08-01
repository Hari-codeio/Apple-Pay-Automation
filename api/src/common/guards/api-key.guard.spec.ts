import {
  ForbiddenException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiKeyGuard, API_KEY_HEADER } from './api-key.guard';

const VALID_KEY = 'k'.repeat(32);

function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
}

function contextWith(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  it('allows a matching key', () => {
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'production' }),
    );

    expect(
      guard.canActivate(contextWith({ [API_KEY_HEADER]: VALID_KEY })),
    ).toBe(true);
  });

  it('rejects a wrong key', () => {
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'production' }),
    );

    expect(() =>
      guard.canActivate(contextWith({ [API_KEY_HEADER]: 'x'.repeat(32) })),
    ).toThrow(UnauthorizedException);
  });

  it('rejects a missing key', () => {
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'production' }),
    );

    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects a key of a different length without throwing from timingSafeEqual', () => {
    // timingSafeEqual throws on length mismatch; the guard must compare lengths
    // first or an attacker gets a 500 instead of a 401.
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'production' }),
    );

    expect(() =>
      guard.canActivate(contextWith({ [API_KEY_HEADER]: 'short' })),
    ).toThrow(UnauthorizedException);
  });

  it('uses the first value when the header repeats', () => {
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'production' }),
    );

    expect(
      guard.canActivate(
        contextWith({ [API_KEY_HEADER]: [VALID_KEY, 'x'.repeat(32)] }),
      ),
    ).toBe(true);
  });

  it('fails closed when no key is configured on a shared tier', () => {
    // The alternative is an open route that registers domains on a live
    // merchant identifier.
    const guard = new ApiKeyGuard(configWith({ ENVIRONMENT: 'production' }));

    expect(() => guard.canActivate(contextWith({}))).toThrow(
      ForbiddenException,
    );
  });

  it('allows unauthenticated access on a dev-like tier with no key configured', () => {
    const guard = new ApiKeyGuard(configWith({ ENVIRONMENT: 'local' }));

    expect(guard.canActivate(contextWith({}))).toBe(true);
  });

  it('still enforces a configured key on a dev-like tier', () => {
    const guard = new ApiKeyGuard(
      configWith({ API_KEY: VALID_KEY, ENVIRONMENT: 'local' }),
    );

    expect(() => guard.canActivate(contextWith({}))).toThrow(
      UnauthorizedException,
    );
  });
});
