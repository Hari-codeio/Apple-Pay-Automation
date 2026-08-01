/**
 * An error whose message is safe to return to the caller, and which knows the
 * HTTP status it deserves.
 *
 * The default posture in `AllExceptionsFilter` is that a 5xx body carries no
 * detail — a mysql2 error can contain the connection string, a Playwright error
 * can contain page content. But some failures are *operational*: the cause is
 * known, the message names the fix, and withholding it just means the operator
 * reads "Internal server error" and then goes digging through logs for something
 * we already knew.
 *
 * "No stored Apple session — run pnpm apple:login" is the motivating case. It is
 * a precondition failure, not a fault, and the caller can act on it.
 *
 * Subclasses must be deliberate: anything extending this is promising that its
 * message contains no credential, no connection string, and no user data.
 */
export abstract class OperationalError extends Error {
  /** Status the filter should respond with. */
  abstract readonly httpStatus: number;

  constructor(message: string) {
    super(message);
    // Without this, `instanceof` fails for subclasses when compiled to ES5-era
    // targets, and the filter would silently fall through to a generic 500.
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
