import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { MysqlService } from '../database/mysql.service';
import type {
  DomainVerificationRecord,
  UpsertVerificationInput,
  VerificationStatus,
} from './domain-verification.types';

/**
 * The only table this service touches. Named once so a search for writes to it
 * finds every one of them.
 */
const TABLE = 'apple_pay_domain_verifications';

/**
 * Every column, in table order. Spelled out rather than `SELECT *` so a column
 * added by the team that owns this table cannot change what this code reads.
 */
const COLUMNS = `
  id, domain, store_code, merchant_id, verification_file, created_at, updated_at,
  apple_team_id, apple_date_created, verification_expires_at, status,
  content_sha256, last_probe_at, last_probe_ok, last_verified_at, is_deleted
`;

interface VerificationRow extends RowDataPacket {
  id: string;
  domain: string;
  store_code: number | string | null;
  merchant_id: string | null;
  verification_file: string;
  created_at: string | null;
  updated_at: string | null;
  apple_team_id: string | null;
  apple_date_created: string | null;
  verification_expires_at: string | null;
  status: VerificationStatus;
  content_sha256: string | null;
  last_probe_at: string | null;
  last_probe_ok: number | null;
  last_verified_at: string | null;
  is_deleted: number;
}

/**
 * Persistence for Apple Pay domain verifications.
 *
 * Two deliberate constraints, both because this table is shared with the CRM
 * backend and this service is a guest in its schema:
 *   1. No DELETE anywhere. `is_deleted` exists; a hard delete would drop an
 *      association file the CRM may still be serving.
 *   2. Every statement is parameterized and names its columns explicitly. There
 *      is no query builder to accidentally widen a WHERE clause.
 *
 * DATETIME columns are written with `UTC_TIMESTAMP()` / explicit UTC strings.
 * The columns carry no timezone, so consistency is the only thing that makes
 * `idx_expiry` comparisons mean anything.
 */
@Injectable()
export class DomainVerificationRepository {
  constructor(private readonly mysql: MysqlService) {}

