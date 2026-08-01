/**
 * Env for the e2e suite, set before any module loads.
 *
 * Every variable the suite depends on is set explicitly, including the optional
 * ones. `ConfigModule` also reads `api/.env`, and while process.env wins over a
 * file, anything left unset here would silently inherit a developer's local
 * value — turning an assertion about the API into an assertion about their
 * machine.
 *
 * The credentials are deliberately unreachable: this suite covers the HTTP
 * surface (routing, prefixing, validation, error shape) and must never touch the
 * shared database or the Apple portal. Both are stubbed in the spec.
 */
process.env.ENVIRONMENT = 'test';
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.LOG_LEVEL = 'silent';
process.env.LOG_PRETTY = 'false';
process.env.SERVICE_NAME = 'apple-pay-api-e2e';
process.env.TRUST_PROXY = '1';
process.env.BODY_LIMIT = '256kb';
process.env.CORS_ALLOWED_ORIGINS = '';

// Set so the guard is exercised as a deployed tier exercises it, rather than
// falling through its dev-like "no key configured" branch.
process.env.API_KEY = 'e2e-test-api-key-0123456789abcdef';

process.env.THROTTLE_TTL_SECONDS = '60';
// High enough that no assertion trips the limiter; the limiter itself is not
// what this suite is testing.
process.env.THROTTLE_LIMIT = '1000';

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '3306';
process.env.DB_NAME = 'phoenix_release_test';
process.env.DB_USER = 'test';
process.env.DB_PASSWORD = 'test-password';
process.env.DB_SSL = 'false';
process.env.DB_SSL_CA_PATH = '';

process.env.APPLE_ID_EMAIL = 'ops@example.test';
process.env.APPLE_ID_PASSWORD = 'test-password';
process.env.APPLE_TEAM_ID = '64426BH9K3';
process.env.APPLE_MERCHANT_ID = 'merchant.phoenix.applepay8';
process.env.PLAYWRIGHT_HEADLESS = 'true';

process.env.DOMAIN_PROBE_ENABLED = 'false';
process.env.WELL_KNOWN_SERVE_ENABLED = 'true';
process.env.CRON_ENABLED = 'false';
process.env.SWAGGER_ENABLED = 'false';
