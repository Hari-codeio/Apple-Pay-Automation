import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../observability/app-logger';
import {
  ApplePortalClient,
  type AssociationFile,
  type VerifyOutcome,
  type VerifyResult,
} from '../apple-portal/apple-portal.client';
import { DomainProbeService } from './domain-probe.service';
import { DomainVerificationRepository } from './domain-verification.repository';
import { normalizeDomain } from './domain.util';
import type {
  DomainVerificationRecord,
  ProbeOutcome,
  RegistrationResult,
  VerificationStatus,
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
      status: statusForOutcome(verification.outcome),
      contentSha256: record.contentSha256,
      savedTo: '',
      probe,
      verification: verification.outcome,
      // Prefer what the portal just published; fall back to the stored value,
      // which markActive leaves intact when the scrape could not read a date.
      verificationExpiresAt:
        verification.verificationExpiresAt?.toISOString() ??
        record.verificationExpiresAt,
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

    this.logger.emit('info', 'Starting domain verification', {
      domain,
      merchantId,
      skipVerify: input.skipVerify === true,
    });

    // Persist BEFORE Apple is asked to look. Apple reads the file from the
    // domain, and the domain reads it from this table.
    const persist = (file: AssociationFile): Promise<void> =>
      this.repository.upsert({
        domain,
        storeCode: input.storeCode ?? null,
        merchantId,
        appleTeamId,
        verificationFile: file.content,
        contentSha256: file.contentSha256,
        status: 'pending',
        // Apple publishes an expiry only once it has verified, so there is
        // nothing to record here. The real date is read straight after Verify.
        verificationExpiresAt: null,
      });

    // Register-only. No Verify click, so the session need not stay open.
    if (input.skipVerify === true) {
      const file = await this.portal.registerDomain(domain);
      await persist(file);
      this.logger.emit('info', 'Verification skipped at caller request', {
        domain,
      });
      return {
        domain,
        status: 'pending',
        contentSha256: file.contentSha256,
        savedTo: file.savedTo,
        verification: 'skipped',
        verificationExpiresAt: null,
      };
    }

    // Register → store → probe → Verify, all in ONE browser session. The Verify
    // control for this registration exists only on the confirmation screen Save
    // renders; close the browser in between and it is gone, leaving the per-row
    // buttons on the merchant list where choosing correctly among ~46 rows is a
    // guess. The probe runs inside the callback, after the row is written and
    // before the click, so a file Apple cannot fetch costs no rate-limited
    // attempt.
    let probe: ProbeOutcome | undefined;
    const { file, verification } = await this.portal.registerAndVerify(
      domain,
      async (downloaded) => {
        await persist(downloaded);
        probe = await this.probeBeforeVerify(domain, downloaded.contentSha256);
      },
    );

    await this.recordVerification(domain, verification);

    return {
      domain,
      status: statusForOutcome(verification.outcome),
      contentSha256: file.contentSha256,
      savedTo: file.savedTo,
      probe,
      verification: verification.outcome,
      verificationExpiresAt:
        verification.verificationExpiresAt?.toISOString() ?? null,
    };
  }

  /**
   * Confirm Apple will actually find the file, before spending a click on a
   * rate-limited check whose error message would not name the real cause.
   *
   * Returns undefined when probing is switched off — sensible only when the file
   * is served by infrastructure this service cannot reach.
   */
  private async probeBeforeVerify(
    domain: string,
    contentSha256: string,
  ): Promise<ProbeOutcome | undefined> {
    if ((this.config.get<boolean>('DOMAIN_PROBE_ENABLED') ?? true) === false) {
      return undefined;
    }

    const probe = await this.probes.probe(domain, contentSha256);
    await this.repository.recordProbe(domain, probe.ok);
    if (probe.ok) return probe;

    await this.repository.markStatus(domain, 'failed');
    throw new ConflictException(
      `Association file for '${domain}' is not live at ${probe.url} after ${probe.attempts} attempt(s) ` +
        `(${probe.reason ?? 'unknown'}${probe.detail === undefined ? '' : `: ${probe.detail}`}). ` +
        `The file is stored — deploy it, then POST /domain-verifications/${domain}/reverify`,
    );
  }

  /**
   * Reverify path: click Verify from the merchant list, then record the verdict.
   *
   * The expiry is only knowable at this point. Apple issues it when it verifies
   * the domain and shows it only on the merchant list, so there is nothing to
   * record at registration time.
   */
  private async runAppleVerification(domain: string): Promise<VerifyResult> {
    const verification = await this.portal.verifyDomain(domain);
    await this.recordVerification(domain, verification);
    return verification;
  }

  /**
   * Write Apple's verdict to the row. Shared by both entry points so the register
   * and reverify paths cannot drift on what a verdict means.
   */
  private async recordVerification(
    domain: string,
    verification: VerifyResult,
  ): Promise<void> {
    if (verification.outcome === 'verified') {
      await this.repository.markActive(
        domain,
        verification.verificationExpiresAt,
      );
      this.logger.emit('info', 'Domain verified by Apple', {
        domain,
        verificationExpiresAt:
          verification.verificationExpiresAt?.toISOString() ?? null,
      });
      if (verification.verificationExpiresAt === null) {
        // Not fatal — the domain IS verified and serving. But nothing now knows
        // when Apple stops trusting it, so it must not pass unremarked.
        this.logger.emit(
          'error',
          'Verified without a usable expiry date; renewal cannot be scheduled from this row',
          { domain },
        );
      }
      return;
    }

    if (verification.outcome === 'failed') {
      // 'failed', not 'pending': Apple named the reason in its own words, so
      // recording it as merely unfinished would hide a verdict we actually have.
      await this.repository.markStatus(domain, 'failed');
      this.logger.emit('error', 'Apple rejected the domain verification', {
        domain,
        portalMessage: verification.portalMessage ?? null,
      });
      return;
    }

    // Left 'pending', not 'failed': Apple gave no verdict, and recording a
    // failure we did not observe would send an operator chasing a fault that may
    // not exist.
    this.logger.emit(
      'warn',
      'Apple returned no explicit verdict; record left pending',
      { domain },
    );
  }
}

/** Row status implied by Apple's verdict. */
function statusForOutcome(outcome: VerifyOutcome): VerificationStatus {
  if (outcome === 'verified') return 'active';
  if (outcome === 'failed') return 'failed';
  return 'pending';
}
