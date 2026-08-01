import { Module } from '@nestjs/common';
import { ApplePortalModule } from '../apple-portal/apple-portal.module';
import { ConfigModule } from '../config/config.module';
import { ObservabilityModule } from '../observability/observability.module';

/**
 * Minimal container for the assisted-login CLI: config, logging, and the browser.
 *
 * Deliberately excludes the database. Re-authenticating with Apple is the thing
 * an operator does when something is already broken, and it must not require a
 * reachable MySQL cluster to succeed.
 */
@Module({
  imports: [ConfigModule, ObservabilityModule, ApplePortalModule],
})
export class CliModule {}
