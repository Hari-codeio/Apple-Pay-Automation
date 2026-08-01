import { ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApplePortalClient } from '../apple-portal/apple-portal.client';
import { AppLogger } from '../observability/app-logger';
import type { DomainProbeService } from './domain-probe.service';
import type { DomainVerificationRepository } from './domain-verification.repository';
import { DomainVerificationService } from './domain-verification.service';

const SHA = 'a'.repeat(64);

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    APPLE_MERCHANT_ID: 'merchant.phoenix.applepay8',
    APPLE_TEAM_ID: '64426BH9K3',
    VERIFICATION_TTL_DAYS: 365,
    DOMAIN_PROBE_ENABLED: true,
    ...overrides,
  };
  return {
    getOrThrow: (key: string) => values[key],
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

function build(
  overrides: {
    config?: ConfigService;
    portal?: Partial<ApplePortalClient>;
    probes?: Partial<DomainProbeService>;
    repository?: Partial<DomainVerificationRepository>;
  } = {},
) {
  const calls: string[] = [];

  const portal = {
    registerDomain: jest.fn(async () => {
      calls.push('portal.registerDomain');
      return {
        suggestedFilename: 'apple-developer-merchantid-domain-association',
        content: 'x'.repeat(200),
        contentSha256: SHA,
        savedTo: '/tmp/file',
      };
    }),
    verifyDomain: jest.fn(async () => {
      calls.push('portal.verifyDomain');
      return { outcome: 'verified' as const };
    }),
    ...overrides.portal,
  };

  const probes = {
    probe: jest.fn(async () => {
      calls.push('probe');
      return { ok: true, attempts: 1, url: 'https://pay.example.com/x' };
    }),
    ...overrides.probes,
  };

  const repository = {
    upsert: jest.fn(async () => {
      calls.push('repository.upsert');
    }),
    recordProbe: jest.fn(async () => {
      calls.push('repository.recordProbe');
    }),
    markActive: jest.fn(async () => {
      calls.push('repository.markActive');
    }),
    markStatus: jest.fn(async () => {
      calls.push('repository.markStatus');
    }),
    findByDomain: jest.fn(async () => undefined),
    findServable: jest.fn(async () => undefined),
    softDelete: jest.fn(async () => true),
    findExpiringBefore: jest.fn(async () => []),
    ...overrides.repository,
  };

  const logger = { emit: jest.fn() } as unknown as AppLogger;

  const service = new DomainVerificationService(
    overrides.config ?? configWith(),
    logger,
    portal as unknown as ApplePortalClient,
    probes as unknown as DomainProbeService,
    repository as unknown as DomainVerificationRepository,
  );

  return { service, portal, probes, repository, calls };
}

describe('DomainVerificationService.register', () => {
  it('runs the flow in the order Apple requires', async () => {
    const { service, calls } = build();

    await service.register({ domain: 'pay.example.com' });

    // The file must be stored AND live before Apple is asked to fetch it —
    // Apple reads it from the domain, and the domain reads it from the table.
    expect(calls).toEqual([
      'portal.registerDomain',
      'repository.upsert',
      'probe',
      'repository.recordProbe',
      'portal.verifyDomain',
      'repository.markActive',
    ]);
  });

  it('normalizes the domain before it reaches the portal or the database', async () => {
    const { service, portal, repository } = build();

    await service.register({ domain: '  PAY.Example.com.  ' });

    expect(portal.registerDomain).toHaveBeenCalledWith('pay.example.com');
    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'pay.example.com' }),
    );
  });

  it('persists merchant and team identifiers from config', async () => {
    const { service, repository } = build();

    await service.register({ domain: 'pay.example.com', storeCode: 1042 });

    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        merchantId: 'merchant.phoenix.applepay8',
        appleTeamId: '64426BH9K3',
        storeCode: 1042,
        status: 'pending',
        contentSha256: SHA,
      }),
    );
  });

  it('stores a null store_code when none is supplied', async () => {
    const { service, repository } = build();

    await service.register({ domain: 'pay.example.com' });

    expect(repository.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ storeCode: null }),
    );
  });

  it('reports active when Apple confirms verification', async () => {
    const { service } = build();

    const result = await service.register({ domain: 'pay.example.com' });

    expect(result).toMatchObject({
      status: 'active',
      verification: 'verified',
    });
  });

  it('leaves the record pending when Apple gives no verdict', async () => {
    // Recording a failure we did not observe would send an operator chasing a
    // fault that may not exist.
    const { service, repository } = build({
      portal: {
        verifyDomain: jest.fn(async () => ({ outcome: 'unknown' as const })),
      },
    });

    const result = await service.register({ domain: 'pay.example.com' });

    expect(result).toMatchObject({
      status: 'pending',
      verification: 'unknown',
    });
    expect(repository.markActive).not.toHaveBeenCalled();
  });

  describe('when the association file is not live', () => {
    const failingProbe = {
      probe: jest.fn(async () => ({
        ok: false,
        attempts: 5,
        url: 'https://pay.example.com/.well-known/apple-developer-merchantid-domain-association',
        reason: 'http-error' as const,
        httpStatus: 404,
      })),
    };

    it('never asks Apple to verify', async () => {
      // A failed Apple verification is rate-limited and its error would not
      // mention the real cause.
      const { service, portal } = build({ probes: failingProbe });

      await expect(
        service.register({ domain: 'pay.example.com' }),
      ).rejects.toThrow(ConflictException);
      expect(portal.verifyDomain).not.toHaveBeenCalled();
    });

    it('keeps the downloaded file and marks the row failed', async () => {
      const { service, repository } = build({ probes: failingProbe });

      await expect(
        service.register({ domain: 'pay.example.com' }),
      ).rejects.toThrow();

      expect(repository.upsert).toHaveBeenCalled();
      expect(repository.recordProbe).toHaveBeenCalledWith(
        'pay.example.com',
        false,
      );
      expect(repository.markStatus).toHaveBeenCalledWith(
        'pay.example.com',
        'failed',
      );
    });

    it('tells the caller how to recover', async () => {
      const { service } = build({ probes: failingProbe });

      await expect(
        service.register({ domain: 'pay.example.com' }),
      ).rejects.toThrow(/reverify/);
    });
  });

  describe('skipVerify', () => {
    it('registers and stores without probing or verifying', async () => {
      const { service, calls, probes, portal } = build();

      const result = await service.register({
        domain: 'pay.example.com',
        skipVerify: true,
      });

      expect(calls).toEqual(['portal.registerDomain', 'repository.upsert']);
      expect(probes.probe).not.toHaveBeenCalled();
      expect(portal.verifyDomain).not.toHaveBeenCalled();
      expect(result.verification).toBe('skipped');
    });
  });

  describe('DOMAIN_PROBE_ENABLED=false', () => {
    it('goes straight to Apple verification', async () => {
      const { service, probes, portal } = build({
        config: configWith({ DOMAIN_PROBE_ENABLED: false }),
      });

      await service.register({ domain: 'pay.example.com' });

      expect(probes.probe).not.toHaveBeenCalled();
      expect(portal.verifyDomain).toHaveBeenCalled();
    });
  });

  describe('concurrency', () => {
    it('joins a second caller onto the in-flight run for the same domain', async () => {
      // Two runs would drive the portal twice and race on the same unique row.
      const { service, portal } = build();

      const [first, second] = await Promise.all([
        service.register({ domain: 'pay.example.com' }),
        service.register({ domain: 'PAY.example.com' }),
      ]);

      expect(portal.registerDomain).toHaveBeenCalledTimes(1);
      expect(first).toBe(second);
    });

    it('allows a later run once the first has settled', async () => {
      const { service, portal } = build();

      await service.register({ domain: 'pay.example.com' });
      await service.register({ domain: 'pay.example.com' });

      expect(portal.registerDomain).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight entry after a failure', async () => {
      const registerDomain = jest
        .fn()
        .mockRejectedValueOnce(new Error('portal down'))
        .mockResolvedValueOnce({
          suggestedFilename: 'f',
          content: 'x'.repeat(200),
          contentSha256: SHA,
          savedTo: '/tmp/f',
        });
      const { service } = build({ portal: { registerDomain } });

      await expect(
        service.register({ domain: 'pay.example.com' }),
      ).rejects.toThrow('portal down');
      // A leaked entry would make every later attempt replay the failure.
      await expect(
        service.register({ domain: 'pay.example.com' }),
      ).resolves.toMatchObject({ domain: 'pay.example.com' });
    });
  });
});

