import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../common/constants';
import { runWithRequestContext } from './request-context';

/**
 * Upper bound on an inbound correlation ID. Without one, a client can push an
 * unbounded string into every log line the request produces.
 */
const MAX_INBOUND_ID_LENGTH = 128;

/**
 * Inbound IDs are echoed into a response header and into log lines, so the
 * charset is restricted rather than sanitized: a CR/LF would let a caller forge
 * log entries or split the HTTP response, and anything outside this set has no
 * legitimate use in a correlation ID.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Accept a caller-supplied correlation ID only if it is safe to echo; otherwise
 * return undefined so the caller mints a fresh one. Exported for direct testing.
 */
export function normalizeRequestId(raw: unknown): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INBOUND_ID_LENGTH) {
    return undefined;
  }
  return SAFE_REQUEST_ID.test(trimmed) ? trimmed : undefined;
}

/**
 * Mints or reuses the request's correlation ID, echoes it on the response, and
 * scopes the rest of the request in AsyncLocalStorage so every downstream log
 * line carries it.
 *
 * Must be the FIRST middleware: anything registered ahead of it logs outside
 * the context and loses the ID.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId =
      normalizeRequestId(req.headers[REQUEST_ID_HEADER]) ?? randomUUID();

    res.setHeader(REQUEST_ID_HEADER, requestId);
    runWithRequestContext({ requestId }, () => {
      next();
    });
  }
}
