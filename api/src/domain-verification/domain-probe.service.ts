import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DOMAIN_ASSOCIATION_PATH } from '../common/constants';
import { AppLogger } from '../observability/app-logger';
import { associationFileUrl } from './domain.util';
import type { ProbeOutcome } from './domain-verification.types';

/**
 * Confirms the association file is actually live on the domain before Apple is
 * asked to look for it.
 *
 * This step exists because the failure it prevents is expensive to diagnose:
 * clicking Verify against a file that is not yet served produces a portal-side
 * error that says nothing about propagation, caching, or a missed deploy. Probing
 * first turns "Apple rejected the domain" into "the file returned 404 after 5
 * attempts", which points straight at the cause.
 *
 * The comparison is on SHA-256 of the bytes, not on "did something respond".
 * A CDN serving a stale copy of a previous association file returns 200 with the
 * wrong content, and Apple would reject it.
 */
@Injectable()
export class DomainProbeService {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
  ) {}

  async probe(domain: string, expectedSha256: string): Promise<ProbeOutcome> {
    const url = associationFileUrl(domain, DOMAIN_ASSOCIATION_PATH);
    const attempts = this.config.getOrThrow<number>('DOMAIN_PROBE_ATTEMPTS');
    const delayMs = this.config.getOrThrow<number>('DOMAIN_PROBE_DELAY_MS');
    const timeoutMs = this.config.getOrThrow<number>('DOMAIN_PROBE_TIMEOUT_MS');

    let last: ProbeOutcome = { ok: false, attempts: 0, url };

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const outcome = await this.attempt(url, expectedSha256, timeoutMs);
      // `attempts` from a single attempt is always 1; overwrite it with the
      // running count so the caller sees how many tries it actually took.
      last = { ...outcome, attempts: attempt };

      if (last.ok) {
        this.logger.emit('info', 'Association file is live on domain', {
          domain,
          url,
          attempt,
        });
        return last;
      }

      this.logger.emit('warn', 'Association file probe failed', {
        domain,
        url,
        attempt,
        reason: last.reason,
        httpStatus: last.httpStatus,
        detail: last.detail,
      });

      // No sleep after the final attempt — it delays the caller's error for
      // nothing.
      if (attempt < attempts && delayMs > 0) await sleep(delayMs);
    }

    return last;
  }

  private async attempt(
    url: string,
    expectedSha256: string,
    timeoutMs: number,
  ): Promise<ProbeOutcome> {
    try {
      const response = await fetch(url, {
        method: 'GET',
        // Apple fetches this exact path and does not follow redirects, so a 3xx
        // here is a real misconfiguration to report, not something to chase.
        redirect: 'manual',
        headers: { accept: '*/*' },
        signal: AbortSignal.timeout(timeoutMs),
        // A cached copy proves nothing about what Apple will be served.
        cache: 'no-store',
      });

      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          attempts: 1,
          url,
          httpStatus: response.status,
          reason: 'redirect',
          detail: `redirects to ${response.headers.get('location') ?? 'unknown'}; Apple does not follow redirects for this path`,
        };
      }
      if (!response.ok) {
        return {
          ok: false,
          attempts: 1,
          url,
          httpStatus: response.status,
          reason: 'http-error',
        };
      }

      const body = await response.text();
      const actual = createHash('sha256').update(body).digest('hex');
      if (actual !== expectedSha256) {
        return {
          ok: false,
          attempts: 1,
          url,
          httpStatus: response.status,
          reason: 'content-mismatch',
          detail: `served sha256 ${actual.slice(0, 12)}… does not match downloaded ${expectedSha256.slice(0, 12)}…`,
        };
      }

      return { ok: true, attempts: 1, url, httpStatus: response.status };
    } catch (error) {
      return {
        ok: false,
        attempts: 1,
        url,
        reason: 'unreachable',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}
