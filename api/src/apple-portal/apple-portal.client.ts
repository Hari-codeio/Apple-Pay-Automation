import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Locator, Page } from 'playwright';
import { AppLogger } from '../observability/app-logger';
import { BrowserFactory, type BrowserSession } from './browser.factory';
import {
  AppleSessionExpiredError,
  PortalElementNotFoundError,
  PortalRejectedError,
} from './apple-portal.errors';
import {
  MERCHANT_FALLBACK_SELECTORS,
  MERCHANT_FORM_SELECTOR,
  MERCHANT_SELECTORS,
  SIGN_IN_URL_MARKERS,
} from './selectors';

/** The association file Apple expects to be served from the domain's root. */
export interface AssociationFile {
  /** Apple's suggested filename, e.g. apple-developer-merchantid-domain-association2. */
  suggestedFilename: string;
  /** File contents verbatim. Served byte-for-byte or Apple's check fails. */
  content: string;
  contentSha256: string;
  /** Where the download was saved, for post-mortem inspection. */
  savedTo: string;
}

export type VerifyOutcome = 'verified' | 'unknown';

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Any message the portal surfaced, for the audit trail. */
  portalMessage?: string;
}

/**
 * Selectors used to detect a portal-side error after an action. Apple has used
 * several over time and shows no version guarantees, so all are checked.
 */
const ERROR_BANNER_SELECTORS = [
  '.alert-error',
  '.form-error',
  '[role="alert"]',
  '.error-message',
];

/** Association files are a long opaque token; anything short is not the file. */
const MIN_ASSOCIATION_FILE_LENGTH = 100;

/**
 * Drives the Apple Developer portal's Apple Pay merchant identifier page.
 *
 * Every operation opens its own browser, acts, and closes. Verification happens
 * minutes after registration (the association file has to become live on the
 * domain in between), and holding a browser and an Apple session open across
 * that gap is both fragile and a resource leak.
 */
