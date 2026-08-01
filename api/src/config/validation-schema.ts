/**
 * Zod schema applied to process.env at boot.
 *
 * Lives in its own file (rather than inline in ConfigModule.forRoot) so tests
 * can import the schema directly and run it against crafted env objects — the
 * security guards below are the kind of thing that must have a test, and a
 * schema buried in a module decorator cannot get one.
 *
 * Validation is fail-fast: see @apple-pay/config-validation. Every credential
 * this service needs is REQUIRED here, so a misconfigured deployment refuses to
 * start rather than failing on its first attempt to drive the Apple portal.
 */

import { z } from 'zod';
import {
  DEFAULT_BODY_LIMIT,
  DEFAULT_LOG_LEVEL,
  DEFAULT_PORT,
  DEFAULT_SERVICE_NAME,
  DEFAULT_THROTTLE_LIMIT,
  DEFAULT_THROTTLE_TTL_SECONDS,
  ENV_TIERS,
  isDevLikeTier,
} from '../common/constants';

/**
 * Operator-placeholder sentinels we refuse to accept at boot.
 *
 * `.env.example` ships with TODO-style markers that are structurally valid
 * values. Without this guard, `cp .env.example .env` produces a service that
 * boots and then drives the Apple portal with a placeholder merchant ID.
 * Case-sensitive (uppercase only) and word-bounded so legitimate lowercase
 * values cannot trip it.
 */
const PLACEHOLDER_SENTINEL =
  /\bREPLACE_ME\b|\bCHANGEME\b|\bYOUR_[A-Z][A-Z_]*\b|<[A-Z][A-Z0-9_]*>/;

const hasPlaceholder = (v: string): boolean => PLACEHOLDER_SENTINEL.test(v);

const placeholderMessage = (field: string): string =>
  `${field} still contains a placeholder sentinel (REPLACE_ME/CHANGEME/YOUR_*); the operator must supply the real value before boot`;

const noPlaceholder = (field: string) =>
  z
    .string()
    .min(1)
    .refine((v) => !hasPlaceholder(v), placeholderMessage(field));

const LOG_LEVELS = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
] as const;

/**
 * Treat a blank value as absent before the inner schema runs.
 *
 * `FOO=` in a .env file, and a configmap key present with no value, both arrive
 * as `''` — which `.optional()` does NOT consider missing. Without this, an
 * optional-but-constrained var like `API_KEY` fails with "too small" for a
 * variable the operator never meant to set, and the service refuses to boot.
 */
const blankAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim().length === 0
        ? undefined
        : value,
    schema,
  );

/** `true`/`false` env strings, case-insensitive; absent means "use the tier default". */
const optionalBoolean = blankAsUndefined(
  z
    .enum(['true', 'false', 'TRUE', 'FALSE'])
    .transform((v) => v.toLowerCase() === 'true')
    .optional(),
);

