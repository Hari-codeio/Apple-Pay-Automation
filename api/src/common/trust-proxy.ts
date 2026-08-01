/**
 * Coerce the `TRUST_PROXY` env string into the type Express's `trust proxy`
 * setting expects.
 *
 * Express reads three distinct TYPES from this setting:
 *   - boolean: trust everything / nothing
 *   - number:  hop count to trust
 *   - string:  IP, CIDR, preset ('loopback', 'linklocal', 'uniquelocal'), or a
 *              comma-separated list of those
 *
 * Express does NOT coerce the string `'1'` to the number 1 — it reads it as an
 * IP-literal-or-preset and silently trusts nothing. The visible symptom is that
 * `req.ip` returns the load balancer's address, which collapses the per-IP
 * throttler into a single global bucket and makes every access-log line report
 * the same client.
 *
 * Defaults to 1 because the typical deployment puts exactly one load balancer
 * in front of the pod.
 */
export function resolveTrustProxy(
  raw: string | undefined,
): boolean | number | string {
  const value = (raw ?? '').trim();
  // An empty or whitespace-only value means "not configured", not "trust the
  // empty IP list". `TRUST_PROXY=` in a .env file, or a configmap key present
  // with no value, both arrive here as '' — and passing that to Express silently
  // trusts nothing, which is the exact failure this function exists to prevent.
  if (value.length === 0) return 1;

  // Case-insensitive so a YAML-quoted "TRUE"/"False" from a configmap does not
  // fall through to the string branch and reach Express as an IP literal.
  const lowered = value.toLowerCase();

  if (lowered === 'true') return true;
  if (lowered === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
