import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
// `cron` is pinned in package.json to the exact version @nestjs/schedule depends
// on, so SchedulerRegistry and this file share one CronJob class. Two copies
// would fail addCronJob's instance check.
import { CronJob } from 'cron';
import { AppLogger } from '../observability/app-logger';
import { DomainVerificationService } from './domain-verification.service';

const JOB_NAME = 'apple-pay-domain-renewal';

/**
 * Periodic re-verification of domains at or past their TTL.
 *
 * Registered imperatively rather than with `@Cron`, because a decorator fires on
 * every replica that loads the module. This job drives a shared Apple session and
 * a single browser; two replicas running it concurrently would race on the same
 * portal state. `CRON_ENABLED` therefore defaults to OFF and belongs on exactly
 * one instance.
 */
@Injectable()
export class RenewalScheduler implements OnModuleInit {
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly service: DomainVerificationService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<boolean>('CRON_ENABLED') !== true) {
      this.logger.emit(
        'info',
        'Renewal cron disabled (CRON_ENABLED is not true)',
      );
      return;
    }

    const expression = this.config.getOrThrow<string>('RENEWAL_CRON');
    const job = new CronJob(expression, () => {
      void this.run();
    });

    this.schedulerRegistry.addCronJob(JOB_NAME, job);
    job.start();
    this.logger.emit('info', 'Renewal cron scheduled', { expression });
  }

  /**
   * Overlap guard: a sweep drives the portal once per due domain and can outrun
   * its own interval. A second concurrent sweep would re-register domains the
   * first is still working through.
   */
  private async run(): Promise<void> {
    if (this.running) {
      this.logger.emit(
        'warn',
        'Renewal sweep still running; skipping this tick',
      );
      return;
    }
    this.running = true;
    try {
      await this.service.runRenewalSweep();
    } catch (error) {
      // A throw out of a cron callback is an unhandled rejection, which the
      // process-level handler turns into a shutdown. Contain it here.
      this.logger.emit('error', 'Renewal sweep threw', {
        reason: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.running = false;
    }
  }
}
