/**
 * Runtime-agnostic env validation. No framework dependency, so both NestJS
 * services (via ./nest) and plain Node entrypoints (scripts, workers) can share
 * one mechanism.
 *
 * - `validateEnv` — check-only: returns the ORIGINAL env unchanged, unless
 *   `applyParsed` merges the schema's parsed output over env (so defaults and
 *   coercions reach the caller). On failure it throws (strict) or warns and
 *   continues (log-only).
 * - `parseEnv` — returns the schema's parsed/transformed output, or throws a
 *   `ConfigValidationError`. For entrypoints whose schema maps env into a typed
 *   config object.
 *
 * One NestJS caveat lives in ./nest, not here: registering any `validate` fn
 * (even an identity-returning one) makes @nestjs/config cache a validated env
 * snapshot that ConfigService.get() reads BEFORE live process.env — so a
 * post-boot mutation of an existing process.env key stops being visible through
 * ConfigService. See makeValidateEnv.
 */

import type { ZodType } from 'zod';

type ZodIssueLike = { path: PropertyKey[]; message: string };

/** A single validation failure, framework-agnostic. */
export interface ConfigIssue {
  /** Dotted env-var path (e.g. 'APPLE_PAY_MERCHANT_ID'); '' for a schema-level issue. */
  path: string;
  message: string;
}

function toConfigIssues(issues: ZodIssueLike[]): ConfigIssue[] {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function summarize(issues: ConfigIssue[]): string {
  return issues
    .map((issue) => `${issue.path || '(config)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Thrown by `parseEnv` on validation failure. `.issues` is the structured list
 * so callers can format it themselves; `.message` is a single-line summary
 * naming every offending var, for logs.
 *
 * Note the message carries variable NAMES and validation messages only, never
 * the offending values — an env validation failure must not leak a malformed
 * secret into a log aggregator.
 */
export class ConfigValidationError extends Error {
  readonly issues: ConfigIssue[];

  constructor(issues: ConfigIssue[]) {
    super(`[config] env validation failed: ${summarize(issues)}`);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }
}

export interface ValidateEnvOptions {
  /** Throw on validation failure (fail-fast) instead of only logging. */
  strict: boolean;
  /** Sink for the log-only warning. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  /**
   * On success, return the schema's parsed output (defaults + coercions
   * applied) merged over the original env, instead of the untouched env. Use
   * for services that rely on the validator to apply schema defaults.
   */
  applyParsed?: boolean;
}

/**
 * Validate `env` against a Zod `schema`. Unknown keys are ignored (Zod object
 * schemas strip by default, and process.env always carries unrelated OS vars).
 * The return value is the original `env` unless `applyParsed` is set, in which
 * case the parsed (defaulted/coerced) values are merged over it on success.
 */
export function validateEnv(
  schema: ZodType,
  env: Record<string, unknown>,
  opts: ValidateEnvOptions,
): Record<string, unknown> {
  const result = schema.safeParse(env);
  if (result.success) {
    return opts.applyParsed
      ? { ...env, ...(result.data as Record<string, unknown>) }
      : env;
  }
  const message = summarize(toConfigIssues(result.error.issues));
  if (opts.strict) {
    throw new Error(`[config] env validation failed: ${message}`);
  }
  (opts.warn ?? ((m) => console.warn(m)))(
    `[config] env validation issues (log-only): ${message}`,
  );
  return env;
}

/**
 * Parse `env` against a Zod `schema` and return its (transformed) output.
 * Always fail-fast: throws a {@link ConfigValidationError} whose `.issues`
 * name every offending var. For entrypoints whose schema maps env into a typed
 * config object.
 */
export function parseEnv<T>(
  schema: ZodType<T>,
  env: Record<string, unknown>,
): T {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new ConfigValidationError(toConfigIssues(result.error.issues));
  }
  return result.data;
}
