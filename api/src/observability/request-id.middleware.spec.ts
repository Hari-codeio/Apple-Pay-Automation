import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../common/constants';
import {
  RequestIdMiddleware,
  normalizeRequestId,
} from './request-id.middleware';
import { getRequestId } from './request-context';

describe('normalizeRequestId', () => {
  it('accepts a safe inbound id', () => {
    expect(normalizeRequestId('abc-123_456.789')).toBe('abc-123_456.789');
  });

  it('takes the first value when a header repeats', () => {
    expect(normalizeRequestId(['first', 'second'])).toBe('first');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeRequestId('  abc123  ')).toBe('abc123');
  });

  it.each([
    ['a CRLF injection attempt', 'abc\r\nSet-Cookie: x=1'],
    ['a bare newline', 'abc\ndef'],
    ['a space in the middle', 'abc def'],
    ['a semicolon', 'abc;def'],
    ['an empty string', '   '],
    ['a non-string', 42],
    ['undefined', undefined],
  ])('rejects %s', (_label, input) => {
    expect(normalizeRequestId(input)).toBeUndefined();
  });

  it('rejects an id longer than 128 characters', () => {
    // Otherwise a caller can push an unbounded string into every log line the
    // request produces.
    expect(normalizeRequestId('a'.repeat(129))).toBeUndefined();
    expect(normalizeRequestId('a'.repeat(128))).toBe('a'.repeat(128));
  });
});

describe('RequestIdMiddleware', () => {
  const middleware = new RequestIdMiddleware();

  function run(headers: Record<string, unknown>): {
    setHeader: jest.Mock;
    seenInsideContext: string | undefined;
  } {
    const setHeader = jest.fn();
    let seenInsideContext: string | undefined;
    const next: NextFunction = () => {
      seenInsideContext = getRequestId();
    };
    middleware.use(
      { headers } as unknown as Request,
      { setHeader } as unknown as Response,
      next,
    );
    return { setHeader, seenInsideContext };
  }

  it('reuses a safe inbound id and echoes it on the response', () => {
    const { setHeader, seenInsideContext } = run({
      [REQUEST_ID_HEADER]: 'inbound-id',
    });

    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'inbound-id');
    expect(seenInsideContext).toBe('inbound-id');
  });

  it('mints a UUID when no id is supplied', () => {
    const { setHeader, seenInsideContext } = run({});

    expect(seenInsideContext).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(setHeader).toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      seenInsideContext,
    );
  });

  it('mints a fresh id rather than echoing an unsafe one', () => {
    const { setHeader } = run({ [REQUEST_ID_HEADER]: 'bad\r\nvalue' });

    expect(setHeader).not.toHaveBeenCalledWith(
      REQUEST_ID_HEADER,
      'bad\r\nvalue',
    );
  });

  it('leaves no context behind once the request is done', () => {
    run({ [REQUEST_ID_HEADER]: 'inbound-id' });
    expect(getRequestId()).toBeUndefined();
  });
});
