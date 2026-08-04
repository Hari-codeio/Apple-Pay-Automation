import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags, ApiParam } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RegisterDomainDto } from './dto/register-domain.dto';
import { DomainVerificationService } from './domain-verification.service';
import type {
  DomainVerificationRecord,
  ProbeOutcome,
  RegistrationResult,
} from './domain-verification.types';

/**
 * Every route here is behind `ApiKeyGuard`: three of the four drive a real Apple
 * merchant identifier or mutate a shared table.
 *
 * The write routes carry a much tighter throttle than the global default. Each
 * one launches a browser and consumes an Apple portal interaction, so the
 * limiting factor is Apple's tolerance, not ours — a caller retrying in a loop
 * would get the account rate-limited long before the pod noticed any load.
 */
@ApiTags('domain-verification')
@ApiSecurity('api-key')
@UseGuards(ApiKeyGuard)
@Controller('domain-verifications')
export class DomainVerificationController {
  constructor(private readonly service: DomainVerificationService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Register a domain, store its association file, and verify it',
    description:
      'Runs the full flow: Apple portal registration → association file download → ' +
      'database write → liveness probe → Apple verification. NOT retryable for a ' +
      'domain Apple already lists — it is rejected, because Apple offers the ' +
      'association file only on the confirmation screen shown right after an add. ' +
      'Use POST /:domain/reverify for that case.',
  })
  register(@Body() dto: RegisterDomainDto): Promise<RegistrationResult> {
    return this.service.register({
      domain: dto.domain,
      storeCode: dto.storeCode ?? null,
      skipVerify: dto.skipVerify,
    });
  }

  @Get(':domain')
  @ApiParam({ name: 'domain', example: 'pay.example.com' })
  @ApiOperation({ summary: 'Current verification record for a domain' })
  find(@Param('domain') domain: string): Promise<DomainVerificationRecord> {
    return this.service.findByDomain(domain);
  }

  @Post(':domain/probe')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'domain', example: 'pay.example.com' })
  @ApiOperation({
    summary: 'Check whether the stored association file is live on the domain',
    description:
      'Compares SHA-256 of the served bytes against the stored file. Touches no ' +
      'Apple resource, so it is the safe way to answer "is this ready to verify?".',
  })
  probe(@Param('domain') domain: string): Promise<ProbeOutcome> {
    return this.service.probe(domain);
  }

  @Post(':domain/reverify')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiParam({ name: 'domain', example: 'pay.example.com' })
  @ApiOperation({
    summary: 'Re-probe and re-verify using the already-stored association file',
    description:
      'The recovery path when registration succeeded but verification did not — ' +
      'typically because the file needed a deploy before Apple could fetch it. ' +
      'Does not re-register or re-download.',
  })
  reverify(@Param('domain') domain: string): Promise<RegistrationResult> {
    return this.service.reverify(domain);
  }

  @Delete(':domain')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiParam({ name: 'domain', example: 'pay.example.com' })
  @ApiOperation({
    summary: 'Stop serving a domain (soft delete)',
    description:
      'Sets is_deleted. The Apple-side registration is deliberately left intact — ' +
      'removing it there is destructive and is not what this endpoint promises.',
  })
  remove(@Param('domain') domain: string): Promise<void> {
    return this.service.remove(domain);
  }
}
