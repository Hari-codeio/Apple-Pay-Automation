/**
 * Parsing for the "Merchant Domains" list on the merchant identifier edit page.
 *
 * This is the ONLY place Apple publishes a domain's real verification expiry.
 * Everything here is pure: the client reads the `<li>` text out of the browser,
 * these functions turn it into data, and so the DOM contract can be tested
 * without launching Chromium.
 *
 * Shape of one block, verbatim from the portal:
 *
 *   div.cert-block.domain-block
 *     ul
 *       li  <span>Domain:</span><span>secureorder.example.com</span>
 *       li  <span>Status:</span><span class="domain-status verified">verified</span>
 *       li  <a …><svg/></a><span>Verification Expires:</span><span>Aug 26, 2026</span>
 *
 * `textContent` of each `<li>` therefore reads `Domain:secureorder.example.com`
 * — label and value concatenated, with the help-icon anchor contributing nothing.
 * Matching on the label prefix survives Apple inserting rows or reordering them,
 * which nth-child positions do not.
 */

/** One row of the merchant domain list. */
export interface MerchantDomainRow {
  /** Lower-cased, as Apple renders it. */
  domain: string;
  /** Lower-cased status text, e.g. `verified`. Empty when absent. */
  status: string;
  /**
   * Expiry exactly as Apple rendered it, e.g. `Aug 26, 2026`. Undefined when the
   * row carries no expiry — which is the normal case for a domain that has not
   * been verified yet.
   */
  expiresText?: string;
}

const FIELD_PATTERNS = {
  domain: /^\s*domain\s*:\s*/i,
  status: /^\s*status\s*:\s*/i,
  expires: /^\s*verification\s+expires\s*:\s*/i,
} as const;

/**
 * Build a row from the `<li>` texts of a single domain block.
 *
 * Returns undefined when there is no domain to key on: a block we cannot name is
 * useless to every caller, and guessing which domain it belongs to is exactly the
 * kind of inference that puts a wrong date in the audit trail.
 */
export function toDomainRow(
  liTexts: readonly string[],
): MerchantDomainRow | undefined {
  let domain: string | undefined;
  let status = '';
  let expiresText: string | undefined;

  for (const text of liTexts) {
    const asDomain = FIELD_PATTERNS.domain.exec(text);
    if (asDomain !== null) {
      domain = text.slice(asDomain[0].length).trim().toLowerCase();
      continue;
    }

    const asStatus = FIELD_PATTERNS.status.exec(text);
    if (asStatus !== null) {
      status = text.slice(asStatus[0].length).trim().toLowerCase();
      continue;
    }

    const asExpires = FIELD_PATTERNS.expires.exec(text);
    if (asExpires !== null) {
      const value = text.slice(asExpires[0].length).trim();
      if (value !== '') expiresText = value;
    }
  }

  if (domain === undefined || domain === '') return undefined;
  return { domain, status, expiresText };
}

/** Apple renders `verified`; treat anything else as not yet verified. */
export function isVerifiedStatus(status: string): boolean {
  return status.trim().toLowerCase() === 'verified';
}

const MONTHS = new Map<string, number>([
  ['jan', 0],
  ['january', 0],
  ['feb', 1],
  ['february', 1],
  ['mar', 2],
  ['march', 2],
  ['apr', 3],
  ['april', 3],
  ['may', 4],
  ['jun', 5],
  ['june', 5],
  ['jul', 6],
  ['july', 6],
  ['aug', 7],
  ['august', 7],
  ['sep', 8],
  ['sept', 8],
  ['september', 8],
  ['oct', 9],
  ['october', 9],
  ['nov', 10],
  ['november', 10],
  ['dec', 11],
  ['december', 11],
]);

/** `Aug 26, 2026` / `August 26, 2026`, with an optional abbreviation dot. */
const EXPIRY_PATTERN = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/;

/**
 * Parse Apple's day-precision expiry into an instant.
 *
 * Anchored to 00:00:00 UTC on the stated day, deliberately. The portal gives no
 * time and no timezone, and treating the value as the START of the day means this
 * service never believes a verification has more runway than Apple granted.
 *
 * `new Date(text)` is not used: it resolves a bare date string in the process
 * timezone, so the same portal value would land on a different UTC day depending
 * on where this runs.
 *
 * Returns undefined for anything that does not match exactly. The caller stores
 * NULL and logs loudly rather than inventing a date — a plausible-looking wrong
 * expiry is worse than a visibly absent one.
 */
export function parseAppleExpiryDate(raw: string): Date | undefined {
  const match = EXPIRY_PATTERN.exec(raw.trim());
  if (match === null) return undefined;

  const month = MONTHS.get(match[1].toLowerCase());
  if (month === undefined) return undefined;

  const day = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month, day));

  // Date.UTC rolls overflow forward silently — Feb 31 becomes Mar 3. Reject that
  // rather than persist a date the portal never showed.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month ||
    parsed.getUTCDate() !== day
  ) {
    return undefined;
  }
  return parsed;
}
