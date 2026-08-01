import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * A dependency `/readyz` should check before declaring the pod able to serve
 * traffic. `check()` must resolve false rather than throw on a normal outage;
 * the registry timeboxes it either way.
 */
export interface ReadinessProbe {
  readonly name: string;
  check(): Promise<boolean>;
}

export type ProbeResult = 'ok' | 'fail' | 'timeout';

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;

/**
 * Registry of readiness probes.
 *
 * A registry rather than a fixed list of injected dependencies: a module that
 * owns a connection (MySQL today, a queue tomorrow) registers its own probe in
 * `onModuleInit`, and `/readyz` picks it up without HealthModule having to know
 * that module exists.
 */
@Injectable()
export class ReadinessRegistry {
  private readonly probes = new Map<string, ReadinessProbe>();
  private readonly timeoutMs: number;

  // Optional so the registry can be constructed directly in a unit test without
  // standing up a config module.
  constructor(@Optional() config?: ConfigService) {
    this.timeoutMs =
      config?.get<number>('READINESS_PROBE_TIMEOUT_MS') ??
      DEFAULT_PROBE_TIMEOUT_MS;
  }

  register(probe: ReadinessProbe): void {
    if (this.probes.has(probe.name)) {
      // Two probes under one name means one silently shadows the other, and
      // `/readyz` reports green for a dependency it never checked.
      throw new Error(`Readiness probe '${probe.name}' is already registered`);
    }
    this.probes.set(probe.name, probe);
  }

  /**
   * Run every probe concurrently, each timeboxed. A hung dependency must not
   * hold the response open past the orchestrator's own probe timeout, or the
   * pod looks dead rather than degraded.
   */
  async runAll(): Promise<Record<string, ProbeResult>> {
    const entries = await Promise.all(
      [...this.probes.values()].map(
        async (probe): Promise<[string, ProbeResult]> => [
          probe.name,
          await this.runOne(probe),
        ],
      ),
    );
    return Object.fromEntries(entries);
  }

  private async runOne(probe: ReadinessProbe): Promise<ProbeResult> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        timer.unref();
      });
      const result = await Promise.race([
        probe.check().then((ok) => (ok ? 'ok' : 'fail') as ProbeResult),
        timeout,
      ]);
      return result;
    } catch {
      return 'fail';
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