describe('DomainVerificationService.reverify', () => {
  const record = {
    id: 'id',
    domain: 'pay.example.com',
    storeCode: null,
    merchantId: 'merchant.phoenix.applepay8',
    verificationFile: 'x'.repeat(200),
    createdAt: null,
    updatedAt: null,
    appleTeamId: '64426BH9K3',
    appleDateCreated: null,
    verificationExpiresAt: '2027-08-01 00:00:00',
    status: 'pending' as const,
    contentSha256: SHA,
    lastProbeAt: null,
    lastProbeOk: null,
    lastVerifiedAt: null,
    isDeleted: false,
  };

  it('verifies the stored file without re-registering', async () => {
    const { service, portal, calls } = build({
      repository: { findByDomain: jest.fn(async () => record) },
    });

    await service.reverify('pay.example.com');

    expect(portal.registerDomain).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'probe',
      'repository.recordProbe',
      'portal.verifyDomain',
      'repository.markActive',
    ]);
  });

  it('refuses when the file is still not live', async () => {
    const { service, portal } = build({
      repository: { findByDomain: jest.fn(async () => record) },
      probes: {
        probe: jest.fn(async () => ({
          ok: false,
          attempts: 5,
          url: 'https://pay.example.com/x',
          reason: 'unreachable' as const,
        })),
      },
    });

    await expect(service.reverify('pay.example.com')).rejects.toThrow(
      ConflictException,
    );
    expect(portal.verifyDomain).not.toHaveBeenCalled();
  });

  it('refuses when there is no stored file to verify', async () => {
    const { service } = build({
      repository: {
        findByDomain: jest.fn(async () => ({ ...record, contentSha256: null })),
      },
    });

    await expect(service.reverify('pay.example.com')).rejects.toThrow(
      /no stored association file/,
    );
  });
});
