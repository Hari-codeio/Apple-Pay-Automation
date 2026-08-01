import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { DomainVerificationModule } from './domain-verification/domain-verification.module';
import { HealthModule } from './health/health.module';
import { HttpAccessLogMiddleware } from './observability/http-access-log.middleware';
import { ObservabilityModule } from './observability/observability.module';
import { RequestIdMiddleware } from './observability/request-id.middleware';

@Module({
  imports: [
    // First: everything below reads configuration, and a bad env must fail here
    // rather than three modules later.
    ConfigModule,
    // Second: provides AppLogger, which the exception filter and access log both
    // inject. Global, so feature modules do not import it.
    ObservabilityModule,
    HealthModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            // @nestjs/throttler takes ttl in MILLISECONDS. The env var is in
            // seconds because that is how operators think about a rate limit;
            // converting here keeps the mistake out of every configmap.
            ttl: config.getOrThrow<number>('THROTTLE_TTL_SECONDS') * 1000,
            limit: config.getOrThrow<number>('THROTTLE_LIMIT'),
          },
        ],
      }),
    }),
    DatabaseModule,
    DomainVerificationModule,
  ],
  providers: [
    // In-memory per-IP limiting. Single-replica by design (see README), so a
    // shared Redis store would add a dependency without adding correctness.
    // Health and the .well-known route opt out at the controller.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Registered here rather than via app.useGlobalFilters() so Nest injects
    // AppLogger into it; a filter constructed with `new` gets no DI.
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  /**
   * Middleware order is load-bearing:
   *   1. RequestIdMiddleware mints the correlation ID and opens the
   *      AsyncLocalStorage scope. Anything ahead of it logs without an ID.
   *   2. HttpAccessLogMiddleware emits one line per response, reading that ID.
   *
   * Applied to every route including the probes, so any path can be grepped;
   * `/healthz` and `/readyz` drop to debug inside the access log itself.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(RequestIdMiddleware, HttpAccessLogMiddleware)
      .forRoutes('{*splat}');
  }
}
