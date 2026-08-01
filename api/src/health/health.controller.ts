import { Controller, Get, HttpCode, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { ReadinessRegistry, type ProbeResult } from './readiness-registry';

interface ReadinessBody {
  status: 'ready' | 'degraded';
  checks: Record<string, ProbeResult>;
}

/**
 * Liveness and readiness endpoints.
 *
 * `/healthz` is pure process liveness: if Node answers, it is live. It must not
 * touch a dependency — an orchestrator restarts the pod when liveness fails, and
 * restarting a healthy pod because MySQL flapped turns a partial outage into a
 * total one.
 *
 * `/readyz` probes the dependencies a request actually needs and returns 503
 * when any is down, so the pod is pulled from rotation until it recovers.
 */
@ApiTags('health')
@SkipThrottle()
@Controller()
export class HealthController {
  constructor(private readonly registry: ReadinessRegistry) {}

  @Get('healthz')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Process liveness. Never touches a dependency.' })
  liveness(): { status: 'ok'; uptimeSec: number } {
    return { status: 'ok', uptimeSec: Math.round(process.uptime()) };
  }

  @Get('readyz')
  @ApiOperation({ summary: 'Dependency readiness. 503 when any probe fails.' })
  async readiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessBody> {
    const checks = await this.registry.runAll();
    const degraded = Object.values(checks).some((result) => result !== 'ok');

    // The status is set directly rather than by throwing an HttpException. A
    // throw goes through AllExceptionsFilter, which reshapes every error into
    // the standard ApiErrorResponse envelope — and that would discard `checks`,
    // which is the only part of this response an operator actually needs.
    // `passthrough: true` keeps Nest's normal serialization of the return value.
    response.status(degraded ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.OK);

    return { status: degraded ? 'degraded' : 'ready', checks };
  }
}
