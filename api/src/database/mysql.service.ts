import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import {
  createPool,
  type Pool,
  type PoolOptions,
  type ResultSetHeader,
  type RowDataPacket,
} from 'mysql2/promise';
import { AppLogger } from '../observability/app-logger';
import {
  ReadinessRegistry,
  type ReadinessProbe,
} from '../health/readiness-registry';

/**
 * A value that can be bound to a placeholder in a prepared statement.
 *
 * Narrower than `unknown` on purpose: it is what the driver actually accepts, so
 * passing an object or an array (which mysql2 would expand in ways the caller
 * probably did not intend) is a compile error rather than a runtime surprise.
 */
export type SqlParam = string | number | boolean | Date | Buffer | null;

/**
 * MySQL access for the `apple_pay_domain_verifications` table.
 *
 * Deliberately a thin pool + parameterized SQL rather than an ORM. This service
 * writes to a database it does not own (`phoenix_release`, shared with the CRM
 * backend), and every ORM ships some form of schema synchronisation that is one
 * config flag away from altering a table another team depends on. There is no
 * migration runner in this repo for the same reason: the table already exists.
 */
@Injectable()
export class MysqlService
  implements OnModuleInit, OnModuleDestroy, ReadinessProbe
{
  readonly name = 'mysql';

  private pool: Pool | undefined;

  constructor(
    private readonly config: ConfigService,
    private readonly logger: AppLogger,
    private readonly readiness: ReadinessRegistry,
  ) {}

  onModuleInit(): void {
    this.pool = createPool(this.buildPoolOptions());
    this.readiness.register(this);
    this.logger.emit('info', 'MySQL pool created', {
      host: this.config.getOrThrow<string>('DB_HOST'),
      database: this.config.getOrThrow<string>('DB_NAME'),
      poolSize: this.config.get<number>('DB_POOL_SIZE'),
      // Log whether TLS is on, never the credential that travels over it.
      tls: this.tlsOptions() !== undefined,
    });
    // Not awaited. mysql2 pools connect lazily, so without a warm-up the FIRST
    // query pays the TCP + TLS handshake — which for a cross-region cluster can
    // exceed the readiness probe's timebox and make a healthy pod report
    // degraded immediately after boot.
    //
    // Deliberately fire-and-forget: boot must not depend on the database being
    // reachable. A pod that starts and reports NOT ready is diagnosable; a pod
    // that refuses to start is a CrashLoopBackOff with the same root cause and
    // less information.
    void this.warmUp();
  }

  private async warmUp(): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.query<RowDataPacket>('SELECT 1 AS ok');
      this.logger.emit('info', 'MySQL pool warm', {
        elapsedMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Warn, not error: /readyz is the authority on whether this matters, and
      // it will report `mysql: fail` for as long as it does.
      this.logger.emit(
        'warn',
        'MySQL warm-up failed; pod will report not-ready',
        {
          elapsedMs: Date.now() - startedAt,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    // Drain rather than drop: an in-flight verification write must land before
    // the process exits, or the portal shows a registered domain with no row
    // backing it and the association file stops being served.
    await this.pool?.end();
    this.pool = undefined;
  }

  /** Readiness probe: a round trip proves the credential and route both work. */
  async check(): Promise<boolean> {
    try {
      const rows = await this.query<RowDataPacket>('SELECT 1 AS ok');
      return rows.length === 1;
    } catch (error) {
      this.logger.emit('warn', 'MySQL readiness probe failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * `execute`, not `query`: it uses a prepared statement, so values are bound by
   * the server and never interpolated into SQL text.
   */
  async query<T extends RowDataPacket>(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<T[]> {
    const [rows] = await this.requirePool().execute<T[]>(sql, [...params]);
    return rows;
  }

  async execute(
    sql: string,
    params: readonly SqlParam[] = [],
  ): Promise<ResultSetHeader> {
    const [result] = await this.requirePool().execute<ResultSetHeader>(sql, [
      ...params,
    ]);
    return result;
  }

  private requirePool(): Pool {
    if (this.pool === undefined) {
      throw new Error(
        'MySQL pool is not initialised — MysqlService used before onModuleInit or after shutdown',
      );
    }
    return this.pool;
  }

  private buildPoolOptions(): PoolOptions {
    const tls = this.tlsOptions();
    return {
      host: this.config.getOrThrow<string>('DB_HOST'),
      port: this.config.getOrThrow<number>('DB_PORT'),
      database: this.config.getOrThrow<string>('DB_NAME'),
      user: this.config.getOrThrow<string>('DB_USER'),
      password: this.config.getOrThrow<string>('DB_PASSWORD'),
      connectionLimit: this.config.getOrThrow<number>('DB_POOL_SIZE'),
      connectTimeout: this.config.getOrThrow<number>('DB_CONNECT_TIMEOUT_MS'),
      waitForConnections: true,
      // Bound the queue: an unbounded one turns a slow database into unbounded
      // memory growth and a pod that gets OOM-killed instead of shedding load.
      queueLimit: 50,
      enableKeepAlive: true,
      // DATETIME columns come back as strings rather than Date objects. The
      // driver's Date conversion applies the *process* timezone to a value the
      // server stored without one, which silently shifts every timestamp.
      dateStrings: true,
      // Reject multiple statements per query. This is the mitigation that holds
      // even if a future call site builds SQL by concatenation.
      multipleStatements: false,
      ...(tls === undefined ? {} : { ssl: tls }),
    };
  }

  private tlsOptions(): PoolOptions['ssl'] {
    // Defaults ON. A default-off TLS setting is a plaintext password on the
    // first deployment where someone forgets the flag.
    if (this.config.get<boolean>('DB_SSL') === false) return undefined;

    const caPath = this.config.get<string>('DB_SSL_CA_PATH');
    return {
      minVersion: 'TLSv1.2',
      // Verification stays on. A managed cluster with an unverifiable
      // certificate is a configuration problem to fix with DB_SSL_CA_PATH, not
      // one to switch off.
      rejectUnauthorized: true,
      ...(caPath === undefined ? {} : { ca: readFileSync(caPath, 'utf8') }),
    };
  }
}
