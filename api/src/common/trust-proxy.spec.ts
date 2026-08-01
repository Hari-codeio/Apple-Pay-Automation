import { resolveTrustProxy } from './trust-proxy';

describe('resolveTrustProxy', () => {
  it('defaults to a hop count of 1 (one load balancer in front)', () => {
    expect(resolveTrustProxy(undefined)).toBe(1);
    expect(resolveTrustProxy('')).toBe(1);
  });

  it('returns a NUMBER for a numeric hop count', () => {
    // The whole reason this function exists: Express reads the string '1' as an
    // IP literal and silently trusts nothing, so req.ip stays the LB address.
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy('2')).toBe(2);
    expect(typeof resolveTrustProxy('1')).toBe('number');
  });

  it('returns booleans for true/false, case-insensitively', () => {
    expect(resolveTrustProxy('true')).toBe(true);
    expect(resolveTrustProxy('TRUE')).toBe(true);
    expect(resolveTrustProxy('False')).toBe(false);
  });

  it('passes presets, IPs, and CIDR lists through as strings', () => {
    expect(resolveTrustProxy('loopback')).toBe('loopback');
    expect(resolveTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(resolveTrustProxy('loopback, 10.0.0.0/8')).toBe(
      'loopback, 10.0.0.0/8',
    );
  });

  it('trims surrounding whitespace before deciding the type', () => {
    expect(resolveTrustProxy('  2  ')).toBe(2);
    expect(resolveTrustProxy(' true ')).toBe(true);
  });
});