export const configValidationSchema = z
  .object({
    // ── Runtime ────────────────────────────────────────────────────────────
    // ENVIRONMENT is this repo's canonical tier name; NODE_ENV stays
    // standard-Node-shaped so tooling that reads it still behaves.
    ENVIRONMENT: z.enum(ENV_TIERS).default('local'),
    NODE_ENV: z
      .enum(['development', 'test', 'staging', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(DEFAULT_PORT),
    SERVICE_NAME: z.string().min(1).default(DEFAULT_SERVICE_NAME),

    // ── Logging ────────────────────────────────────────────────────────────
    LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
    // Human-readable multi-line logs. Defaults on for dev-like tiers, off
    // elsewhere (log aggregators need one JSON object per line).
    LOG_PRETTY: optionalBoolean,

    // ── HTTP ───────────────────────────────────────────────────────────────
    // Comma-separated exact-match origin allowlist. Required on shared tiers;
    // `*` is rejected there (see superRefine).
    CORS_ALLOWED_ORIGINS: blankAsUndefined(z.string().optional()),
    // Express `trust proxy`: hop count, boolean, CIDR, or preset. Defaults to 1
    // because the typical deployment puts exactly one load balancer in front.
    TRUST_PROXY: z.string().default('1'),
    BODY_LIMIT: z.string().default(DEFAULT_BODY_LIMIT),

    // ── Rate limiting ──────────────────────────────────────────────────────
    THROTTLE_TTL_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_THROTTLE_TTL_SECONDS),
    THROTTLE_LIMIT: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_THROTTLE_LIMIT),

    // ── Access control ─────────────────────────────────────────────────────
    // Shared secret for the routes that drive the Apple portal. Optional on
    // dev-like tiers only; required everywhere else (see superRefine), because
    // an open POST here adds a domain to a real merchant identifier.
    API_KEY: blankAsUndefined(z.string().min(32).optional()),

    // ── Docs ───────────────────────────────────────────────────────────────
    // Defaults on for dev-like tiers only, and is refused outright in
    // production: the schema is a map of the attack surface.
    SWAGGER_ENABLED: optionalBoolean,

    // ── MySQL (phoenix_release.apple_pay_domain_verifications) ─────────────
    // This service writes to a database it does not own. There is deliberately
    // no ORM schema sync anywhere in the codebase — see DomainVerificationRepository.
    DB_HOST: noPlaceholder('DB_HOST'),
    DB_PORT: z.coerce.number().int().min(1).max(65535).default(3306),
    DB_NAME: noPlaceholder('DB_NAME'),
    DB_USER: noPlaceholder('DB_USER'),
    DB_PASSWORD: noPlaceholder('DB_PASSWORD'),
    DB_POOL_SIZE: z.coerce.number().int().min(1).max(50).default(5),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    // Per-probe timebox for /readyz. Must stay BELOW the orchestrator's own
    // readiness timeout, or a hung dependency makes the pod look dead rather
    // than degraded. The default allows for a cross-region round trip on a warm
    // pool; the cold TLS handshake is covered by the boot warm-up instead.
    READINESS_PROBE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(3_000),
    // RDS terminates TLS; leaving this off sends the password in the clear.
    // Enforced on for shared tiers in superRefine below.
    DB_SSL: optionalBoolean,
    // PEM bundle for the database certificate's CA, needed whenever that chain
    // is not in Node's default trust store. Verified necessary for
    // phoenix-test-cluster: without it the handshake fails with
    // HANDSHAKE_SSL_ERROR "unable to get local issuer certificate". Fetch AWS's
    // bundle from https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
    // There is deliberately no "disable certificate verification" knob.
    DB_SSL_CA_PATH: blankAsUndefined(z.string().min(1).optional()),

    // ── Apple Developer portal ─────────────────────────────────────────────
    APPLE_ID_EMAIL: z.string().email(),
    // OPTIONAL, and deliberately so: the password is used in exactly one place,
    // as best-effort prefill during the assisted `apple:login`. The unattended
    // flow authenticates with the saved session (or the persistent profile), so
    // the password is a typing convenience, not a credential this service needs.
    //
    // Leaving it unset is the safer default when it might be stale: prefilling a
    // wrong password submits failed sign-in attempts, and Apple locks an Apple ID
    // after a few of those.
    APPLE_ID_PASSWORD: blankAsUndefined(
      noPlaceholder('APPLE_ID_PASSWORD').optional(),
    ),
    // 10-character Apple team identifier, e.g. 64426BH9K3.
    APPLE_TEAM_ID: z
      .string()
      .regex(
        /^[A-Z0-9]{10}$/,
        'APPLE_TEAM_ID must be a 10-character uppercase Apple team identifier',
      ),
    // Merchant identifier, e.g. merchant.phoenix.applepay8.
    APPLE_MERCHANT_ID: z
      .string()
      .regex(
        /^merchant\.[A-Za-z0-9.-]+$/,
        'APPLE_MERCHANT_ID must look like merchant.<reverse.dns>',
      ),
    APPLE_PORTAL_BASE_URL: z
      .string()
      .url()
      .default('https://developer.apple.com'),

    // ── Playwright ─────────────────────────────────────────────────────────
    // Where the authenticated browser session is persisted. Apple ID logins are
    // 2FA-gated, so the session — not the password — is what makes an unattended
    // run possible. See AppleSessionStore.
    APPLE_SESSION_STATE_PATH: z
      .string()
      .min(1)
      .default('.playwright/apple-portal-state.json'),
    // Which browser binary to drive. 'chromium' is Playwright's own bundled
    // build (downloaded by `playwright install`). 'chrome' and 'msedge' are the
    // branded builds already installed on the machine — Playwright never
    // downloads those, so a missing one fails at launch.
    BROWSER_CHANNEL: z
      .enum(['chromium', 'chrome', 'msedge'])
      .default('chromium'),
    // When set, drive a PERSISTENT on-disk browser profile instead of a
    // throwaway one seeded from APPLE_SESSION_STATE_PATH. The profile becomes
    // the credential: log in once and it stays logged in, including Apple's
    // "trust this browser" state, which a storageState JSON does not carry.
    //
    // Chrome cannot be running against this directory — it holds a
    // process-singleton lock and the launch fails outright. Point this at a
    // DEDICATED directory rather than your everyday profile, or every run
    // requires quitting your browser.
    BROWSER_USER_DATA_DIR: blankAsUndefined(z.string().min(1).optional()),
    // Which profile INSIDE that directory to open, e.g. 'Profile 4'.
    //
    // Defaulted rather than optional, and ALWAYS passed to Chrome as
    // --profile-directory. Left unset, Chrome follows `profile.last_used` from
    // `Local State`, which is a file we may have copied from elsewhere: one such
    // copy carried `last_used: "Profile 4"`, so Chrome silently used an empty
    // `Profile 4` while the intended session sat in `Default`, and a completed
    // sign-in looked like it had vanished. The profile must be a property of this
    // config, never of a file's contents.
    BROWSER_PROFILE_DIRECTORY: z.string().min(1).default('Default'),
    // Chromium renderer sandbox. Defaults ON — Playwright's own default is OFF,
    // which launches Chrome with --no-sandbox and a security warning banner, and
    // this browser loads a site we do not control. Set false only where the
    // sandbox cannot work (a container without the needed kernel capabilities).
    BROWSER_SANDBOX: optionalBoolean,

    // ── CDP attachment (the preferred way to drive Chrome) ──────────────────
    // Attaching to a warm Chrome instead of launching one is what removes the
    // profile-lock problem, keeps the browser authenticated, and turns each
    // operation into a new TAB rather than a new process. See chrome-launcher.ts.
    //
    // Port for the debug Chrome to attach to / start on.
    BROWSER_CDP_PORT: z.coerce.number().int().min(1).max(65535).default(9222),
    // Start a debug Chrome automatically when none is answering. Off means
    // "attach only if one is already running", which is what a container wants.
    BROWSER_CDP_AUTOSTART: optionalBoolean,
    // Explicit DevTools endpoint, overriding the port probe above. LOOPBACK ONLY
    // — enforced at runtime by CdpTargetNotLoopbackError, because attaching hands
    // over full control of a browser holding a live Apple session.
    BROWSER_CDP_URL: blankAsUndefined(z.string().url().optional()),
    // Absolute path to a Chrome binary, when the per-platform search in
    // chrome-launcher.ts cannot find it (unusual install location).
    CHROME_EXECUTABLE_PATH: blankAsUndefined(z.string().min(1).optional()),
    PLAYWRIGHT_HEADLESS: optionalBoolean,
    PLAYWRIGHT_SLOW_MO_MS: z.coerce.number().int().min(0).max(5_000).default(0),
    PLAYWRIGHT_NAV_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(45_000),
    PLAYWRIGHT_ACTION_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(20_000),
    PLAYWRIGHT_DOWNLOAD_DIR: z.string().min(1).default('.artifacts/downloads'),
    // Playwright traces and screenshots for a failed run. The portal's DOM is
    // not ours and changes without notice; a trace is the difference between
    // "the selector broke" and a day of guessing.
    PLAYWRIGHT_TRACE_DIR: z.string().min(1).default('.artifacts/traces'),
    PLAYWRIGHT_TRACE_ON_FAILURE: optionalBoolean,

    // ── Verification behaviour ─────────────────────────────────────────────
    // Apple fetches the association file from the domain before it will mark it
    // verified, so we confirm it is actually reachable first. Clicking Verify
    // against a file that is not live burns an attempt and reports a confusing
    // portal-side error.
    DOMAIN_PROBE_ENABLED: optionalBoolean,
    DOMAIN_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    DOMAIN_PROBE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    DOMAIN_PROBE_DELAY_MS: z.coerce.number().int().min(0).default(2_000),
    // Serve /.well-known/apple-developer-merchantid-domain-association from the
    // table. Off by default: in the Phoenix deployment the CRM backend already
    // owns that route, and two services answering it is a split brain.
    WELL_KNOWN_SERVE_ENABLED: optionalBoolean,
    // Policy knob, not an Apple-published value: how long a row is considered
    // fresh before the renewal sweep re-verifies it.
    VERIFICATION_TTL_DAYS: z.coerce
      .number()
      .int()
      .min(1)
      .max(3_650)
      .default(365),
    // Background renewal sweep. Off by default so a developer machine and every
    // replica do not all drive the portal at once; enable it on exactly one.
    CRON_ENABLED: optionalBoolean,
    RENEWAL_CRON: z.string().min(1).default('0 3 * * *'),

    // ── Boot gate escape hatch ─────────────────────────────────────────────
    CONFIG_VALIDATION_LOG_ONLY: optionalBoolean,
  })
  .superRefine((cfg, ctx) => {
    const devLike = isDevLikeTier(cfg.ENVIRONMENT);

    // Swagger in production publishes the full route surface, including any
    // route an author forgot to guard. Refused rather than defaulted-off so a
    // deliberate `SWAGGER_ENABLED=true` in a prod configmap cannot slip in.
    if (cfg.SWAGGER_ENABLED === true && cfg.ENVIRONMENT === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['SWAGGER_ENABLED'],
        message: 'SWAGGER_ENABLED must not be true when ENVIRONMENT=production',
      });
    }

    // A validation gate that can be silently switched off is not a gate. On
    // shared tiers the opt-out itself is refused at boot.
    if (cfg.CONFIG_VALIDATION_LOG_ONLY === true && !devLike) {
      ctx.addIssue({
        code: 'custom',
        path: ['CONFIG_VALIDATION_LOG_ONLY'],
        message:
          'CONFIG_VALIDATION_LOG_ONLY is only permitted on local/development/test',
      });
    }

    if (devLike) return;

    // ── Shared-tier posture (staging / sandbox / production) ──────────────

    // An unauthenticated route that registers domains on a live Apple merchant
    // identifier is not something to leave to a default.
    if (cfg.API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_KEY'],
        message: 'API_KEY is required outside local/development/test',
      });
    } else if (hasPlaceholder(cfg.API_KEY)) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_KEY'],
        message: placeholderMessage('API_KEY'),
      });
    }

    // Unencrypted MySQL to a managed cluster puts the credentials and every
    // association file on the wire in plaintext.
    if (cfg.DB_SSL === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['DB_SSL'],
        message: 'DB_SSL must not be disabled outside local/development/test',
      });
    }

    // `pino-pretty` is a devDependency and is NOT present in the pruned
    // production image, so requesting pretty output on a shared tier would
    // crash the logger at first write. Refused here rather than silently
    // ignored — and aggregators need one JSON object per line anyway.
    if (cfg.LOG_PRETTY === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_PRETTY'],
        message:
          'LOG_PRETTY must not be enabled outside local/development/test (pino-pretty is not installed in production)',
      });
    }

    // A headed browser needs a display server. On a shared tier there is none,
    // so the run would hang at launch rather than fail loudly.
    if (cfg.PLAYWRIGHT_HEADLESS === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['PLAYWRIGHT_HEADLESS'],
        message:
          'PLAYWRIGHT_HEADLESS must not be disabled outside local/development/test',
      });
    }

    const origins = cfg.CORS_ALLOWED_ORIGINS?.trim();
    if (!origins) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message:
          'CORS_ALLOWED_ORIGINS is required outside local/development/test',
      });
      return;
    }
    if (hasPlaceholder(origins)) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message: placeholderMessage('CORS_ALLOWED_ORIGINS'),
      });
    }
    const entries = origins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    if (entries.includes('*')) {
      ctx.addIssue({
        code: 'custom',
        path: ['CORS_ALLOWED_ORIGINS'],
        message:
          'CORS_ALLOWED_ORIGINS must not contain "*" outside local/development/test',
      });
    }
    for (const origin of entries) {
      if (!/^https?:\/\/[^/]+$/i.test(origin)) {
        ctx.addIssue({
          code: 'custom',
          path: ['CORS_ALLOWED_ORIGINS'],
          message: `CORS_ALLOWED_ORIGINS entry "${origin}" must be a scheme://host origin with no path`,
        });
      }
    }
  });
