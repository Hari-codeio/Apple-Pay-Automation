import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * The domain string is validated only for shape here; `normalizeDomain` in the
 * service owns the real rules (no scheme, no port, no wildcard, valid DNS
 * labels). Keeping that logic in one place means the CLI entrypoint gets the
 * same checks as the HTTP one, and it is unit-testable without a request.
 */
export class RegisterDomainDto {
  @ApiProperty({
    example: 'pay.example.com',
    description:
      'Bare hostname to register. No scheme, port, path, or wildcard.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(253)
  domain!: string;

  @ApiPropertyOptional({
    example: 1042,
    description:
      'Owning store, written to apple_pay_domain_verifications.store_code.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  storeCode?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Register and store the association file but do not ask Apple to verify. ' +
      'Use when the file still needs a deploy before it is reachable.',
  })
  @IsOptional()
  @IsBoolean()
  skipVerify?: boolean;
}
