/**
 * Cross-cutting constants. Anything a config default AND runtime code both need
 * lives here so the two can never drift apart (the boot schema imports these
 * same values as its `.default()`s).
 */

/** Mounted under this prefix, so `/healthz` sits at `/api/healthz`. */
export const API_GLOBAL_PREFIX = 'api';

/** Correlation-ID header. Echoed on every response, honoured on every request. */
export const REQUEST_ID_HEADER = 'x-request-id';

export const DEFAULT_PORT = 3000;

export const DEFAULT_SERVICE_NAME = 'apple-pay-api';

export const DEFAULT_LOG_LEVEL = 'info';

/**
 * The path Apple fetches to prove domain control. Fixed by Apple — it is not a
 * knob. Served at the domain ROOT, so the route is excluded from the API's
 * global prefix (see main.ts).
 *
 * The `.txt` suffix is load-bearing and was missing here. Apple's Verify screen
 * states the location it will fetch, and it ends in `.txt`. Measured against two
 * domains this merchant has already verified: the `.txt` path returns 200 and the
 * extensionless one returns 404. Probing the extensionless path meant the probe
 * could never pass, so the flow never reached Apple's verification step at all.
 */
export const WELL_KNOWN_PATH = '.well-known';
export const DOMAIN_ASSOCIATION_FILENAME =
  'apple-developer-merchantid-domain-association.txt';
export const DOMAIN_ASSOCIATION_PATH = `/${WELL_KNOWN_PATH}/${DOMAIN_ASSOCIATION_FILENAME}`;

/** Request-body ceiling. Apple Pay payloads are small; a large ceiling is only attack surface. */
export const DEFAULT_BODY_LIMIT = '256kb';

export const DEFAULT_THROTTLE_TTL_SECONDS = 60;
export const DEFAULT_THROTTLE_LIMIT = 100;

/**
 * Paths whose access-log line drops to `debug`. Orchestrator probes poll these
 * every few seconds per replica and would otherwise dominate the info stream.
 */
export const QUIET_LOG_PATHS: readonly string[] = [
  `/${API_GLOBAL_PREFIX}/healthz`,
  `/${API_GLOBAL_PREFIX}/readyz`,
];

/**
 * Environment tiers. `ENVIRONMENT` is the canonical name this repo deploys
 * with; `NODE_ENV` stays standard-Node-shaped and is validated separately.
 */
export const ENV_TIERS = [
  'local',
  'development',
  'test',
  'staging',
  'sandbox',
  'production',
] as const;

/**
 * Loopback tiers: a developer machine or a CI runner. These relax the
 * security-posture guards (open CORS, Swagger on) that the shared tiers pin
 * shut. `sandbox` is deliberately NOT here — it is prod-shaped by design.
 *
 * Module-private: callers ask `isDevLikeTier()` rather than reaching for the set,
 * so the "what counts as dev-like" decision has exactly one implementation.
 */
const DEV_LIKE_TIERS: ReadonlySet<string> = new Set([
  'local',
  'development',
  'test',
]);

export function isDevLikeTier(tier: string | undefined): boolean {
  return DEV_LIKE_TIERS.has((tier ?? 'local').toLowerCase());
}
