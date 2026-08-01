import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import {
  API_GLOBAL_PREFIX,
  DOMAIN_ASSOCIATION_PATH,
  REQUEST_ID_HEADER,
} from '../src/common/constants';
import { resolveTrustProxy } from '../src/common/trust-proxy';
import { MysqlService } from '../src/database/mysql.service';
import { DomainVerificationRepository } from '../src/domain-verification/domain-verification.repository';
import { ReadinessRegistry } from '../src/health/readiness-registry';

/** Matches API_KEY in test/setup-e2e-env.ts. */
const API_KEY = 'e2e-test-api-key-0123456789abcdef';

/** Flipped per-test to drive the readiness probe. */
const mysqlHealthy = jest.fn(async () => true);

const repository = {
  findByDomain: jest.fn(),
  findServable: jest.fn(),
  upsert: jest.fn(),
  recordProbe: jest.fn(),
  markActive: jest.fn(),
  markStatus: jest.fn(),
  softDelete: jest.fn(),
  findExpiringBefore: jest.fn(async () => []),
};

/**
 * Build the app the way `main.ts` does — global prefix and its exclusion, the
 * validation pipe, and `trust proxy`. Anything asserted here has to be configured
 * the same way the real bootstrap configures it, or the test proves nothing about
 * production.
 *
 * MySQL is stubbed: this suite must never touch the shared database, and the
 * repository's SQL is asserted directly in its own spec.
 */
async function createApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    // Same lifecycle shape as the real service: no pool is created, and the
    // readiness probe reports healthy so /readyz can be asserted.
    .overrideProvider(MysqlService)
    .useValue({
      name: 'mysql',
      onModuleInit: () => undefined,
      onModuleDestroy: async () => undefined,
      check: mysqlHealthy,
      query: async () => [],
      execute: async () => ({ affectedRows: 1 }),
    })
    .overrideProvider(DomainVerificationRepository)
    .useValue(repository)
    .compile();

  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: [DOMAIN_ASSOCIATION_PATH],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.set('trust proxy', resolveTrustProxy(process.env.TRUST_PROXY));
  await app.init();

  // The stubbed MysqlService cannot register its own readiness probe (the real
  // one does that in onModuleInit, using the pool it never creates here), so
  // register a stand-in. Without this the registry holds zero probes and every
  // /readyz assertion passes vacuously — reporting "ready" because nothing was
  // checked rather than because everything was healthy.
  app.get(ReadinessRegistry).register({ name: 'mysql', check: mysqlHealthy });

  return app;
}

