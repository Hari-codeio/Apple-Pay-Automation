import { createCorsOriginCallback, parseAllowedOrigins } from './cors-origin';

function decide(
  callback: ReturnType<typeof createCorsOriginCallback>,
  origin: string | undefined,
): boolean | undefined {
  let allowed: boolean | undefined;
  callback(origin, (error, allow) => {
    expect(error).toBeNull();
    allowed = allow;
  });
  return allowed;
}

describe('parseAllowedOrigins', () => {
  it('returns an empty list for undefined or blank input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins('   ')).toEqual([]);
  });

  it('splits, trims, lower-cases, and drops trailing slashes', () => {
    expect(
      parseAllowedOrigins(
        ' https://App.Example.com/ , https://admin.example.com ',
      ),
    ).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  it('ignores empty entries from a trailing comma', () => {
    expect(parseAllowedOrigins('https://a.example.com,,')).toEqual([
      'https://a.example.com',
    ]);
  });
});

describe('createCorsOriginCallback', () => {
  const allowedOrigins = ['https://app.example.com'];

  it('allows a request with no Origin header', () => {
    // Server-to-server calls and orchestrator probes send none, and CORS has
    // nothing to say about them.
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
    });
    expect(decide(callback, undefined)).toBe(true);
  });

  it('allows an exact allowlist match regardless of case or trailing slash', () => {
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
    });
    expect(decide(callback, 'https://APP.example.com')).toBe(true);
    expect(decide(callback, 'https://app.example.com/')).toBe(true);
  });

  it('denies an origin that merely ends with an allowed domain', () => {
    // This is the failure a suffix check produces, and the reason the
    // implementation uses exact matching.
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
    });
    expect(decide(callback, 'https://app.example.com.attacker.test')).toBe(
      false,
    );
  });

  it('denies a scheme mismatch', () => {
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
    });
    expect(decide(callback, 'http://app.example.com')).toBe(false);
  });

  it('reports the denied origin so a misconfigured allowlist is visible', () => {
    const onDenied = jest.fn();
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
      onDenied,
    });
    decide(callback, 'https://evil.test');
    expect(onDenied).toHaveBeenCalledWith('https://evil.test');
  });

  it('denies without erroring, so a client misconfiguration is not our 500', () => {
    const callback = createCorsOriginCallback({
      allowAll: false,
      allowedOrigins,
    });
    const spy = jest.fn();
    callback('https://evil.test', spy);
    expect(spy).toHaveBeenCalledWith(null, false);
  });

  it('reflects any origin when allowAll is set', () => {
    const callback = createCorsOriginCallback({
      allowAll: true,
      allowedOrigins: [],
    });
    expect(decide(callback, 'https://anything.test')).toBe(true);
  });
});