  async findByDomain(
    domain: string,
  ): Promise<DomainVerificationRecord | undefined> {
    const rows = await this.mysql.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM ${TABLE} WHERE domain = ? LIMIT 1`,
      [domain],
    );
    return rows.length === 0 ? undefined : toRecord(rows[0]);
  }

  /** The row to serve `/.well-known/...` from: present, live, not soft-deleted. */
  async findServable(
    domain: string,
  ): Promise<DomainVerificationRecord | undefined> {
    const rows = await this.mysql.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE domain = ? AND is_deleted = 0 AND status IN ('pending', 'active')
        LIMIT 1`,
      [domain],
    );
    return rows.length === 0 ? undefined : toRecord(rows[0]);
  }

  /**
   * Insert the verification, or update it in place when the domain is already
   * present.
   *
   * `domain` is UNIQUE, so there can only ever be one row per domain — a second
   * registration replaces the association file rather than creating a history.
   * `created_at` and `apple_date_created` are left alone on update so first-seen
   * stays first-seen.
   *
   * The UPDATE clause re-binds each value rather than using `VALUES(col)`, which
   * MySQL deprecated in 8.0.20.
   */
  async upsert(input: UpsertVerificationInput): Promise<void> {
    const expiresAt =
      input.verificationExpiresAt === null
        ? null
        : toMysqlUtc(input.verificationExpiresAt);
    await this.mysql.execute(
      `INSERT INTO ${TABLE}
         (id, domain, store_code, merchant_id, verification_file, created_at,
          updated_at, apple_team_id, apple_date_created, verification_expires_at,
          status, content_sha256, is_deleted)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), UTC_TIMESTAMP(), ?,
               UTC_TIMESTAMP(), ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         store_code = ?,
         merchant_id = ?,
         verification_file = ?,
         updated_at = UTC_TIMESTAMP(),
         apple_team_id = ?,
         verification_expires_at = ?,
         status = ?,
         content_sha256 = ?,
         is_deleted = 0`,
      [
        // INSERT
        randomUUID(),
        input.domain,
        input.storeCode,
        input.merchantId,
        input.verificationFile,
        input.appleTeamId,
        expiresAt,
        input.status,
        input.contentSha256,
        // ON DUPLICATE KEY UPDATE
        input.storeCode,
        input.merchantId,
        input.verificationFile,
        input.appleTeamId,
        expiresAt,
        input.status,
        input.contentSha256,
      ],
    );
  }

  async recordProbe(domain: string, ok: boolean): Promise<void> {
    await this.mysql.execute(
      `UPDATE ${TABLE}
          SET last_probe_at = UTC_TIMESTAMP(), last_probe_ok = ?,
              updated_at = UTC_TIMESTAMP()
        WHERE domain = ?`,
      [ok ? 1 : 0, domain],
    );
  }

  /**
   * Mark verified, recording Apple's own expiry when one could be read.
   *
   * `COALESCE(?, verification_expires_at)` rather than a plain assignment: a null
   * means the scrape failed, and overwriting a previously-good Apple date with
   * NULL would both discard real information and drop the row out of
   * `findExpiringBefore`, which filters on `IS NOT NULL`. A stale real date stays
   * visible and fixable; a NULL is invisible.
   */
  async markActive(
    domain: string,
    verificationExpiresAt: Date | null,
  ): Promise<void> {
    await this.mysql.execute(
      `UPDATE ${TABLE}
          SET status = 'active', last_verified_at = UTC_TIMESTAMP(),
              verification_expires_at = COALESCE(?, verification_expires_at),
              updated_at = UTC_TIMESTAMP()
        WHERE domain = ?`,
      [
        verificationExpiresAt === null
          ? null
          : toMysqlUtc(verificationExpiresAt),
        domain,
      ],
    );
  }

  async markStatus(domain: string, status: VerificationStatus): Promise<void> {
    await this.mysql.execute(
      `UPDATE ${TABLE}
          SET status = ?, updated_at = UTC_TIMESTAMP()
        WHERE domain = ?`,
      [status, domain],
    );
  }

  /** Soft delete only — see the class comment. */
  async softDelete(domain: string): Promise<boolean> {
    const result = await this.mysql.execute(
      `UPDATE ${TABLE}
          SET is_deleted = 1, updated_at = UTC_TIMESTAMP()
        WHERE domain = ? AND is_deleted = 0`,
      [domain],
    );
    return result.affectedRows > 0;
  }

  /**
   * Rows due for renewal. Ordered by expiry so a capped sweep always takes the
   * most urgent first — the column order matches `idx_expiry`
   * (verification_expires_at, is_deleted), so this uses the index.
   */
  async findExpiringBefore(
    cutoff: Date,
    limit: number,
  ): Promise<DomainVerificationRecord[]> {
    const rows = await this.mysql.query<VerificationRow>(
      `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE verification_expires_at IS NOT NULL
          AND verification_expires_at <= ?
          AND is_deleted = 0
        ORDER BY verification_expires_at ASC
        LIMIT ?`,
      [toMysqlUtc(cutoff), limit],
    );
    return rows.map(toRecord);
  }
}

/**
 * Format as `YYYY-MM-DD HH:MM:SS` in UTC. `toISOString().slice(0, 19)` is
 * already UTC; only the `T` needs replacing.
 */
export function toMysqlUtc(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function toRecord(row: VerificationRow): DomainVerificationRecord {
  return {
    id: row.id,
    domain: row.domain,
    // BIGINT arrives as a string once it exceeds the safe-integer range; the
    // driver returns whichever fits. Normalize to number|null at the boundary.
    storeCode: row.store_code === null ? null : Number(row.store_code),
    merchantId: row.merchant_id,
    verificationFile: row.verification_file,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appleTeamId: row.apple_team_id,
    appleDateCreated: row.apple_date_created,
    verificationExpiresAt: row.verification_expires_at,
    status: row.status,
    contentSha256: row.content_sha256,
    lastProbeAt: row.last_probe_at,
    lastProbeOk: row.last_probe_ok === null ? null : row.last_probe_ok === 1,
    lastVerifiedAt: row.last_verified_at,
    isDeleted: row.is_deleted === 1,
  };
}
