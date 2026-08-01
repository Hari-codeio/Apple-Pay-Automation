import type { ConfigService } from '@nestjs/config';
import { ReadinessRegistry, type ReadinessProbe } from './readiness-registry';

function probe(name: string, check: () => Promise<boolean>): ReadinessProbe {
  return { name, check };
}

describe('ReadinessRegistry', () => {
  let registry: ReadinessRegistry;

  beforeEach(() => {
    registry = new ReadinessRegistry();
  });

  it('reports ready with no probes registered', () => {
    return expect(registry.runAll()).resolves.toEqual({});
  });

  it('runs every registered probe', async () => {
    registry.register(probe('mysql', async () => true));
    registry.register(probe('cache', async () => false));

    await expect(registry.runAll()).resolves.toEqual({
      mysql: 'ok',
      cache: 'fail',
    });
  });

  it('maps a throwing probe to fail rather than propagating', async () => {
    // A probe that throws must not turn /readyz into a 500 — the endpoint's job
    // is to report the outage, not to become one.
    registry.register(
      probe('mysql', () => Promise.reject(new Error('connection refused'))),
    );

    await expect(registry.runAll()).resolves.toEqual({ mysql: 'fail' });
  });

  it('times out a hung probe instead of holding the response open', async () => {
    jest.useFakeTimers();
    registry.register(probe('hung', () => new Promise<boolean>(() => {})));

    const pending = registry.runAll();
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(pending).resolves.toEqual({ hung: 'timeout' });
    jest.useRealTimers();
  });

  it('honours a configured probe timeout', async () => {
    // Must stay below the orchestrator's own readiness timeout, so it is a knob.
    const configured = new ReadinessRegistry({
      get: () => 500,
    } as unknown as ConfigService);
    configured.register(probe('hung', () => new Promise<boolean>(() => {})));

    jest.useFakeTimers();
    const pending = configured.runAll();
    await jest.advanceTimersByTimeAsync(500);

    await expect(pending).resolves.toEqual({ hung: 'timeout' });
    jest.useRealTimers();
  });

  it('rejects a duplicate probe name', () => {
    // Two probes under one name means one silently shadows the other, and
    // /readyz reports green for a dependency it never checked.
    registry.register(probe('mysql', async () => true));
    expect(() => registry.register(probe('mysql', async () => true))).toThrow(
      /already registered/,
    );
  });
});
