import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json, urlencoded } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import {
  API_GLOBAL_PREFIX,
  DOMAIN_ASSOCIATION_PATH,
  isDevLikeTier,
} from './common/constants';
import {
  createCorsOriginCallback,
  parseAllowedOrigins,
} from './common/cors-origin';
import { API_KEY_HEADER } from './common/guards/api-key.guard';
import { resolveTrustProxy } from './common/trust-proxy';
import { AppLogger, createBootstrapLogger } from './observability/app-logger';

/**
 * Process-level handlers for the two failures Nest's shutdown hooks do not
 * cover. Node's default for both is to print to stderr and exit, which skips the
 * graceful path and leaves the MySQL pool half-open and any Playwright browser
 * orphaned. Re-emitting SIGTERM routes them through the same lifecycle the
 * orchestrator would drive.
 */
function installProcessErrorHandlers(logger: AppLogger): void {
  process.on('unhandledRejection', (reason) => {
    try {
      logger.emit('fatal', 'Unhandled promise rejection', {
        reason:
          reason instanceof Error
            ? (reason.stack ?? reason.message)
            : String(reason),
      });
      process.emit('SIGTERM');
    } catch {
      process.exit(1);
    }
  });
  process.on('uncaughtException', (error) => {
    try {
      logger.emit('fatal', 'Uncaught exception', {
        reason: error.stack ?? error.message,
      });
      process.emit('SIGTERM');
    } catch {
      process.exit(1);
    }
  });
}

async function bootstrap(): Promise<void> {
  const bootstrapLogger = createBootstrapLogger();
  installProcessErrorHandlers(bootstrapLogger);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Buffer until the DI logger is installed, so a module that throws during
    // initialization still produces a structured line.
    bufferLogs: true,
    logger: bootstrapLogger,
    // Nest's built-in parser would run first with its own 100kb limit, making
    // BODY_LIMIT a lie. Disabled here and registered explicitly below.
    bodyParser: false,
  });
  app.useLogger(app.get(AppLogger));

  const config = app.get(ConfigService);
  const environment = config.getOrThrow<string>('ENVIRONMENT');
  const devLike = isDevLikeTier(environment);
  const logger = new Logger('Bootstrap');

  // Propagate SIGTERM/SIGINT into Nest's lifecycle so OnModuleDestroy runs: the
  // MySQL pool drains and an in-flight verification write lands before exit.
  app.enableShutdownHooks();

  // Security headers. `hidePoweredBy` also drops the Express fingerprint.
  app.use(helmet());

  const bodyLimit = config.getOrThrow<string>('BODY_LIMIT');
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ limit: bodyLimit, extended: true }));

  // Apple fetches the association file from the domain ROOT. Under the /api
  // prefix it would 404 and every verification would fail.
  app.setGlobalPrefix(API_GLOBAL_PREFIX, {
    exclude: [DOMAIN_ASSOCIATION_PATH],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip unknown properties AND reject them: a caller sending `verify: true`
      // when the field is `skipVerify` should be told, not silently ignored.
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Implicit conversion coerces by declared type and would turn the string
      // "false" into the boolean true. DTOs opt in per field with @Type.
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  const allowedOrigins = parseAllowedOrigins(
    config.get<string>('CORS_ALLOWED_ORIGINS'),
  );
  if (devLike && allowedOrigins.length === 0) {
    logger.warn('CORS is open — local development mode active');
  }
  app.enableCors({
    origin: createCorsOriginCallback({
      // The boot schema refuses an empty allowlist outside dev-like tiers, so
      // this can only be true on a developer machine.
      allowAll: devLike && allowedOrigins.length === 0,
      allowedOrigins,
      onDenied: (origin) =>
        logger.warn(`Blocked cross-origin request from '${origin}'`),
    }),
    credentials: true,
    maxAge: 600,
  });

  // Without this, req.ip is the load balancer's address: the per-IP throttler
  // collapses into one global bucket and every access-log line names the same
  // client. See resolveTrustProxy for why the string form matters.
  app.set('trust proxy', resolveTrustProxy(config.get<string>('TRUST_PROXY')));

  const swaggerEnabled = config.get<boolean>('SWAGGER_ENABLED') ?? devLike;
  if (swaggerEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Apple Pay Automation')
        .setDescription(
          'Apple Pay merchant domain registration and verification.',
        )
        .setVersion('0.1.0')
        // The header name comes from the guard that enforces it, so the docs
        // cannot drift from the implementation.
        .addApiKey(
          { type: 'apiKey', name: API_KEY_HEADER, in: 'header' },
          'api-key',
        )
        .build(),
    );
    SwaggerModule.setup('docs', app, document, {
      swaggerOptions: { servers: [{ url: `/${API_GLOBAL_PREFIX}` }] },
    });
  }

  const port = config.getOrThrow<number>('PORT');
  // Pinned to 0.0.0.0: on some Node + IPv6-resolver combinations the default
  // bind lands on the IPv6 loopback, and every readiness probe from another pod
  // IP fails silently while the process looks healthy.
  await app.listen(port, '0.0.0.0');

  logger.log(`${config.getOrThrow<string>('SERVICE_NAME')} ready`);
  logger.log(`  env:        ${environment}`);
  logger.log(`  listening:  http://0.0.0.0:${port}/${API_GLOBAL_PREFIX}`);
  logger.log(`  merchant:   ${config.getOrThrow<string>('APPLE_MERCHANT_ID')}`);
  logger.log(`  team:       ${config.getOrThrow<string>('APPLE_TEAM_ID')}`);
  logger.log(
    `  well-known: ${config.get<boolean>('WELL_KNOWN_SERVE_ENABLED') === true ? `served at ${DOMAIN_ASSOCIATION_PATH}` : 'not served here'}`,
  );
  if (swaggerEnabled) logger.log(`  docs:       /docs`);
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet — a config validation failure throws before any
  // of it is built — so this one line goes straight to stderr.
  console.error('apple-pay-api failed to bootstrap:', error);
  process.exit(1);
});
