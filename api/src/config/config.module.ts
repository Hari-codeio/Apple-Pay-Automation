import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { makeValidateEnv } from '@apple-pay/config-validation';
import { configValidationSchema } from './validation-schema';

/**
 * Global config module.
 *
 * `applyParsed: true` returns the schema's parsed output (defaults +
 * coercions), so `ConfigService.get<number>('PORT')` yields a real number
 * instead of the string the OS handed the process — every consumer would
 * otherwise have to re-coerce and one of them eventually would not.
 *
 * `.env` files are read on dev-like tiers only by convention: deployed tiers
 * inject env directly, and silently picking up a stray `.env` inside a
 * container image is a config-provenance bug waiting to happen. @nestjs/config
 * only loads what `envFilePath` names, and a missing file is not an error.
 */
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: makeValidateEnv(configValidationSchema, { applyParsed: true }),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
