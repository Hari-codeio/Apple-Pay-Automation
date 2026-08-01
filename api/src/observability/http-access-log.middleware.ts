import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { QUIET_LOG_PATHS } from '../common/constants';
import { AppLogger, type LogLevel } from './app-logger';

/**
 * One access-log line per request, emitted on response finish.
 *
 * Without this, a request rejected before any controller matches — a 401 from a
 * guard, a 429 from the throttler, a 404 on a typo'd path — leaves no trace at
 * all, which is exactly the class of failure that is hardest to diagnose from a
 * bug report.
 *
 * Level follows the outcome so the default `info` stream stays signal:
 * 5xx → error, 4xx → warn, orchestrator probes → debug, everything else → info.
 */
@Injectable()
export class HttpAccessLogMiddleware implements NestMiddleware {
  constructor(private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    // Capture the path up front: Express rewrites req.url while routing, so
    // reading it on 'finish' can report the post-rewrite value.
    const path = req.originalUrl.split('?')[0];
    const method = req.method;

    res.on('finish', () => {
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const statusCode = res.statusCode;

      this.logger.emit(
        this.levelFor(statusCode, path),
        `${method} ${path} ${statusCode} ${durationMs.toFixed(1)}ms`,
        {
          httpMethod: method,
          httpPath: path,
          statusCode,
          durationMs: Number(durationMs.toFixed(3)),
          // req.ip honours Express's `trust proxy` setting, so this is the real
          // client rather than the load balancer. See resolveTrustProxy.
          clientIp: req.ip,
          userAgent: req.headers['user-agent'],
        },
      );
    });

    next();
  }

  private levelFor(
    statusCode: number,
    path: string,
  ): Exclude<LogLevel, 'silent'> {
    if (statusCode >= 500) return 'error';
    if (statusCode >= 400) return 'warn';
    // Probes poll every few seconds per replica and would otherwise dominate
    // the info stream.
    if (QUIET_LOG_PATHS.includes(path)) return 'debug';
    return 'info';
  }
}
