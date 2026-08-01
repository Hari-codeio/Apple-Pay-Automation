import {
  BadRequestException,
  ForbiddenException,
  HttpStatus,
  type ArgumentsHost,
} from '@nestjs/common';
import {
  AppleSessionMissingError,
  PortalElementNotFoundError,
} from '../../apple-portal/apple-portal.errors';
import { AppLogger } from '../../observability/app-logger';
import { REQUEST_ID_HEADER } from '../constants';
import { AllExceptionsFilter } from './all-exceptions.filter';

function hostWith(
  request: Partial<{ originalUrl: string; url: string; method: string }> = {},
  responseHeaders: Record<string, unknown> = {},
) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const response = {
    status,
    json,
    getHeader: (name: string) => responseHeaders[name],
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({
        method: 'POST',
        originalUrl: '/api/domain-verifications?x=1',
        url: '/api/domain-verifications',
        ...request,
      }),
    }),
  } as unknown as ArgumentsHost;

  return { host, status, json };
}

describe('AllExceptionsFilter', () => {
  let logger: { emit: jest.Mock };
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    logger = { emit: jest.fn() };
    filter = new AllExceptionsFilter(logger as unknown as AppLogger);
  });

  it('maps an HttpException to its own status', () => {
    const { host, status, json } = hostWith();

    filter.catch(new ForbiddenException('nope'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.FORBIDDEN);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 403,
        error: 'Forbidden',
        message: 'nope',
      }),
    );
  });

  it('maps an unknown throw to 500', () => {
    // @Catch() with no argument is the point: an unhandled TypeError must still
    // produce a correlated, shaped response.
    const { host, status } = hostWith();

    filter.catch(new TypeError('cannot read property of undefined'), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it('never leaks a 5xx message or stack to the caller', () => {
    // A mysql2 error string can contain the connection string; a Playwright
    // error can contain page content.
    const { host, json } = hostWith();

    filter.catch(
      new Error('connect ECONNREFUSED admin:hunter2@db.internal:3306'),
      host,
    );

    const body = json.mock.calls[0][0];
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('logs the withheld detail so it is recoverable by request id', () => {
    const { host } = hostWith();

    filter.catch(new Error('ECONNREFUSED db.internal'), host);

    expect(logger.emit).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Unhandled 500'),
      expect.objectContaining({
        exception: expect.objectContaining({
          message: 'ECONNREFUSED db.internal',
        }),
      }),
    );
  });

  it('preserves per-field validation detail on a 4xx', () => {
    // ValidationPipe's message array is what a client needs to fix the request.
    const { host, json } = hostWith();

    filter.catch(
      new BadRequestException([
        'domain must be a string',
        'domain is too short',
      ]),
      host,
    );

    expect(json.mock.calls[0][0].message).toEqual([
      'domain must be a string',
      'domain is too short',
    ]);
  });

  it('logs a 4xx at warn rather than error', () => {
    const { host } = hostWith();

    filter.catch(new BadRequestException('bad'), host);

    expect(logger.emit.mock.calls[0][0]).toBe('warn');
  });

  it('strips the query string from the reported path', () => {
    const { host, json } = hostWith();

    filter.catch(new BadRequestException('bad'), host);

    expect(json.mock.calls[0][0].path).toBe('/api/domain-verifications');
  });

  it('falls back to the response header for the request id', () => {
    // Covers a throw from outside the AsyncLocalStorage scope.
    const { host, json } = hostWith({}, { [REQUEST_ID_HEADER]: 'header-id' });

    filter.catch(new BadRequestException('bad'), host);

    expect(json.mock.calls[0][0].requestId).toBe('header-id');
  });

  describe('operational errors', () => {
    it('uses the status the error declares', () => {
      // 503 "the Apple session needs renewing" and 502 "the portal changed
      // shape" are different problems; reporting both as 500 hides which.
      const { host, status } = hostWith();

      filter.catch(
        new AppleSessionMissingError('.playwright/state.json'),
        host,
      );

      expect(status).toHaveBeenCalledWith(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it('returns the actionable message despite the 5xx status', () => {
      // The whole point: an operator reading "Internal server error" would go
      // digging for something we already knew.
      const { host, json } = hostWith();

      filter.catch(
        new AppleSessionMissingError('.playwright/state.json'),
        host,
      );

      expect(json.mock.calls[0][0].message).toMatch(/pnpm apple:login/);
    });

    it('maps a changed portal DOM to 502', () => {
      const { host, status, json } = hostWith();

      filter.catch(
        new PortalElementNotFoundError('save-domain', ['#a', '#b']),
        host,
      );

      expect(status).toHaveBeenCalledWith(HttpStatus.BAD_GATEWAY);
      expect(json.mock.calls[0][0].message).toContain('save-domain');
    });

    it('logs at error and names the error type', () => {
      const { host } = hostWith();

      filter.catch(
        new AppleSessionMissingError('.playwright/state.json'),
        host,
      );

      expect(logger.emit.mock.calls[0][0]).toBe('error');
      expect(logger.emit.mock.calls[0][1]).toContain(
        'AppleSessionMissingError',
      );
    });

    it('still withholds detail from an ordinary 500', () => {
      // The carve-out is for OperationalError only, not for every 5xx.
      const { host, json } = hostWith();

      filter.catch(
        new Error('connect ECONNREFUSED admin:hunter2@db:3306'),
        host,
      );

      expect(json.mock.calls[0][0].message).toBe('Internal server error');
    });
  });

  it('emits an ISO timestamp', () => {
    const { host, json } = hostWith();

    filter.catch(new BadRequestException('bad'), host);

    expect(json.mock.calls[0][0].timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });
});
