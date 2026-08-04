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
  MERCHANT_DOMAIN_LIST_SELECTORS,
  MERCHANT_DOMAIN_LIST_STRUCTURAL_SELECTORS,
  MERCHANT_FALLBACK_SELECTORS,
  MERCHANT_FORM_SELECTOR,
  MERCHANT_SELECTORS,
  PORTAL_MODAL_SELECTORS,
  SIGN_IN_URL_MARKERS,
  VERIFICATION_FAILURE_MARKERS,
} from './selectors';
import {
  isVerifiedStatus,
  parseAppleExpiryDate,
  toDomainRow,
  type MerchantDomainRow,
} from './merchant-domain-list';

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

/**
 * `failed` is distinct from `unknown` on purpose. `unknown` means Apple gave no
 * verdict and someone has to look; `failed` means Apple explicitly said no, in a
 * modal we read. Collapsing the two would send an operator hunting for a fault
 * the portal already named.
 */
export type VerifyOutcome = 'verified' | 'failed' | 'unknown';

export interface VerifyResult {
  outcome: VerifyOutcome;
  /** Any message the portal surfaced, for the audit trail. */
  portalMessage?: string;
  /**
   * Apple's own `Verification Expires` date for this domain, read from the
   * merchant list after verification.
   *
   * Null when the portal published no date, or published one this code could not
   * parse. Never a computed guess — see merchant-domain-list.ts.
   */
  verificationExpiresAt: Date | null;
}

/** Everything one register-then-verify session produced. */
export interface RegisterAndVerifyResult {
  file: AssociationFile;
  verification: VerifyResult;
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
   * NOT idempotent, and deliberately so: a domain Apple already lists is rejected
   * up front by `addDomainAndDownload`. Apple renders the association file only on
   * the confirmation screen shown right after an add, so there is nothing to
   * re-download for an existing registration — pretending otherwise is what once
   * sent this code hunting for a control that was not on the page. The recovery
   * path is `reverify`, against the file already stored.
   */
  async registerDomain(domain: string): Promise<AssociationFile> {
    return this.withMerchantPage(`register-${domain}`, (page) =>
      this.addDomainAndDownload(page, domain),
    );
  }

  /**
   * The whole flow in ONE browser session: Add Domain → Save → Download →
   * `persist` → Verify → read Apple's expiry.
   *
   * It has to be one session. The Verify control that belongs to this
   * registration lives on the confirmation screen Save renders, alongside the
   * Download link — close the browser after downloading and it is gone, leaving
   * only the per-row Verify buttons on the merchant list, where picking the right
   * one among ~46 rows is a guess this code should not have to make.
   *
   * `persist` runs after the download and BEFORE Verify, and that ordering is the
   * point: clicking Verify makes Apple fetch the file from the domain, and in this
   * deployment the stored row is what makes it servable. Verifying first would ask
   * Apple to fetch something that does not exist yet.
   */
  async registerAndVerify(
    domain: string,
    persist: (file: AssociationFile) => Promise<void>,
  ): Promise<RegisterAndVerifyResult> {
    return this.withMerchantPage(`register-verify-${domain}`, async (page) => {
      const file = await this.addDomainAndDownload(page, domain);
      await persist(file);
      const verification = await this.clickVerifyAndRead(page, domain, {
        scopeToDomainRow: false,
      });
      return { file, verification };
    });
  }

