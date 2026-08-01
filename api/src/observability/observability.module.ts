import { Global, Module } from '@nestjs/common';
import { AppLogger, resolveLoggerOptions } from './app-logger';
import { HttpAccessLogMiddleware } from './http-access-log.middleware';
import { RequestIdMiddleware } from './request-id.middleware';

/**
 * Global so any module can inject `AppLogger` without importing this one — a
 * logger that has to be plumbed through module imports is a logger people stop
 * using.
 *
 * `AppLogger` is a factory provider because its only constructor argument is a
 * plain options interface, which carries no DI token. Options come from env
 * rather than `ConfigService` so the bootstrap logger and the injected one are
 * built from identical inputs.
 */
@Global()
@Module({
  providers: [
    {
      provide: AppLogger,
      useFactory: () => new AppLogger(resolveLoggerOptions()),
    },
    RequestIdMiddleware,
    HttpAccessLogMiddleware,
  ],
  exports: [AppLogger, RequestIdMiddleware, HttpAccessLogMiddleware],
})
export class ObservabilityModule {}
