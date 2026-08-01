import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { REQUEST_ID_HEADER } from '../constants';
import { getRequestId } from '../../observability/request-context';
import { AppLogger } from '../../observability/app-logger';
import { OperationalError } from '../errors/operational-error';
import type { ApiErrorResponse } from '../http/api-error-response';

/**
 * Single exit point for every failed request.
 *
 * `@Catch()` with no argument catches EVERYTHING, not just `HttpException` —
 * that is the point. An unhandled `TypeError` would otherwise reach Nest's
 * default handler, and while that does return a bare 500, nothing correlates it
 * to a request ID. This service drives a third-party portal and a database it
 * does not own, so unexpected throws are a normal Tuesday.
 *
 * Three rules:
 *   1. A 5xx response body never carries the error's message or stack. A
 *      mysql2 error string can contain the connection string; a Playwright
 *      error can contain a page snippet. The detail goes to the log, keyed by
 *      request ID, and the caller gets that ID.
 *   2. `OperationalError` is the deliberate exception to rule 1: its subclasses
 *      promise a client-safe message that names the next action ("run pnpm
 *      apple:login"). Swallowing those helps nobody — the operator would read
 *      "Internal server error" and go digging for something we already knew.
 *   3. Every response has the same shape (see ApiErrorResponse), so a client
 *      writes one error handler.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status = this.resolveStatus(exception);
    // "Withhold the detail" applies to UNEXPECTED failures only. An
    // `HttpException` payload and an `OperationalError` message are both
    // author-chosen and deliberate, at any status — sanitizing those turns a
    // precise diagnosis into "Internal server error" for no security gain.
    const isServerError =
      status >= HttpStatus.INTERNAL_SERVER_ERROR &&
      !(exception instanceof OperationalError) &&
      !(exception instanceof HttpException);
    // Prefer the ALS value; fall back to the header the middleware set, which
    // covers a throw from outside the request context.
    const requestId =
      getRequestId() ?? this.headerRequestId(response) ?? undefined;
    const path = request.originalUrl?.split('?')[0] ?? request.url;

    const body: ApiErrorResponse = {
      statusCode: status,
      error: this.reasonPhrase(status),
      message: isServerError
        ? 'Internal server error'
        : this.clientMessage(exception),
      requestId,
      path,
      timestamp: new Date().toISOString(),
    };

    // The log line carries what the response withholds.
    const detail = {
      statusCode: status,
      httpMethod: request.method,
      httpPath: path,
      exception: this.describe(exception),
    };
    // An operational 5xx still logs at error — it needs an operator — but it is
    // a known condition rather than an unexplained crash, so say so.
    if (isServerError) {
      this.logger.emit('error', `Unhandled ${status} on ${path}`, detail);
    } else if (
      exception instanceof OperationalError &&
      status >= HttpStatus.INTERNAL_SERVER_ERROR
    ) {
      this.logger.emit('error', `${exception.name} on ${path}`, detail);
    } else {
      this.logger.emit('warn', `Rejected ${status} on ${path}`, detail);
    }

    response.status(status).json(body);
  }

  private resolveStatus(exception: unknown): number {
    if (exception instanceof HttpException) return exception.getStatus();
    // A known operational failure carries the status it deserves: 503 for "the
    // Apple session needs renewing", 502 for "the portal changed shape".
    // Reporting both as 500 hides which one an operator is looking at.
    if (exception instanceof OperationalError) return exception.httpStatus;
    return HttpStatus.INTERNAL_SERVER_ERROR;
  }

  private headerRequestId(response: Response): string | undefined {
    const value = response.getHeader(REQUEST_ID_HEADER);
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * Extract the client-safe message from a 4xx. `ValidationPipe` throws a
   * BadRequestException whose response body is `{ message: string[] }`, and
   * that array is the per-field detail a client actually needs.
   */
  private clientMessage(exception: unknown): string | string[] {
    // Client-safe by contract, and the message is the whole point.
    if (exception instanceof OperationalError) return exception.message;
    if (!(exception instanceof HttpException)) return 'Request failed';
    const payload = exception.getResponse();
    if (typeof payload === 'string') return payload;
    if (typeof payload === 'object' && payload !== null) {
      const message = (payload as { message?: unknown }).message;
      if (typeof message === 'string') return message;
      if (
        Array.isArray(message) &&
        message.every((m): m is string => typeof m === 'string')
      ) {
        return message;
      }
    }
    return exception.message;
  }

  private describe(exception: unknown): Record<string, unknown> {
    if (exception instanceof Error) {
      return {
        name: exception.name,
        message: exception.message,
        stack: exception.stack,
      };
    }
    return { name: 'UnknownException', message: String(exception) };
  }

  private reasonPhrase(status: number): string {
    // HttpStatus is a numeric enum, so indexing it by the numeric value hits the
    // reverse mapping and yields the canonical name ('BAD_REQUEST'). The cast is
    // needed because TypeScript types enum indexing by the key union, not by
    // number, and a status we do not have a name for must not crash the filter.
    const names = HttpStatus as unknown as Record<number, string | undefined>;
    const name = names[status];
    if (name === undefined) return 'Error';
    // 'BAD_REQUEST' -> 'Bad Request'
    return name
      .toLowerCase()
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
}