@Injectable()
export class ApplePortalClient {
  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly browsers: BrowserFactory,
  ) {}

  /** The merchant identifier edit page for the configured team + merchant. */
  merchantEditUrl(): string {
    const base = this.config
      .getOrThrow<string>('APPLE_PORTAL_BASE_URL')
      .replace(/\/+$/, '');
    const teamId = this.config.getOrThrow<string>('APPLE_TEAM_ID');
    const merchantId = this.config.getOrThrow<string>('APPLE_MERCHANT_ID');
    return `${base}/account/resources/identifiers/merchant/edit/${teamId}/${merchantId}`;
  }

  /**
   * Register `domain` on the merchant identifier and download the association
   * file Apple generates for it.
   *
   * Idempotent in effect: when the domain is already registered, the Add Domain
   * step is skipped and the existing file is downloaded, so a retried run does
   * not fail on "domain already exists".
   */
  async registerDomain(domain: string): Promise<AssociationFile> {
    return this.withMerchantPage(`register-${domain}`, async (page) => {
      // The association file is downloadable ONLY on the confirmation screen that
      // Save renders — never from the domain list (see selectors.ts). So an
      // already-registered domain cannot yield the file, and pretending otherwise
      // is what previously sent this code hunting for a control that was not on
      // the page. Say so instead.
      if (await this.isDomainListed(page, domain)) {
        throw new PortalRejectedError(
          'add-domain',
          `'${domain}' is already registered on this merchant identifier. Apple only offers ` +
            `the association file on the confirmation screen shown right after a domain is ` +
            `added, so it cannot be re-downloaded for an existing registration. Either use ` +
            `the file already stored for this domain (POST /domain-verifications/${domain}/reverify), ` +
            `or Remove the domain in the portal and register it again.`,
        );
      }

      await this.click(page, 'add-domain', MERCHANT_SELECTORS.addDomain, {
        fallback: MERCHANT_FALLBACK_SELECTORS.addDomain,
      });

      const input = await this.locate(page, 'domain-input', {
        structural: MERCHANT_SELECTORS.domainInput,
        fallback: MERCHANT_FALLBACK_SELECTORS.domainInput,
      });
      await input.fill(domain);

      await this.click(page, 'save-domain', MERCHANT_SELECTORS.save, {
        fallback: MERCHANT_FALLBACK_SELECTORS.save,
      });
      await this.assertNoPortalError(page, 'save-domain');

      // Wait for the confirmation screen before looking for its Download control.
      // Without this the lookup runs against the pre-Save DOM, finds nothing, and
      // falls through to a fallback selector — which is exactly how a hidden
      // global-nav link got clicked for 20 seconds.
      await page
        .locator(MERCHANT_SELECTORS.download)
        .first()
        .waitFor({
          state: 'visible',
          timeout: this.config.getOrThrow<number>(
            'PLAYWRIGHT_ACTION_TIMEOUT_MS',
          ),
        });

      return this.downloadAssociationFile(page, domain);
    });
  }

  /**
   * Ask Apple to fetch the association file from the domain and mark it
   * verified. The file must already be live — call this only after the probe
   * confirms it.
   */
  async verifyDomain(domain: string): Promise<VerifyResult> {
    return this.withMerchantPage(`verify-${domain}`, async (page) => {
      await this.click(page, 'verify-domain', MERCHANT_SELECTORS.verify, {
        fallback: MERCHANT_FALLBACK_SELECTORS.verify,
        domain,
      });

      await this.assertNoPortalError(page, 'verify-domain');

      // The portal gives no machine-readable success signal, so wait for it to
      // settle and then look for the domain being reported as verified. When
      // neither a success marker nor an error appears, report 'unknown' rather
      // than claiming success — a false "verified" in the audit trail is worse
      // than an honest "check the portal".
      await page
        .waitForLoadState('networkidle', {
          timeout: this.config.getOrThrow<number>('PLAYWRIGHT_NAV_TIMEOUT_MS'),
        })
        .catch(() => undefined);

      const verifiedMarker = page
        .locator('section')
        .filter({ hasText: domain })
        .filter({ hasText: /verified/i });

      if ((await verifiedMarker.count()) > 0) {
        return { outcome: 'verified' as const };
      }

      this.logger.emit(
        'warn',
        'Portal showed no explicit verification result; reporting unknown',
        { domain },
      );
      return { outcome: 'unknown' as const };
    });
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async withMerchantPage<T>(
    label: string,
    fn: (page: Page) => Promise<T>,
  ): Promise<T> {
    const session: BrowserSession = await this.browsers.open();
    try {
      const { page } = session;
      await page.goto(this.merchantEditUrl(), {
        waitUntil: 'domcontentloaded',
      });
      this.assertAuthenticated(page);
      await page.waitForSelector(MERCHANT_FORM_SELECTOR);

      const result = await fn(page);
      await session.close();
      return result;
    } catch (error) {
      // Save the trace on the way out: it is the only record of a DOM we do not
      // control at the moment it stopped matching our selectors.
      await session.close(label);
      throw error;
    }
  }

  /**
   * An expired Apple session is a redirect, not a 401 — the only signal is the
   * URL we landed on.
   */
  private assertAuthenticated(page: Page): void {
    const url = page.url();
    if (SIGN_IN_URL_MARKERS.some((marker) => url.includes(marker))) {
      throw new AppleSessionExpiredError(url);
    }
  }

  private async isDomainListed(page: Page, domain: string): Promise<boolean> {
    const listed = page.locator(`text=${domain}`);
    return (await listed.count()) > 0;
  }

  private async downloadAssociationFile(
    page: Page,
    domain: string,
  ): Promise<AssociationFile> {
    const link = await this.locate(page, 'download-association-file', {
      structural: MERCHANT_SELECTORS.download,
      fallback: MERCHANT_FALLBACK_SELECTORS.download,
      domain,
    });

    // Playwright captures the download itself, so this never depends on an OS
    // Downloads folder or on guessing the filename Apple appended a number to.
    const [download] = await Promise.all([
      page.waitForEvent('download', {
        timeout: this.config.getOrThrow<number>('PLAYWRIGHT_NAV_TIMEOUT_MS'),
      }),
      link.click(),
    ]);

    const dir = resolve(
      process.cwd(),
      this.config.getOrThrow<string>('PLAYWRIGHT_DOWNLOAD_DIR'),
    );
    await mkdir(dir, { recursive: true });

    const suggestedFilename = download.suggestedFilename();
    const savedTo = join(
      dir,
      `${domain.replace(/[^A-Za-z0-9.-]+/g, '_')}-${Date.now()}-${suggestedFilename}`,
    );
    await download.saveAs(savedTo);

    const content = await readFile(savedTo, 'utf8');
    this.assertLooksLikeAssociationFile(content, suggestedFilename);

    const contentSha256 = createHash('sha256').update(content).digest('hex');
    this.logger.emit('info', 'Association file downloaded', {
      domain,
      suggestedFilename,
      bytes: Buffer.byteLength(content, 'utf8'),
      contentSha256,
    });

    return { suggestedFilename, content, contentSha256, savedTo };
  }

  /**
   * A portal error page or an expired-session redirect can arrive as a
   * "successful" download. Writing that into the table would leave the domain
   * serving an HTML error page as its association file, and Apple's verify would
   * fail for a reason that points nowhere near the cause.
   */
  private assertLooksLikeAssociationFile(
    content: string,
    filename: string,
  ): void {
    const trimmed = content.trim();
    if (trimmed.length < MIN_ASSOCIATION_FILE_LENGTH) {
      throw new PortalRejectedError(
        'download-association-file',
        `downloaded '${filename}' is only ${trimmed.length} bytes — not an association file`,
      );
    }
    if (/^\s*<(?:!doctype|html)/i.test(trimmed)) {
      throw new PortalRejectedError(
        'download-association-file',
        `downloaded '${filename}' is an HTML document, not an association file`,
      );
    }
  }

  /**
   * Resolve a control, most-specific strategy first:
   *   1. scoped to the section mentioning this domain — the only correct choice
   *      once more than one domain is registered, because the structural
   *      selector matches every row;
   *   2. the structural selector captured from the portal;
   *   3. an accessible-name fallback.
   */
  private async locate(
    page: Page,
    step: string,
    selectors: { structural: string; fallback: string; domain?: string },
  ): Promise<Locator> {
    if (selectors.domain !== undefined) {
      const scoped = await this.locateInDomainSection(
        page,
        selectors.domain,
        selectors.fallback,
      );
      if (scoped !== undefined) return scoped;
    }

    for (const selector of [selectors.structural, selectors.fallback]) {
      const locator = page.locator(selector);
      if ((await locator.count()) > 0) return locator.first();
    }

    throw new PortalElementNotFoundError(step, [
      selectors.structural,
      selectors.fallback,
    ]);
  }

  private async locateInDomainSection(
    page: Page,
    domain: string,
    relativeSelector: string,
  ): Promise<Locator | undefined> {
    const section = page.locator('section').filter({ hasText: domain });
    if ((await section.count()) !== 1) return undefined;
    const target = section.locator(relativeSelector);
    return (await target.count()) === 1 ? target : undefined;
  }

  private async click(
    page: Page,
    step: string,
    structural: string,
    options: { fallback: string; domain?: string },
  ): Promise<void> {
    const locator = await this.locate(page, step, {
      structural,
      fallback: options.fallback,
      domain: options.domain,
    });
    await locator.click();
  }

  /** Surface a portal-side rejection as an error instead of silently continuing. */
  private async assertNoPortalError(page: Page, step: string): Promise<void> {
    for (const selector of ERROR_BANNER_SELECTORS) {
      const banner = page.locator(selector);
      if ((await banner.count()) === 0) continue;
      const text = (
        await banner
          .first()
          .innerText()
          .catch(() => '')
      ).trim();
      if (text.length > 0) throw new PortalRejectedError(step, text);
    }
  }
}
