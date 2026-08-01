import { BadRequestException } from '@nestjs/common';

/**
 * Normalize and validate a domain before it reaches either the Apple portal or
 * the database.
 *
 * The table has a UNIQUE index on `domain`, so `Example.com` and `example.com`
 * arriving as two rows is not a cosmetic problem — it is a constraint violation
 * on one path and a duplicate registration on the other. Normalizing at the
 * edge means the rest of the code only ever sees one spelling.
 *
 * Apple registers an exact host, not a wildcard and not a URL, so a caller
 * passing `https://example.com/checkout` is rejected rather than silently
 * reinterpreted.
 */

/** Longest legal DNS name; also the `varchar(255)` ceiling on the column. */
const MAX_DOMAIN_LENGTH = 253;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(raw: string): string {
  const input = raw.trim();
  if (input.length === 0) {
    throw new BadRequestException('domain must not be empty');
  }

  // Reject rather than strip: a caller sending a URL may believe the path is
  // meaningful to the registration, and quietly discarding it registers
  // something they did not ask for.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    throw new BadRequestException(
      'domain must be a bare hostname without a scheme (got a URL)',
    );
  }
  if (input.includes('/')) {
    throw new BadRequestException('domain must not contain a path');
  }
  if (input.includes('@')) {
    throw new BadRequestException('domain must not contain userinfo');
  }
  if (input.includes(':')) {
    throw new BadRequestException('domain must not contain a port');
  }
  if (input.startsWith('*')) {
    throw new BadRequestException(
      'domain must be an exact hostname — Apple does not accept wildcards',
    );
  }

  // Trailing dot is a legal FQDN spelling but not what Apple stores, and it
  // would defeat the UNIQUE index.
  const host = input.replace(/\.$/, '').toLowerCase();

  if (host.length > MAX_DOMAIN_LENGTH) {
    throw new BadRequestException(
      `domain must be at most ${MAX_DOMAIN_LENGTH} characters`,
    );
  }

  const labels = host.split('.');
  if (labels.length < 2) {
    throw new BadRequestException(
      'domain must be a fully-qualified hostname (e.g. pay.example.com)',
    );
  }
  for (const label of labels) {
    if (!LABEL.test(label)) {
      throw new BadRequestException(
        `domain label '${label}' is not a valid DNS label`,
      );
    }
  }

  return host;
}

/** The HTTPS URL Apple fetches to prove domain control. */
export function associationFileUrl(domain: string, path: string): string {
  return `https://${domain}${path}`;
}
