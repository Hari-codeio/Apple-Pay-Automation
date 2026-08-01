# @apple-pay/config-validation

One env-validation mechanism for the whole workspace: a runtime-agnostic core
plus a NestJS `ConfigModule` adapter.

## Why

A service that boots with an invalid env is a service that fails later — at the
first request that touches the bad value. For a payment-verification flow that
means a 500 mid-transaction instead of a container that never accepts traffic.
So validation runs **once, at boot, fail-fast**, and the failure message names
every offending variable.

## NestJS usage

```ts
// api/src/config/config.module.ts
import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { makeValidateEnv } from '@apple-pay/config-validation';
import { configValidationSchema } from './validation-schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      validate: makeValidateEnv(configValidationSchema, { applyParsed: true }),
    }),
  ],
  exports: [NestConfigModule],
})
export class ConfigModule {}
```

`applyParsed: true` merges the schema's defaults and coercions over
`process.env`, so `ConfigService.get<number>('PORT')` returns a real number
rather than the string the OS handed the process.

## Plain Node usage

```ts
import { parseEnv } from '@apple-pay/config-validation';

const config = parseEnv(schema, process.env); // typed; throws on failure
```

## Escape hatch

`CONFIG_VALIDATION_LOG_ONLY=true` downgrades a hard boot failure to a warning.
It exists to unblock an operator mid-incident. Anything other than the exact
string `true` leaves the gate fail-fast.

## Two things to know

1. **Failure messages carry names, never values.** A malformed secret must not
   reach a log aggregator, so only the variable name and the validation message
   are emitted.
2. **`ConfigService` snapshot.** Registering any `validate` fn makes
   `@nestjs/config` cache a validated env snapshot that `ConfigService.get()`
   reads _before_ live `process.env`. A test that mutates `process.env.X` after
   the module compiles will not see the change — set env before compiling the
   testing module.
