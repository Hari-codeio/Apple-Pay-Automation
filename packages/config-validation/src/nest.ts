/**
 * NestJS ConfigModule adapter for the shared env validator.
 *
 *   ConfigModule.forRoot({
 *     isGlobal: true,
 *     validate: makeValidateEnv(schema, { applyParsed: true }),
 *   })
 *
 * Strictness posture: this repo is fail-fast by DEFAULT. A service that boots
 * with an invalid env is a service that will fail later, at the first request
 * that touches the bad value — by which point the failure is a 500 in a payment
 * flow instead of a CrashLoopBackOff with a readable message. The
 * `CONFIG_VALIDATION_LOG_ONLY=true` escape hatch exists only to unblock an
 * operator mid-incident, and downgrades a hard failure to a warning.
 */

import { Logger } from '@nestjs/common';
import type { ZodType } from 'zod';
import { validateEnv } from './core';

const logger = new Logger('ConfigValidation');

/**
 * Whether env validation should throw at boot (fail-fast) instead of only
 * logging. Fail-fast unless an operator explicitly opts out.
 */
export function isStrictConfigValidation(
  env: Record<string, unknown> = process.env,
): boolean {
  return env.CONFIG_VALIDATION_LOG_ONLY !== 'true';
}

export interface MakeValidateEnvOptions {
  /**
   * Return the schema's parsed output (defaults + coercions applied) merged
   * over env. Needed by services that rely on schema-applied defaults, which is
   * every service that reads a defaulted var through `ConfigService.get()`.
   */
  applyParsed?: boolean;
}

/**
 * Builds a NestJS `ConfigModule` `validate` function from a Zod schema.
 *
 * ConfigService snapshot caveat: @nestjs/config caches whatever this returns as
 * the validated env, and `ConfigService.get()` reads that frozen snapshot
 * BEFORE live `process.env`. The mere presence of a `validate` fn therefore
 * means a post-boot mutation of an existing `process.env` key is no longer
 * visible through `ConfigService.get()` (reads were live without `validate`).
 * The first place this can surface is a test that sets `process.env.X` and
 * reads it back through a real `ConfigModule` — set the env BEFORE the testing
 * module is compiled.
 */
export function makeValidateEnv(
  schema: ZodType,
  opts: MakeValidateEnvOptions = {},
) {
  return (config: Record<string, unknown>) =>
    validateEnv(schema, config, {
      strict: isStrictConfigValidation(config),
      warn: (message) => logger.warn(message),
      applyParsed: opts.applyParsed === true,
    });
}
