import {
  isVerifiedStatus,
  parseAppleExpiryDate,
  toDomainRow,
} from './merchant-domain-list';

/**
 * The `<li>` texts below are what `textContent` yields for a real domain block on
 * the merchant identifier page — label and value concatenated, the help-icon
 * anchor contributing nothing. Taken from the live portal, not invented.
 */
const VERIFIED_BLOCK = [
  'Domain:secureorder.shopandersoncookware.com',
  'Status:verified',
  'Verification Expires:Aug 26, 2026',
];

describe('toDomainRow', () => {
  it('reads domain, status and expiry from a verified block', () => {
    expect(toDomainRow(VERIFIED_BLOCK)).toEqual({
      domain: 'secureorder.shopandersoncookware.com',
      status: 'verified',
      expiresText: 'Aug 26, 2026',
    });
  });

  it('leaves expiry undefined when the portal renders no expiry row', () => {
    // A freshly added domain is not verified yet, so Apple publishes no expiry.
    const row = toDomainRow([
      'Domain:pay.example.com',
      'Status:pending verification',
    ]);

    expect(row).toEqual({
      domain: 'pay.example.com',
      status: 'pending verification',
      expiresText: undefined,
    });
  });

  it('returns undefined for a block with no domain to key on', () => {
    // Attributing an unnamed block to some domain is how a wrong date gets
    // written; refuse instead.
    expect(
      toDomainRow(['Status:verified', 'Verification Expires:Aug 6, 2026']),
    ).toBeUndefined();
    expect(toDomainRow([])).toBeUndefined();
    expect(toDomainRow(['Domain:'])).toBeUndefined();
  });

  it('lower-cases the domain so comparisons are case-insensitive', () => {
    expect(toDomainRow(['Domain:Pay.EXAMPLE.com'])?.domain).toBe(
      'pay.example.com',
    );
  });

  it('tolerates label whitespace and casing drift', () => {
    expect(
      toDomainRow([
        '  domain :  pay.example.com',
        'STATUS:  Verified',
        'Verification   Expires :  Oct 28, 2026',
      ]),
    ).toEqual({
      domain: 'pay.example.com',
      status: 'verified',
      expiresText: 'Oct 28, 2026',
    });
  });

  it('ignores rows it does not recognise', () => {
    const row = toDomainRow([
      'Domain:pay.example.com',
      'Something Apple Added:whatever',
      'Status:verified',
    ]);

    expect(row?.status).toBe('verified');
  });
});

describe('isVerifiedStatus', () => {
  it('accepts only an exact verified', () => {
    expect(isVerifiedStatus('verified')).toBe(true);
    expect(isVerifiedStatus(' Verified ')).toBe(true);
  });

  it('rejects every other status', () => {
    // 'unverified' contains 'verified' as a substring — a contains() check here
    // would report an unverified domain as verified.
    expect(isVerifiedStatus('unverified')).toBe(false);
    expect(isVerifiedStatus('pending verification')).toBe(false);
    expect(isVerifiedStatus('')).toBe(false);
  });
});

describe('parseAppleExpiryDate', () => {
  it('anchors the portal date to start of day UTC', () => {
    // Start of day, not end: the portal states no time, and assuming the later
    // instant would claim runway Apple may not have granted.
    expect(parseAppleExpiryDate('Aug 26, 2026')?.toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
  });

  it('parses every month abbreviation the portal uses', () => {
    const cases: [string, string][] = [
      ['Aug 6, 2026', '2026-08-06T00:00:00.000Z'],
      ['Sep 11, 2026', '2026-09-11T00:00:00.000Z'],
      ['Oct 28, 2026', '2026-10-28T00:00:00.000Z'],
      ['Jan 1, 2027', '2027-01-01T00:00:00.000Z'],
      ['Dec 31, 2026', '2026-12-31T00:00:00.000Z'],
    ];

    for (const [raw, expected] of cases) {
      expect(parseAppleExpiryDate(raw)?.toISOString()).toBe(expected);
    }
  });

  it('accepts full month names, a trailing dot and loose spacing', () => {
    expect(parseAppleExpiryDate('August 26, 2026')?.toISOString()).toBe(
      '2026-08-26T00:00:00.000Z',
    );
    expect(parseAppleExpiryDate('Sept. 11, 2026')?.toISOString()).toBe(
      '2026-09-11T00:00:00.000Z',
    );
    expect(parseAppleExpiryDate('  Oct 15,2026  ')?.toISOString()).toBe(
      '2026-10-15T00:00:00.000Z',
    );
  });

  it('does not shift the day with the process timezone', () => {
    // The bug this guards: `new Date("Aug 26, 2026")` resolves in local time, so
    // east of UTC it lands on Aug 25T… and the stored day is off by one.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      expect(parseAppleExpiryDate('Aug 26, 2026')?.toISOString()).toBe(
        '2026-08-26T00:00:00.000Z',
      );
      process.env.TZ = 'America/Los_Angeles';
      expect(parseAppleExpiryDate('Aug 26, 2026')?.toISOString()).toBe(
        '2026-08-26T00:00:00.000Z',
      );
    } finally {
      process.env.TZ = original;
    }
  });

  it('returns undefined rather than guessing at unparseable input', () => {
    for (const raw of [
      '',
      'never',
      'Aug 2026',
      '2026-08-26',
      '26 Aug 2026',
      'Augxst 26, 2026',
      'Aug 26 2026',
      'Aug, 2026',
    ]) {
      expect(parseAppleExpiryDate(raw)).toBeUndefined();
    }
  });

  it('rejects a calendar-invalid day instead of rolling it forward', () => {
    // Date.UTC(2026, 1, 31) silently becomes Mar 3. Storing that would be a date
    // Apple never showed.
    expect(parseAppleExpiryDate('Feb 31, 2026')).toBeUndefined();
    expect(parseAppleExpiryDate('Apr 31, 2026')).toBeUndefined();
    expect(parseAppleExpiryDate('Feb 29, 2027')).toBeUndefined();
  });

  it('accepts a genuine leap day', () => {
    expect(parseAppleExpiryDate('Feb 29, 2028')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });
});
