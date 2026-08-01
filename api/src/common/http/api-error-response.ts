/**
 * The single error shape every failed request returns.
 *
 * One shape means a client writes one error handler. `requestId` is part of the
 * contract on purpose: it gives a caller reporting a problem something to quote
 * that maps straight to the server-side log line.
 */
export interface ApiErrorResponse {
  statusCode: number;
  /** Machine-readable HTTP reason phrase, e.g. 'Bad Request'. */
  error: string;
  /** Human-readable detail. One string, or many for a failed field validation. */
  message: string | string[];
  /** Correlation ID, matching the `x-request-id` response header. */
  requestId?: string;
  path: string;
  timestamp: string;
}
