import {
  chromeExecutableCandidates,
  isCdpReachable,
  isLoopbackUrl,
} from './chrome-launcher';

describe('isLoopbackUrl', () => {
  // This is a security control, not a convenience check: a non-loopback CDP
  // target hands full control of a browser holding a live Apple session to
  // whoever answers it.
  it.each([
    'http://127.0.0.1:9222',
    'http://localhost:9222',
    'https://localhost:9222',
    'http://[::1]:9222',
    'http://localhost./',
    'http://LOCALHOST:9222',
  ])('accepts loopback target %s', (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    ['a public host', 'http://example.com:9222'],
    ['a LAN address', 'http://192.168.1.10:9222'],
    ['cloud metadata', 'http://169.254.169.254/'],
    ['a decoy subdomain', 'http://127.0.0.1.evil.test:9222'],
    ['a decoy prefix', 'http://localhost.evil.test:9222'],
    ['a userinfo trick', 'http://localhost@evil.test:9222'],
    ['a non-http scheme', 'file:///etc/passwd'],
    ['a ws scheme', 'ws://127.0.0.1:9222'],
    ['nonsense', 'not-a-url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it('rejects a host that merely contains a loopback name', () => {
    // Substring matching is the classic bug here; the check is exact-match.
    expect(isLoopbackUrl('http://mylocalhost:9222')).toBe(false);
    expect(isLoopbackUrl('http://localhostx:9222')).toBe(false);
  });
});

describe('chromeExecutableCandidates', () => {
  it('puts an explicit override first so it always wins', () => {
    const candidates = chromeExecutableCandidates({
      CHROME_EXECUTABLE_PATH: 'D:\\custom\\chrome.exe',
    } as NodeJS.ProcessEnv);

    expect(candidates[0]).toBe('D:\\custom\\chrome.exe');
  });

  it('includes per-platform defaults', () => {
    const candidates = chromeExecutableCandidates({} as NodeJS.ProcessEnv);

    expect(candidates).toEqual(
      expect.arrayContaining([
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
      ]),
    );
  });

  it('drops undefined entries rather than emitting holes', () => {
    // LOCALAPPDATA is absent on non-Windows, and an undefined in the list would
    // reach existsSync and throw.
    const candidates = chromeExecutableCandidates({} as NodeJS.ProcessEnv);

    expect(candidates.every((c) => typeof c === 'string' && c.length > 0)).toBe(
      true,
    );
  });
});

describe('isCdpReachable', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('probes the DevTools version endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await expect(isCdpReachable('http://127.0.0.1:9222')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://127.0.0.1:9222/json/version',
    );
  });

  it('reports false when nothing is listening', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(isCdpReachable('http://127.0.0.1:9222')).resolves.toBe(false);
  });

  it('reports false on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false });

    await expect(isCdpReachable('http://127.0.0.1:9222')).resolves.toBe(false);
  });

  it('passes an abort signal so an unresponsive port cannot stall the run', async () => {
    // This runs before every portal operation; a hung probe would stall it.
    fetchMock.mockResolvedValue({ ok: true });

    await isCdpReachable('http://127.0.0.1:9222');

    expect(fetchMock.mock.calls[0][1].signal).toBeDefined();
  });
});
