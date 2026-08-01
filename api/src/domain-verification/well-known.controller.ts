import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  DOMAIN_ASSOCIATION_FILENAME,
  WELL_KNOWN_PATH,
} from '../common/constants';
import { DomainVerificationService } from './domain-verification.service';

/**
 * Serves the association file Apple fetches to prove domain control.
 *
 * Three things are load-bearing here:
 *
 *   1. **Path.** Apple fetches
 *      `/.well-known/apple-developer-merchantid-domain-association.txt` at the
 *      domain root, so this controller is excluded from the API's global prefix
 *      in `main.ts`. Under `/api` Apple would never find it. The `.txt` suffix
 *      is the one Apple states on its Verify screen and the only one it fetches;
 *      the extensionless name it used previously is deliberately NOT served.
 *   2. **Which file.** The domain is taken from the `Host` header, because one
 *      deployment serves many registered domains and each has its own file.
 *   3. **Bytes.** Served as `text/plain` with no transformation. Apple compares
 *      content; a JSON wrapper or a trailing newline added by a serializer fails
 *      the check.
 *
 * Off by default (`WELL_KNOWN_SERVE_ENABLED`). In the Phoenix deployment the CRM
 * backend already owns this route, and two services answering it is a split
 * brain — this exists so the flow can be exercised standalone.
 */
@ApiExcludeController()
@SkipThrottle()
@Controller(WELL_KNOWN_PATH)
export class WellKnownController {
  constructor(
    private readonly config: ConfigService,
    private readonly service: DomainVerificationService,
  ) {}

  @Get(DOMAIN_ASSOCIATION_FILENAME)
  @Header('content-type', 'text/plain; charset=utf-8')
  // Apple should always see the current file; a cached one outlives a rotation.
  @Header('cache-control', 'no-store')
  async associationFile(@Req() request: Request): Promise<string> {
    if (this.config.get<boolean>('WELL_KNOWN_SERVE_ENABLED') !== true) {
      // 404, not 403: as far as any client is concerned this route does not
      // exist here, and saying "disabled" advertises an internal toggle.
      throw new NotFoundException();
    }

    // req.hostname strips the port and honours `trust proxy`, so it is the
    // client-facing domain rather than the pod's internal address.
    const host = request.hostname;
    if (!host) throw new NotFoundException();

    return this.service.associationFileFor(host);
  }
}
