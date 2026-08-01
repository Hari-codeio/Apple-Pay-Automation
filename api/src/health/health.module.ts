import { Global, Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { ReadinessRegistry } from './readiness-registry';

/**
 * Global so any module that owns a connection can inject `ReadinessRegistry`
 * and register its own probe without HealthModule having to import it — the
 * dependency points the right way round.
 */
@Global()
@Module({
  controllers: [HealthController],
  providers: [ReadinessRegistry],
  exports: [ReadinessRegistry],
})
export class HealthModule {}
