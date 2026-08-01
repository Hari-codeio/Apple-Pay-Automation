import { Module } from '@nestjs/common';
import { ApplePortalModule } from '../apple-portal/apple-portal.module';
import { DatabaseModule } from '../database/database.module';
import { DomainProbeService } from './domain-probe.service';
import { DomainVerificationController } from './domain-verification.controller';
import { DomainVerificationRepository } from './domain-verification.repository';
import { DomainVerificationService } from './domain-verification.service';
import { RenewalScheduler } from './renewal.scheduler';
import { WellKnownController } from './well-known.controller';

@Module({
  imports: [ApplePortalModule, DatabaseModule],
  controllers: [DomainVerificationController, WellKnownController],
  providers: [
    DomainProbeService,
    DomainVerificationRepository,
    DomainVerificationService,
    RenewalScheduler,
  ],
  exports: [DomainVerificationService],
})
export class DomainVerificationModule {}
