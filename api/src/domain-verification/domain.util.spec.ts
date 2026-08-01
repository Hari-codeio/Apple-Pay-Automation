import { BadRequestException } from '@nestjs/common';
import { associationFileUrl, normalizeDomain } from './domain.util';
import { DOMAIN_ASSOCIATION_PATH } from '../common/constants';

describe('normalizeDomain', () => {
  it('lower-cases the host', () => {
    // The column has a UNIQUE index on `domain`, so two casings are a
    // constraint violation on one path and a duplicate registration on another.
    expect(normalizeDomain('Pay.Example.COM')).toBe('pay.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeDomain('  pay.example.com \n')).toBe('pay.example.com');
  });

  it('drops a trailing FQDN dot', () => {
    expect(normalizeDomain('pay.example.com.')).toBe('pay.example.com');
  });

  it('accepts a multi-label host and a hyphenated label', () => {
    expect(normalizeDomain('shop-eu.pay.example.co.uk')).toBe(
      'shop-eu.pay.example.co.uk',
    );
  });

  it.each([
    ['a URL', 'https://pay.example.com'],
    ['a scheme-only prefix', 'http://pay.example.com'],
    ['a path', 'pay.example.com/checkout'],
    ['a port', 'pay.example.com:8443'],
    ['userinfo', 'user@pay.example.com'],
    ['a wildcard', '*.example.com'],
    ['a single label', 'localhost'],
    ['an empty string', '   '],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeDomain(input)).toThrow(BadRequestException);
  });

  it('rejects a label with an invalid character', () => {
    expect(() => normalizeDomain('pay_example.com')).toThrow(
      /not a valid DNS label/,
    );
  });

  it('rejects a label starting with a hyphen', () => {
    expect(() => normalizeDomain('-pay.example.com')).toThrow(
      /not a valid DNS label/,
    );
  });

  it('rejects a host longer than 253 characters', () => {
    const tooLong = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`;
    expect(() => normalizeDomain(tooLong)).toThrow(/at most 253/);
  });

  it('rejects a URL rather than silently discarding its path', () => {
    // Stripping the path would register something the caller did not ask for.
    expect(() => normalizeDomain('https://pay.example.com/pay')).toThrow(
      /without a scheme/,
    );
  });
});

describe('associationFileUrl', () => {
  it('builds the HTTPS URL Apple fetches, including the .txt suffix', () => {
    // The suffix is not cosmetic. Apple's Verify screen states the location it
    // will fetch and it ends in `.txt`; on domains this merchant has already
    // verified, the extensionless path 404s while the `.txt` one returns the
    // file. Probing without it meant the probe could never pass.
    expect(associationFileUrl('pay.example.com', DOMAIN_ASSOCIATION_PATH)).toBe(
      'https://pay.example.com/.well-known/apple-developer-merchantid-domain-association.txt',
    );
  });
});
