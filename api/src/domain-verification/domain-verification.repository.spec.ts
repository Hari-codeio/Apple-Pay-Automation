import type { MysqlService } from '../database/mysql.service';
import {
  DomainVerificationRepository,
  toMysqlUtc,
} from './domain-verification.repository';

interface FakeMysql {
  query: jest.Mock;
  execute: jest.Mock;
}

function fakeMysql(): FakeMysql {
  return {
    query: jest.fn().mockResolvedValue([]),
    execute: jest.fn().mockResolvedValue({ affectedRows: 1 }),
  };
}

const ROW = {
  id: '3f1c1d84-0000-4000-8000-000000000000',
  domain: 'pay.example.com',
  store_code: '9007199254740993',
  merchant_id: 'merchant.phoenix.applepay8',
  verification_file: 'token-contents',
  created_at: '2026-08-01 10:00:00',
  updated_at: '2026-08-01 10:00:00',
  apple_team_id: '64426BH9K3',
  apple_date_created: '2026-08-01 10:00:00',
  verification_expires_at: '2027-08-01 10:00:00',
  status: 'active' as const,
  content_sha256: 'f'.repeat(64),
  last_probe_at: '2026-08-01 10:05:00',
  last_probe_ok: 1,
  last_verified_at: '2026-08-01 10:06:00',
  is_deleted: 0,
};

describe('toMysqlUtc', () => {
  it('formats as a UTC DATETIME literal', () => {
    expect(toMysqlUtc(new Date('2026-08-01T10:20:30.456Z'))).toBe(
      '2026-08-01 10:20:30',
    );
  });
});

