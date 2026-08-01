import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../observability/app-logger';
import { ApplePortalClient } from '../apple-portal/apple-portal.client';
import { DomainProbeService } from './domain-probe.service';
import { DomainVerificationRepository } from './domain-verification.repository';
import { normalizeDomain } from './domain.util';
import type {
  DomainVerificationRecord,
  ProbeOutcome,
  RegistrationResult,
} from './domain-verification.types';

export interface RegisterDomainInput {
  domain: string;
  storeCode?: number | null;
  /**
   * Register and persist, but do not ask Apple to verify. For the case where the
   * association file has to be deployed by a separate release before Apple can
   * see it.
   */
  skipVerify?: boolean;
}

const RENEWAL_SWEEP_LIMIT = 25;

/**
 * The Apple Pay domain verification flow, end to end:
 *
 *   1. register the domain on the merchant identifier (Apple portal)
 *   2. download the association file Apple generates
 *   3. persist it so the domain can serve it
 *   4. confirm it is actually live at the domain root
 *   5. tell Apple to verify
 *
 * Ordering is not incidental. Apple fetches the file during step 5, so steps 3
 * and 4 must both complete first — and step 4 must check content, not just
 * reachability, or a stale cached copy passes a probe and fails at Apple.
 *
 * A failure at any step leaves a durable record of how far it got (`status`,
 * `last_probe_ok`, `last_verified_at`), because the recovery action differs per
 * step and an operator needs to know which one to take.
 */
