/**
 * CORS origin policy.
 *
 * An exact-match allowlist, not a substring or suffix test: `endsWith('.example.com')`
 * also matches `https://example.com.attacker.test`, which is how origin checks
 * usually fail. Requests with no `Origin` header (server-to-server, curl,
 * orchestrator probes) are allowed through — CORS is a browser-enforced policy
 * and has nothing to say about them.
 */

export type CorsOriginDecision = (
  requestOrigin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) => void;

export interface CorsOriginOptions {
  /** Reflect any origin. Only ever true on dev-like tiers (the boot schema enforces that). */
  allowAll: boolean;
  allowedOrigins: readonly string[];
  /** Called with the rejected origin, so a misconfigured allowlist is visible in logs. */
  onDenied?: (origin: string) => void;
}

/** Split the comma-separated env value into a normalized allowlist. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => normalizeOrigin(entry))
    .filter((entry) => entry.length > 0);
}

/**
 * Lower-case the origin and drop a trailing slash. Origins are
 * case-insensitive in scheme and host, and browsers never send a path, but
 * hand-written allowlists routinely include `https://app.example.com/`.
 */
function normalizeOrigin(origin: string): string {
  return origin.trim().toLowerCase().replace(/\/+$/, '');
}

export function createCorsOriginCallback(
  options: CorsOriginOptions,
): CorsOriginDecision {
  const allowed = new Set(options.allowedOrigins.map(normalizeOrigin));

  return (requestOrigin, callback) => {
    if (requestOrigin === undefined || requestOrigin === '') {
      callback(null, true);
      return;
    }
    if (options.allowAll || allowed.has(normalizeOrigin(requestOrigin))) {
      callback(null, true);
      return;
    }
    options.onDenied?.(requestOrigin);
    // Deny by omitting the header rather than by erroring: an Error here
    // surfaces as a 500, which turns a client's CORS misconfiguration into an
    // alert on our own error rate.
    callback(null, false);
  };
}
