import type { LoggerService } from '@nestjs/common';
import { pino, type Logger as PinoLogger } from 'pino';
import { DEFAULT_LOG_LEVEL, isDevLikeTier } from '../common/constants';
import { getRequestId } from './request-context';

/**
 * Structured logging for the whole service.
 *
 * One JSON object per line in every deployed tier — that is what makes a log
 * aggregator able to filter by `requestId` and reconstruct a single payment
 * verification end to end. `LOG_PRETTY=true` swaps in human-readable output for
 * a developer machine.
 *
 * Wired as the Nest logger (`app.useLogger`), so framework log lines and
 * application log lines share one format and one correlation ID.
 */

export type LogLevel =
  'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface AppLoggerOptions {
  level: LogLevel;
  pretty: boolean;
  serviceName: string;
  environment: string;
}

/**
 * Keys whose values never belong in a log line, at the top level or one level
 * down. Payment-adjacent services accumulate log statements that dump a whole
 * request or gateway response, and `paymentData` in an Apple Pay token is the
 * encrypted card payload itself.
 */
const REDACT_PATHS = [
  'authorization',
  'cookie',
  'password',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'paymentData',
  'paymentToken',
  '*.authorization',
  '*.cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.apiKey',
  '*.paymentData',
  '*.paymentToken',
];

const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

function isLogLevel(value: string | undefined): value is LogLevel {
  return (
    value !== undefined && (LOG_LEVELS as readonly string[]).includes(value)
  );
}

/**
 * Resolve logger options straight from env rather than from `ConfigService`.
 *
 * The bootstrap logger has to exist before the DI container does — the whole
 * point is to capture failures that happen while the container is still being
 * built. Defaults mirror the boot schema (both import them from
 * `common/constants`), so the two cannot drift.
 */
export function resolveLoggerOptions(
  env: NodeJS.ProcessEnv = process.env,
): AppLoggerOptions {
  const environment = (env.ENVIRONMENT ?? 'local').toLowerCase();
  const rawLevel = env.LOG_LEVEL?.toLowerCase();
  const prettyRequested = env.LOG_PRETTY
    ? env.LOG_PRETTY.toLowerCase() === 'true'
    : isDevLikeTier(environment);

  return {
    level: isLogLevel(rawLevel) ? rawLevel : DEFAULT_LOG_LEVEL,
    // pino-pretty runs as a worker thread. Under Jest a lingering worker keeps
    // the process alive after the suite passes, which reads as a hung CI job.
    pretty: prettyRequested && env.NODE_ENV !== 'test',
    serviceName: env.SERVICE_NAME ?? 'apple-pay-api',
    environment,
  };
}

function createPinoLogger(options: AppLoggerOptions): PinoLogger {
  return pino({
    level: options.level,
    base: { service: options.serviceName, env: options.environment },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    // Emit `"level":"info"` rather than pino's numeric level, so a human
    // reading raw JSON does not have to know the level table.
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service,env',
              messageFormat: '{context} {msg}',
            },
          },
        }
      : {}),
  });
}

function formatMessage(message: unknown): string {
  if (typeof message === 'string') return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/**
 * Nest hands trailing metadata positionally and untyped: `log(msg, context)`
 * for most levels, `error(msg, stack, context)` for errors. Treat a trailing
 * single-line string as the context (the class name Nest passes), and a
 * multi-line one as a stack trace.
 */
function splitOptionalParams(params: unknown[]): {
  context?: string;
  stack?: string;
  extra: unknown[];
} {
  const rest = [...params];
  let context: string | undefined;
  let stack: string | undefined;

  const last = rest[rest.length - 1];
  if (typeof last === 'string' && !last.includes('\n')) {
    context = last;
    rest.pop();
  }
  const next = rest[rest.length - 1];
  if (typeof next === 'string' && next.includes('\n')) {
    stack = next;
    rest.pop();
  }
  return { context, stack, extra: rest };
}

function serializeExtra(value: unknown): unknown {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack, name: value.name };
  }
  return value;
}

/**
 * NestJS `LoggerService` backed by pino.
 *
 * Constructed via a factory provider (see `ObservabilityModule`) rather than by
 * Nest's class instantiation, because its only constructor argument is a plain
 * options interface — which has no DI token.
 */
export class AppLogger implements LoggerService {
  private readonly root: PinoLogger;

  constructor(options: AppLoggerOptions) {
    this.root = createPinoLogger(options);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    this.write('info', message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write('error', message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write('warn', message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write('debug', message, optionalParams);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write('trace', message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write('fatal', message, optionalParams);
  }

  /**
   * Emit a log line with explicit structured fields — the shape you want when
   * the fields will be queried (status codes, durations, identifiers) rather
   * than read. The correlation ID is attached automatically.
   */
  emit(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    fields: Record<string, unknown> = {},
  ): void {
    const requestId = getRequestId();
    this.root[level](
      requestId === undefined ? fields : { ...fields, requestId },
      message,
    );
  }

  private write(
    level: Exclude<LogLevel, 'silent'>,
    message: unknown,
    optionalParams: unknown[],
  ): void {
    const { context, stack, extra } = splitOptionalParams(optionalParams);
    const bindings: Record<string, unknown> = {};

    if (context !== undefined) bindings.context = context;
    const requestId = getRequestId();
    if (requestId !== undefined) bindings.requestId = requestId;
    if (stack !== undefined) bindings.stack = stack;
    if (message instanceof Error && message.stack !== undefined) {
      bindings.stack = message.stack;
    }
    if (extra.length > 0) bindings.details = extra.map(serializeExtra);

    this.root[level](bindings, formatMessage(message));
  }
}

/**
 * Logger for the window before the DI container exists. Passed to
 * `NestFactory.create({ logger })` so a module that throws during
 * initialization produces a structured, correlatable line instead of a bare
 * stack trace on stderr.
 */
export function createBootstrapLogger(): AppLogger {
  return new AppLogger(resolveLoggerOptions());
}
