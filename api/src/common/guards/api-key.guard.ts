import {
  CanActivate,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { isDevLikeTier } from '../constants';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Shared-secret guard for the endpoints that drive the Apple portal.
 *
 * These routes register domains on a real merchant identifier and write to a
 * shared database. Leaving them open means anyone who can reach the pod can add
 * a domain to our Apple Pay merchant ID, so the guard is fail-closed: no
 * configured key on a shared tier is a 403, not an open door.
 *
 * The boot schema also requires API_KEY outside dev-like tiers, so this branch
 * is a second line of defence rather than the only one.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('API_KEY');
    const devLike = isDevLikeTier(this.config.get<string>('ENVIRONMENT'));

    if (expected === undefined || expected.length === 0) {
      // Unauthenticated access is tolerable only on a developer machine.
      if (devLike) return true;
      throw new ForbiddenException(
        'API_KEY is not configured; refusing to serve a privileged route',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const presented = request.headers[API_KEY_HEADER];
    const candidate = Array.isArray(presented) ? presented[0] : presented;

    if (typeof candidate !== 'string' || !safeEqual(candidate, expected)) {
      throw new UnauthorizedException('Invalid or missing API key');
    }
    return true;
  }
}

/**
 * Constant-time comparison. Length is compared first (and leaks only the
 * length, which `timingSafeEqual` would throw over anyway).
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