describe('API surface (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mysqlHealthy.mockResolvedValue(true);
  });

  /**
   * POST /domain-verifications is capped at 5/min per client because each call
   * drives a real Apple session. The throttler keys on `req.ip`, and `trust proxy`
   * makes that the X-Forwarded-For value — so giving each test its own source IP
   * gives it its own bucket. Tests stay independent of each other's call counts,
   * and the limiter is left switched ON rather than mocked away.
   */
  let clientIpCounter = 0;
  const fromFreshClient = () => {
    clientIpCounter += 1;
    return request(app.getHttpServer())
      .post(`/${API_GLOBAL_PREFIX}/domain-verifications`)
      .set('x-forwarded-for', `10.1.0.${clientIpCounter}`);
  };

  describe('health', () => {
    it('serves liveness under the global prefix', async () => {
      const response = await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/healthz`)
        .expect(200);

      expect(response.body).toMatchObject({ status: 'ok' });
      expect(typeof response.body.uptimeSec).toBe('number');
    });

    it('reports ready when every probe passes', async () => {
      const response = await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/readyz`)
        .expect(200);

      expect(response.body).toEqual({
        status: 'ready',
        checks: { mysql: 'ok' },
      });
    });

    it('returns 503 AND the per-probe detail when a dependency is down', async () => {
      // The detail is the whole value of this endpoint. It previously threw an
      // HttpException, which AllExceptionsFilter reshaped into the standard
      // error envelope — discarding `checks` and reporting the cause as
      // "Internal server error".
      mysqlHealthy.mockResolvedValue(false);

      const response = await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/readyz`)
        .expect(503);

      expect(response.body).toEqual({
        status: 'degraded',
        checks: { mysql: 'fail' },
      });
    });

    it('keeps liveness green while readiness is degraded', async () => {
      // Restarting a pod because MySQL flapped turns a partial outage into a
      // total one, so liveness must not consult a dependency.
      mysqlHealthy.mockResolvedValue(false);

      await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/healthz`)
        .expect(200);
    });

    it('does not serve health at the root', async () => {
      await request(app.getHttpServer()).get('/healthz').expect(404);
    });
  });

  describe('correlation id', () => {
    it('echoes a safe inbound id', async () => {
      const response = await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/healthz`)
        .set(REQUEST_ID_HEADER, 'trace-abc-123');

      expect(response.headers[REQUEST_ID_HEADER]).toBe('trace-abc-123');
    });

    it('mints one when absent', async () => {
      const response = await request(app.getHttpServer()).get(
        `/${API_GLOBAL_PREFIX}/healthz`,
      );

      expect(response.headers[REQUEST_ID_HEADER]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe('error shape', () => {
    it('returns the standard body for an unmatched route', async () => {
      const response = await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/does-not-exist`)
        .expect(404);

      expect(response.body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        path: `/${API_GLOBAL_PREFIX}/does-not-exist`,
      });
      expect(response.body.requestId).toBeDefined();
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('access control', () => {
    it('rejects a write with no API key', async () => {
      // These routes register domains on a live merchant identifier.
      await fromFreshClient().send({ domain: 'pay.example.com' }).expect(401);
    });

    it('rejects a write with a wrong API key', async () => {
      await fromFreshClient()
        .set('x-api-key', 'wrong-key-0123456789abcdefghijkl')
        .send({ domain: 'pay.example.com' })
        .expect(401);
    });

    it('runs the guard before the validation pipe', async () => {
      // An unauthenticated caller must not be able to map the request schema by
      // watching which fields the validator complains about.
      const response = await fromFreshClient()
        .send({ nonsense: true })
        .expect(401);

      expect(response.body.message).toBe('Invalid or missing API key');
    });

    it('leaves the health probes unauthenticated', async () => {
      await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}/healthz`)
        .expect(200);
    });
  });

  describe('request validation', () => {
    const authed = () => fromFreshClient().set('x-api-key', API_KEY);

    it('rejects a missing required field', async () => {
      const response = await authed().send({}).expect(400);

      expect(response.body.message.join(' ')).toContain('domain');
    });

    it('rejects an unknown property instead of ignoring it', async () => {
      // A caller sending `verify` when the field is `skipVerify` must be told,
      // not silently have their intent dropped.
      const response = await authed()
        .send({ domain: 'pay.example.com', verify: true })
        .expect(400);

      expect(response.body.message.join(' ')).toMatch(/verify/);
    });

    it('rejects a malformed domain before any portal interaction', async () => {
      const response = await authed()
        .send({ domain: 'https://pay.example.com/checkout' })
        .expect(400);

      expect(JSON.stringify(response.body)).toMatch(/scheme|path/);
    });
  });

  describe('rate limiting', () => {
    it('caps repeated writes from one client at 5 per minute', async () => {
      // The binding constraint is Apple's tolerance, not ours: each accepted
      // call launches a browser and consumes a portal interaction. Rejected
      // requests count too, which is what makes this useful against a retry loop.
      const post = () =>
        request(app.getHttpServer())
          .post(`/${API_GLOBAL_PREFIX}/domain-verifications`)
          .set('x-forwarded-for', '10.9.9.9')
          .set('x-api-key', API_KEY)
          .send({ domain: 'nope' });

      const statuses: number[] = [];
      for (let i = 0; i < 6; i += 1) {
        statuses.push((await post()).status);
      }

      expect(statuses.slice(0, 5)).not.toContain(429);
      expect(statuses[5]).toBe(429);
    });

    it('gives each client its own budget, so trust proxy is wired', async () => {
      // Without `trust proxy`, req.ip would be the load balancer for every
      // request and one noisy caller would exhaust the limit for everyone.
      await request(app.getHttpServer())
        .post(`/${API_GLOBAL_PREFIX}/domain-verifications`)
        .set('x-forwarded-for', '10.8.8.8')
        .set('x-api-key', API_KEY)
        .send({ domain: 'nope' })
        .expect(400);
    });

    it('exempts the health probes', async () => {
      // A 429 on /readyz would drain a healthy pod from rotation.
      for (let i = 0; i < 8; i += 1) {
        await request(app.getHttpServer())
          .get(`/${API_GLOBAL_PREFIX}/healthz`)
          .set('x-forwarded-for', '10.7.7.7')
          .expect(200);
      }
    });

    it('exempts the .well-known route', async () => {
      // Apple must always be able to fetch the association file.
      repository.findServable.mockResolvedValue({
        domain: '127.0.0.1',
        verificationFile: 'association-file-contents',
        status: 'active',
        isDeleted: false,
      });

      for (let i = 0; i < 8; i += 1) {
        await request(app.getHttpServer())
          .get(DOMAIN_ASSOCIATION_PATH)
          .set('x-forwarded-for', '10.6.6.6')
          .expect(200);
      }
    });
  });

  describe('.well-known association file', () => {
    it('is served at the domain root, outside the API prefix', async () => {
      // Apple fetches this exact path. Under /api it would 404 and every
      // verification would fail.
      repository.findServable.mockResolvedValue({
        domain: '127.0.0.1',
        verificationFile: 'association-file-contents',
        status: 'active',
        isDeleted: false,
      });

      const response = await request(app.getHttpServer())
        .get(DOMAIN_ASSOCIATION_PATH)
        .expect(200);

      expect(response.text).toBe('association-file-contents');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('404s when no record is registered for the host', async () => {
      repository.findServable.mockResolvedValue(undefined);

      await request(app.getHttpServer())
        .get(DOMAIN_ASSOCIATION_PATH)
        .expect(404);
    });

    it('is not also served under the API prefix', async () => {
      await request(app.getHttpServer())
        .get(`/${API_GLOBAL_PREFIX}${DOMAIN_ASSOCIATION_PATH}`)
        .expect(404);
    });
  });
});
