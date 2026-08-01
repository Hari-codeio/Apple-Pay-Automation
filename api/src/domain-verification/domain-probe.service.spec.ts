import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AppLogger } from '../observability/app-logger';
import { DomainProbeService } from './domain-probe.service';

const FILE_CONTENT = 'a'.repeat(200);
const FILE_SHA = createHash('sha256').update(FILE_CONTENT).digest('hex');

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    DOMAIN_PROBE_ATTEMPTS: 3,
    DOMAIN_PROBE_DELAY_MS: 0,
    DOMAIN_PROBE_TIMEOUT_MS: 1_000,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => values[key],
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function silentLogger(): AppLogger {
  return { emit: jest.fn() } as unknown as AppLogger;
}

function response(init: {
  status: number;
  body?: string;
  location?: string;
}): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: () => init.location ?? null },
    text: async () => init.body ?? '',
  } as unknown as Response;
}

describe('DomainProbeService', () => {
  const fetchMock = jest.fn();
  let service: DomainProbeService;

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    service = new DomainProbeService(configWith(), silentLogger());
  });

  it('probes the well-known path over HTTPS', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, body: FILE_CONTENT }));

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.ok).toBe(true);
    // `.txt` is the path Apple actually fetches — see domain.util.spec.
    expect(outcome.url).toBe(
      'https://pay.example.com/.well-known/apple-developer-merchantid-domain-association.txt',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not follow redirects, because Apple does not either', async () => {
    fetchMock.mockResolvedValue(response({ status: 200, body: FILE_CONTENT }));
    await service.probe('pay.example.com', FILE_SHA);

    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      redirect: 'manual',
      cache: 'no-store',
    });
  });

  it('reports a redirect as a misconfiguration', async () => {
    fetchMock.mockResolvedValue(
      response({ status: 301, location: 'https://www.pay.example.com/...' }),
    );

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('redirect');
    expect(outcome.httpStatus).toBe(301);
  });

  it('reports an HTTP error status', async () => {
    fetchMock.mockResolvedValue(response({ status: 404 }));

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.reason).toBe('http-error');
    expect(outcome.httpStatus).toBe(404);
  });

  it('fails a 200 whose content does not match the downloaded file', async () => {
    // The failure this whole step exists to catch: a CDN serving a stale copy of
    // a previous association file answers 200 and Apple still rejects it.
    fetchMock.mockResolvedValue(
      response({ status: 200, body: 'b'.repeat(200) }),
    );

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('content-mismatch');
  });

  it('reports an unreachable host', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.reason).toBe('unreachable');
    expect(outcome.detail).toContain('ENOTFOUND');
  });

  it('retries up to the configured attempt count and reports the count', async () => {
    fetchMock
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(response({ status: 404 }))
      .mockResolvedValueOnce(response({ status: 200, body: FILE_CONTENT }));

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('gives up after the configured attempts', async () => {
    fetchMock.mockResolvedValue(response({ status: 404 }));

    const outcome = await service.probe('pay.example.com', FILE_SHA);

    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