  /** Add Domain → Save → wait for the confirmation screen → download the file. */
  private async addDomainAndDownload(
    page: Page,
    domain: string,
  ): Promise<AssociationFile> {
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
    await this.enterDomain(input, domain);

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
        timeout: this.config.getOrThrow<number>('PLAYWRIGHT_ACTION_TIMEOUT_MS'),
      });

    return this.downloadAssociationFile(page, domain);
  }

  /**
   * Ask Apple to fetch the association file from the domain and mark it
   * verified. The file must already be live — call this only after the probe
   * confirms it.
   */
  async verifyDomain(domain: string): Promise<VerifyResult> {
    return this.withMerchantPage(`verify-${domain}`, (page) =>
      // From the list, the Verify button must be the one inside THIS domain's
      // row — see clickVerifyAndRead.
      this.clickVerifyAndRead(page, domain, { scopeToDomainRow: true }),
    );
  }

  /**
   * Click Verify, then work out what Apple said.
   *
   * Two shapes of answer, and the wait races them:
   *   - a modal (`role="dialog"`) carrying an explicit failure message, or
   *   - a return to the merchant list, where the row now reads `verified` and
   *     carries the `Verification Expires` date.
   *
   * `scopeToDomainRow` distinguishes the two entry points, and they differ by one
   * hop. After Save the browser is already ON the domain's Verify screen, so the
   * single Verify button there is the one to press. From the merchant list it
   * takes two clicks: the row's Verify only OPENS that domain's Verify screen —
   * it does not run the check. Pressing it and then looking for a verdict is a
   * 50-second wait for a result that never arrives, which is exactly what the
   * first live run did (`listedDomains: 0`, because the list is no longer on
   * screen). Scoping that first click to the matching block is still mandatory:
   * every row has one, and the wrong one aims Apple's rate-limited check at an
   * unrelated domain.
   */
  private async clickVerifyAndRead(
    page: Page,
    domain: string,
    options: { scopeToDomainRow: boolean },
  ): Promise<VerifyResult> {
    const target = domain.toLowerCase();

    if (options.scopeToDomainRow) {
      const block = await this.findDomainBlock(page, target);
      if (block === undefined) {
        throw new PortalElementNotFoundError('verify-domain', [
          `${MERCHANT_DOMAIN_LIST_SELECTORS.block} matching '${domain}'`,
        ]);
      }
      await block.locator(MERCHANT_DOMAIN_LIST_SELECTORS.verifyButton).click();
      await this.waitForVerifyScreen(page, domain);
    }

    // Both paths converge here, on the domain's own Verify screen.
    await this.click(page, 'verify-domain', MERCHANT_SELECTORS.verify, {
      fallback: MERCHANT_FALLBACK_SELECTORS.verify,
    });

    await this.assertNoPortalError(page, 'verify-domain');

    const timeout = this.config.getOrThrow<number>('PLAYWRIGHT_NAV_TIMEOUT_MS');
    const modal = page.locator(PORTAL_MODAL_SELECTORS.container).first();
    const listed = page.locator(MERCHANT_DOMAIN_LIST_SELECTORS.block).first();

    // Whichever lands first ends the wait. Both are allowed to time out: the
    // fall-through below reports 'unknown', which is the honest answer when the
    // portal showed neither outcome.
    await Promise.race([
      modal.waitFor({ state: 'visible', timeout }).catch(() => undefined),
      listed.waitFor({ state: 'visible', timeout }).catch(() => undefined),
    ]);

    const failure = await this.readFailureModal(page);
    if (failure !== undefined) {
      this.logger.emit('error', 'Apple rejected the domain verification', {
        domain,
        portalMessage: failure,
      });
      await this.dismissModal(page);
      return {
        outcome: 'failed',
        portalMessage: failure,
        verificationExpiresAt: null,
      };
    }

    await page
      .waitForLoadState('networkidle', { timeout })
      .catch(() => undefined);

    const rows = await this.readDomainRows(page);
    const row = rows.find((candidate) => candidate.domain === target);

    if (row !== undefined) {
      if (!isVerifiedStatus(row.status)) {
        this.logger.emit('warn', 'Portal lists domain as not verified', {
          domain,
          status: row.status,
        });
        return { outcome: 'unknown', verificationExpiresAt: null };
      }
      return {
        outcome: 'verified',
        verificationExpiresAt: this.readExpiry(domain, row),
      };
    }

    // The list did not parse at all — Apple changed the DOM. Fall back to the
    // looser whole-section match so a selector drift downgrades the expiry date
    // rather than silently reporting an actually-verified domain as unknown.
    if (rows.length === 0) {
      const verifiedMarker = page
        .locator('section')
        .filter({ hasText: domain })
        .filter({ hasText: /verified/i });

      if ((await verifiedMarker.count()) > 0) {
        this.logger.emit(
          'error',
          'Merchant domain list did not parse; verified via fallback marker and expiry is unavailable',
          { domain, blockSelector: MERCHANT_DOMAIN_LIST_SELECTORS.block },
        );
        return { outcome: 'verified', verificationExpiresAt: null };
      }
    }

    this.logger.emit(
      'warn',
      'Portal showed no explicit verification result; reporting unknown',
      { domain, listedDomains: rows.length },
    );
    return { outcome: 'unknown', verificationExpiresAt: null };
  }

  /**
   * Block until the domain's Verify screen has rendered.
   *
   * Keyed on the Download link, which exists only on that screen — the merchant
   * list has Remove/Verify per row and no download anywhere. Waiting on it is
   * what stops the next click from running against the list DOM.
   */
  private async waitForVerifyScreen(page: Page, domain: string): Promise<void> {
    try {
      await page
        .locator(MERCHANT_SELECTORS.download)
        .first()
        .waitFor({
          state: 'visible',
          timeout: this.config.getOrThrow<number>(
            'PLAYWRIGHT_ACTION_TIMEOUT_MS',
          ),
        });
    } catch {
      throw new PortalElementNotFoundError(`verify-screen-${domain}`, [
        MERCHANT_SELECTORS.download,
      ]);
    }
  }

  /**
   * The modal's message when it is reporting a failure, else undefined.
   *
   * The container class is generic — Apple uses the same modal for neutral
   * information — so presence alone proves nothing. Only a message matching a
   * known failure phrase counts, which means an unrecognised modal falls through
   * to the list check rather than being misreported as a rejection.
   */
  private async readFailureModal(page: Page): Promise<string | undefined> {
    const modal = page.locator(PORTAL_MODAL_SELECTORS.container).first();
    if ((await modal.count()) === 0 || !(await modal.isVisible())) {
      return undefined;
    }

    const text = (
      (await page
        .locator(PORTAL_MODAL_SELECTORS.message)
        .first()
        .textContent()
        .catch(() => null)) ??
      (await modal.textContent().catch(() => null)) ??
      ''
    ).trim();

    if (text === '') return undefined;
    return VERIFICATION_FAILURE_MARKERS.some((marker) => marker.test(text))
      ? text
      : undefined;
  }

  /**
   * Close the modal so the session is reusable. Best effort: a stuck dialog is
   * not worth failing an operation whose verdict we already have.
   */
  private async dismissModal(page: Page): Promise<void> {
    const ok = page.locator(PORTAL_MODAL_SELECTORS.dismiss).first();
    if ((await ok.count()) > 0) {
      await ok.click().catch(() => undefined);
    }
  }

  /**
   * Apple's expiry for a verified row, or null with a loud log. Null is a real
   * outcome to be surfaced, not a default to be quietly filled in.
   */
  private readExpiry(domain: string, row: MerchantDomainRow): Date | null {
    if (row.expiresText === undefined) {
      this.logger.emit(
        'error',
        'Domain is verified but the portal published no expiry date',
        { domain },
      );
      return null;
    }

    const parsed = parseAppleExpiryDate(row.expiresText);
    if (parsed === undefined) {
      this.logger.emit('error', 'Could not parse the portal expiry date', {
        domain,
        raw: row.expiresText,
      });
      return null;
    }

    this.logger.emit('info', 'Read verification expiry from the portal', {
      domain,
      raw: row.expiresText,
      verificationExpiresAt: parsed.toISOString(),
    });
    return parsed;
  }

  /**
   * Every domain Apple lists on the merchant identifier, with its status and
   * expiry.
   *
   * One round trip per block via allTextContents(): a per-span textContent() walk
   * costs a CDP call each, which on a 47-domain merchant page is hundreds of them.
   */
  private async readDomainRows(page: Page): Promise<MerchantDomainRow[]> {
    const blocks = await this.domainBlocks(page);
    const total = await blocks.count();
    const rows: MerchantDomainRow[] = [];
    for (let index = 0; index < total; index += 1) {
      const row = toDomainRow(await this.blockTexts(blocks.nth(index)));
      if (row !== undefined) rows.push(row);
    }
    return rows;
  }

  /**
   * The block for exactly this domain, or undefined.
   *
   * Matches the parsed `Domain:` cell, not page text: `secureorder.avixa.co` is a
   * substring of `secureorder.avixa.com`, and both are registered here.
   */
  private async findDomainBlock(
    page: Page,
    domain: string,
  ): Promise<Locator | undefined> {
    const blocks = await this.domainBlocks(page);
    const total = await blocks.count();
    for (let index = 0; index < total; index += 1) {
      const block = blocks.nth(index);
      const row = toDomainRow(await this.blockTexts(block));
      if (row?.domain === domain.toLowerCase()) return block;
    }
    return undefined;
  }

  /** Semantic selector first, the brief's structural path as a second opinion. */
  private async domainBlocks(page: Page): Promise<Locator> {
    const semantic = page.locator(MERCHANT_DOMAIN_LIST_SELECTORS.block);
    if ((await semantic.count()) > 0) return semantic;
    return page.locator(MERCHANT_DOMAIN_LIST_STRUCTURAL_SELECTORS.block);
  }

  private blockTexts(block: Locator): Promise<string[]> {
    return block.locator(MERCHANT_DOMAIN_LIST_SELECTORS.row).allTextContents();
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

  /**
   * Put the domain in the form field.
   *
   * `fill()` by default: one operation, one `input` event, value set atomically.
   * That is the right thing for an unattended run and it is what every production
   * path does.
   *
   * Above 0, PLAYWRIGHT_TYPING_DELAY_MS types it key by key instead. This exists
   * only so a demo can show data being entered — PLAYWRIGHT_SLOW_MO_MS paces whole
   * operations, and `fill()` is a single operation, so no value of it will ever
   * look like typing.
   *
   * The two are not equivalent at the DOM level: typing fires a full
   * keydown/keypress/input/keyup sequence per character where `fill()` fires one
   * `input`. If Apple ever adds live validation or an autocomplete to this field,
   * the demo path is the one that would behave differently — which is why the
   * default is 0 and production never takes this branch.
   */
  private async enterDomain(input: Locator, domain: string): Promise<void> {
    const typingDelayMs = this.config.getOrThrow<number>(
      'PLAYWRIGHT_TYPING_DELAY_MS',
    );

    if (typingDelayMs === 0) {
      await input.fill(domain);
      return;
    }

    // Clear first so this stays an entry rather than an append — pressSequentially
    // types at the caret and does not replace existing content.
    await input.fill('');
    await input.pressSequentially(domain, {
      delay: typingDelayMs,
      // The per-character delay must never be the thing that trips the action
      // timeout: a 40-character host at 500ms is 20s of legitimate typing.
      timeout:
        this.config.getOrThrow<number>('PLAYWRIGHT_ACTION_TIMEOUT_MS') +
        domain.length * typingDelayMs,
    });
  }

  /**
   * Whether Apple already has this domain on the merchant identifier.
   *
   * Compares the parsed `Domain:` cell exactly. An unanchored `text=${domain}`
   * matches substrings anywhere on the page, so registering
   * `secureorder.avixa.co` reported "already registered" whenever
   * `secureorder.avixa.com` was present — a false positive that blocks a
   * legitimate registration, and both of those domains exist on this merchant.
   *
   * The substring check is kept for the case where the list does not parse at
   * all, so a DOM change degrades to the old behaviour instead of reporting "not
   * listed" and adding a duplicate.
   */
  private async isDomainListed(page: Page, domain: string): Promise<boolean> {
    const target = domain.toLowerCase();
    const rows = await this.readDomainRows(page);
    if (rows.length > 0) {
      return rows.some((row) => row.domain === target);
    }
    return (await page.locator(`text=${domain}`).count()) > 0;
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