@Injectable()
export class DomainVerificationService {
  /**
   * In-flight registrations, keyed by domain. Two concurrent calls for one
   * domain would drive the portal twice and race on the same unique row; the
   * second caller joins the first instead.
   *
   * Deliberately in-process only. A distributed lock would need Redis, and the
   * correct deployment for this service is a single replica driving a single
   * Apple session — see the README.
   */
  private readonly inFlight = new Map<string, Promise<RegistrationResult>>();

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly portal: ApplePortalClient,
    private readonly probes: DomainProbeService,
    private readonly repository: DomainVerificationRepository,
  ) {}

  async register(input: RegisterDomainInput): Promise<RegistrationResult> {
    const domain = normalizeDomain(input.domain);

    const existing = this.inFlight.get(domain);
    if (existing !== undefined) {
      this.logger.emit('info', 'Joining in-flight registration', { domain });
      return existing;
    }

    const run = this.runRegistration(domain, input).finally(() => {
      this.inFlight.delete(domain);
    });
    this.inFlight.set(domain, run);
    return run;
  }

  async findByDomain(rawDomain: string): Promise<DomainVerificationRecord> {
    const domain = normalizeDomain(rawDomain);
    const record = await this.repository.findByDomain(domain);
    if (record === undefined) {
      throw new NotFoundException(`No verification record for '${domain}'`);
    }
    return record;
  }

  /** Probe only. Answers "would Apple be able to verify this right now?". */
  async probe(rawDomain: string): Promise<ProbeOutcome> {
    const record = await this.findByDomain(rawDomain);
    if (record.contentSha256 === null) {
      throw new ConflictException(
        `Record for '${record.domain}' has no content_sha256 to compare against`,
      );
    }
    const outcome = await this.probes.probe(
      record.domain,
      record.contentSha256,
    );
    await this.repository.recordProbe(record.domain, outcome.ok);
    return outcome;
  }

  /**
   * Re-run probe + Apple verification against the file already stored, without
   * re-registering. This is the recovery path when step 5 failed but steps 1–3
   * succeeded — the common case, since it is the step that depends on a deploy
   * landing.
   */
  async reverify(rawDomain: string): Promise<RegistrationResult> {
    const record = await this.findByDomain(rawDomain);
    if (record.contentSha256 === null) {
      throw new ConflictException(
        `Record for '${record.domain}' has no stored association file to verify`,
      );
    }

    const probe = await this.probes.probe(record.domain, record.contentSha256);
    await this.repository.recordProbe(record.domain, probe.ok);
    if (!probe.ok) {
      await this.repository.markStatus(record.domain, 'failed');
      throw new ConflictException(
        `Association file is not live at ${probe.url} (${probe.reason ?? 'unknown'}${
          probe.detail === undefined ? '' : `: ${probe.detail}`
        })`,
      );
    }

    const verification = await this.runAppleVerification(record.domain);
    return {
      domain: record.domain,
      status: verification === 'verified' ? 'active' : 'pending',
      contentSha256: record.contentSha256,
      savedTo: '',
      probe,
      verification,
      verificationExpiresAt: record.verificationExpiresAt ?? '',
    };
  }

  async remove(rawDomain: string): Promise<void> {
    const domain = normalizeDomain(rawDomain);
    const removed = await this.repository.softDelete(domain);
    if (!removed) {
      throw new NotFoundException(
        `No active verification record for '${domain}'`,
      );
    }
    // Apple's own registration is intentionally left in place: removing it there
    // is destructive, not reversible from this codebase, and not what a caller
    // asking us to stop serving a file has asked for.
    this.logger.emit(
      'warn',
      'Verification soft-deleted; Apple-side registration left intact',
      {
        domain,
      },
    );
  }

  /** The file to serve at `/.well-known/...` for this domain. */
  async associationFileFor(rawDomain: string): Promise<string> {
    const domain = normalizeDomain(rawDomain);
    const record = await this.repository.findServable(domain);
    if (record === undefined) {
      throw new NotFoundException(
        `No association file registered for '${domain}'`,
      );
    }
    return record.verificationFile;
  }

  /**
   * Re-verify rows at or past their TTL. Bounded per run: an unbounded sweep
   * would drive the portal dozens of times in a row and is the fastest way to
   * get an Apple account rate-limited.
   */
  async runRenewalSweep(): Promise<{
    considered: number;
    renewed: string[];
    failed: string[];
  }> {
    const due = await this.repository.findExpiringBefore(
      new Date(),
      RENEWAL_SWEEP_LIMIT,
    );
    const renewed: string[] = [];
    const failed: string[] = [];

    // Sequential on purpose. Each iteration launches a browser and drives a
    // shared Apple session; running them concurrently multiplies both the memory
    // footprint and the chance of tripping Apple's rate limits.
    for (const record of due) {
      try {
        await this.register({
          domain: record.domain,
          storeCode: record.storeCode,
        });
        renewed.push(record.domain);
      } catch (error) {
        failed.push(record.domain);
        this.logger.emit('error', 'Renewal failed', {
          domain: record.domain,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.emit('info', 'Renewal sweep complete', {
      considered: due.length,
      renewed: renewed.length,
      failed: failed.length,
    });
    return { considered: due.length, renewed, failed };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async runRegistration(
    domain: string,
    input: RegisterDomainInput,
  ): Promise<RegistrationResult> {
    const merchantId = this.config.getOrThrow<string>('APPLE_MERCHANT_ID');
    const appleTeamId = this.config.getOrThrow<string>('APPLE_TEAM_ID');
    const expiresAt = this.expiryDate();

    this.logger.emit('info', 'Starting domain verification', {
      domain,
      merchantId,
      skipVerify: input.skipVerify === true,
    });

    // 1 + 2: register on the portal and download the association file.
    const file = await this.portal.registerDomain(domain);

    // 3: persist BEFORE any verification attempt. Apple reads the file from the
    // domain, and the domain reads it from this table.
    await this.repository.upsert({
      domain,
      storeCode: input.storeCode ?? null,
      merchantId,
      appleTeamId,
      verificationFile: file.content,
      contentSha256: file.contentSha256,
      status: 'pending',
      verificationExpiresAt: expiresAt,
    });

    const result: RegistrationResult = {
      domain,
      status: 'pending',
      contentSha256: file.contentSha256,
      savedTo: file.savedTo,
      verification: 'not-attempted',
      verificationExpiresAt: expiresAt.toISOString(),
    };

    if (input.skipVerify === true) {
      result.verification = 'skipped';
      this.logger.emit('info', 'Verification skipped at caller request', {
        domain,
      });
      return result;
    }

    // 4: confirm the file is live, unless probing is switched off (which is only
    // sensible when the file is served by infrastructure this service cannot
    // reach, e.g. a private network).
    if (this.config.get<boolean>('DOMAIN_PROBE_ENABLED') ?? true) {
      const probe = await this.probes.probe(domain, file.contentSha256);
      result.probe = probe;
      await this.repository.recordProbe(domain, probe.ok);

      if (!probe.ok) {
        await this.repository.markStatus(domain, 'failed');
        result.status = 'failed';
        // Stop rather than click Verify anyway: a failed Apple verification is
        // rate-limited and its error message would not mention the real cause.
        throw new ConflictException(
          `Association file for '${domain}' is not live at ${probe.url} after ${probe.attempts} attempt(s) ` +
            `(${probe.reason ?? 'unknown'}${probe.detail === undefined ? '' : `: ${probe.detail}`}). ` +
            `The file is stored — deploy it, then POST /domain-verifications/${domain}/reverify`,
        );
      }
    }

    // 5: hand off to Apple.
    result.verification = await this.runAppleVerification(domain);
    result.status = result.verification === 'verified' ? 'active' : 'pending';
    return result;
  }

  private async runAppleVerification(
    domain: string,
  ): Promise<'verified' | 'unknown'> {
    const { outcome } = await this.portal.verifyDomain(domain);
    if (outcome === 'verified') {
      await this.repository.markActive(domain);
      this.logger.emit('info', 'Domain verified by Apple', { domain });
      return 'verified';
    }
    // Left 'pending', not 'failed': Apple gave no verdict, and recording a
    // failure we did not observe would send an operator chasing a fault that may
    // not exist.
    this.logger.emit(
      'warn',
      'Apple returned no explicit verdict; record left pending',
      { domain },
    );
    return 'unknown';
  }

  private expiryDate(): Date {
    const days = this.config.getOrThrow<number>('VERIFICATION_TTL_DAYS');
    return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  }
}