describe('DomainVerificationRepository', () => {
  let mysql: FakeMysql;
  let repository: DomainVerificationRepository;

  beforeEach(() => {
    mysql = fakeMysql();
    repository = new DomainVerificationRepository(
      mysql as unknown as MysqlService,
    );
  });

  describe('findByDomain', () => {
    it('returns undefined when the domain is absent', async () => {
      await expect(
        repository.findByDomain('absent.example.com'),
      ).resolves.toBeUndefined();
    });

    it('maps a row into the record shape', async () => {
      mysql.query.mockResolvedValue([ROW]);

      const record = await repository.findByDomain('pay.example.com');

      expect(record).toMatchObject({
        id: ROW.id,
        domain: 'pay.example.com',
        status: 'active',
        // tinyint(1) becomes a real boolean at the boundary, not a 0/1 number.
        lastProbeOk: true,
        isDeleted: false,
      });
    });

    it('normalizes a BIGINT store_code arriving as a string', async () => {
      mysql.query.mockResolvedValue([ROW]);

      const record = await repository.findByDomain('pay.example.com');

      expect(typeof record?.storeCode).toBe('number');
    });

    it('preserves a null store_code as null rather than 0', async () => {
      // Number(null) is 0, which would invent a store that does not exist.
      mysql.query.mockResolvedValue([{ ...ROW, store_code: null }]);

      const record = await repository.findByDomain('pay.example.com');

      expect(record?.storeCode).toBeNull();
    });

    it('preserves a null last_probe_ok as null rather than false', async () => {
      // null means "never probed"; false means "probed and failed".
      mysql.query.mockResolvedValue([{ ...ROW, last_probe_ok: null }]);

      const record = await repository.findByDomain('pay.example.com');

      expect(record?.lastProbeOk).toBeNull();
    });

    it('parameterizes the domain instead of interpolating it', async () => {
      await repository.findByDomain("pay.example.com' OR '1'='1");

      const [sql, params] = mysql.query.mock.calls[0];
      expect(sql).toContain('domain = ?');
      expect(params).toEqual(["pay.example.com' OR '1'='1"]);
    });
  });

  describe('findServable', () => {
    it('excludes soft-deleted and non-serving rows', async () => {
      await repository.findServable('pay.example.com');

      const [sql] = mysql.query.mock.calls[0];
      expect(sql).toContain('is_deleted = 0');
      expect(sql).toContain("status IN ('pending', 'active')");
    });
  });

  describe('upsert', () => {
    const input = {
      domain: 'pay.example.com',
      storeCode: 1042,
      merchantId: 'merchant.phoenix.applepay8',
      appleTeamId: '64426BH9K3',
      verificationFile: 'token-contents',
      contentSha256: 'a'.repeat(64),
      status: 'pending' as const,
      verificationExpiresAt: new Date('2027-08-01T00:00:00.000Z'),
    };

    it('inserts with an ON DUPLICATE KEY UPDATE clause', async () => {
      // `domain` is UNIQUE, so a re-registration must update in place rather
      // than violate the constraint.
      await repository.upsert(input);

      const [sql] = mysql.execute.mock.calls[0];
      expect(sql).toContain('INSERT INTO apple_pay_domain_verifications');
      expect(sql).toContain('ON DUPLICATE KEY UPDATE');
    });

    it('does not use the deprecated VALUES() function in the update clause', async () => {
      await repository.upsert(input);

      const [sql] = mysql.execute.mock.calls[0];
      expect(sql).not.toMatch(/=\s*VALUES\(/i);
    });

    it('leaves created_at and apple_date_created untouched on update', async () => {
      // First-seen must stay first-seen across re-registrations.
      await repository.upsert(input);

      const [sql] = mysql.execute.mock.calls[0];
      const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
      expect(updateClause).not.toContain('created_at');
      expect(updateClause).not.toContain('apple_date_created');
    });

    it('generates a UUID id and formats the expiry as a UTC DATETIME', async () => {
      await repository.upsert(input);

      const [, params] = mysql.execute.mock.calls[0];
      expect(params[0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(params).toContain('2027-08-01 00:00:00');
    });

    it('binds NULL when there is no expiry yet', async () => {
      // Registration happens before Apple verifies, and Apple only publishes an
      // expiry once it has. A computed placeholder here is what this replaced.
      await repository.upsert({ ...input, verificationExpiresAt: null });

      const [, params] = mysql.execute.mock.calls[0];
      expect(params).toContain(null);
      expect(params).not.toContain('2027-08-01 00:00:00');
    });

    it('clears is_deleted so re-registering revives a soft-deleted row', async () => {
      await repository.upsert(input);

      const [sql] = mysql.execute.mock.calls[0];
      const updateClause = sql.slice(sql.indexOf('ON DUPLICATE KEY UPDATE'));
      expect(updateClause).toContain('is_deleted = 0');
    });
  });

  describe('recordProbe', () => {
    it('stores the tinyint form of the boolean', async () => {
      await repository.recordProbe('pay.example.com', true);
      expect(mysql.execute.mock.calls[0][1]).toEqual([1, 'pay.example.com']);

      await repository.recordProbe('pay.example.com', false);
      expect(mysql.execute.mock.calls[1][1]).toEqual([0, 'pay.example.com']);
    });
  });

  describe('softDelete', () => {
    it('updates rather than deletes', async () => {
      // A hard delete would drop an association file the CRM may still serve.
      await repository.softDelete('pay.example.com');

      const [sql] = mysql.execute.mock.calls[0];
      expect(sql).toContain('UPDATE');
      expect(sql).toContain('is_deleted = 1');
      expect(sql).not.toContain('DELETE');
    });

    it('reports false when no row was affected', async () => {
      mysql.execute.mockResolvedValue({ affectedRows: 0 });
      await expect(repository.softDelete('absent.example.com')).resolves.toBe(
        false,
      );
    });
  });

  describe('markActive', () => {
    it('writes the expiry Apple published, as a UTC DATETIME', async () => {
      await repository.markActive(
        'pay.example.com',
        new Date('2026-10-28T00:00:00.000Z'),
      );

      const [sql, params] = mysql.execute.mock.calls[0];
      expect(sql).toContain("status = 'active'");
      expect(params).toEqual(['2026-10-28 00:00:00', 'pay.example.com']);
    });

    it('preserves an existing expiry when the portal date could not be read', async () => {
      // Overwriting a real Apple date with NULL would both lose information and
      // drop the row out of findExpiringBefore, which filters on IS NOT NULL.
      await repository.markActive('pay.example.com', null);

      const [sql, params] = mysql.execute.mock.calls[0];
      expect(sql).toContain(
        'verification_expires_at = COALESCE(?, verification_expires_at)',
      );
      expect(params).toEqual([null, 'pay.example.com']);
    });
  });

  it('issues no DELETE statement anywhere', async () => {
    await repository.softDelete('pay.example.com');
    await repository.markActive('pay.example.com', null);
    await repository.markStatus('pay.example.com', 'failed');
    await repository.recordProbe('pay.example.com', true);

    for (const [sql] of mysql.execute.mock.calls) {
      expect(sql).not.toMatch(/\bDELETE\b/i);
    }
  });

  describe('findExpiringBefore', () => {
    it('orders by expiry and bounds the result set', async () => {
      await repository.findExpiringBefore(
        new Date('2026-08-01T00:00:00.000Z'),
        25,
      );

      const [sql, params] = mysql.query.mock.calls[0];
      expect(sql).toContain('ORDER BY verification_expires_at ASC');
      expect(sql).toContain('LIMIT ?');
      expect(params).toEqual(['2026-08-01 00:00:00', 25]);
    });
  });
});
