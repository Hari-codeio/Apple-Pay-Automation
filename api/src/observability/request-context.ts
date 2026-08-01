import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request state that every log line in the request's call tree can read
 * without it being threaded through every function signature.
 *
 * AsyncLocalStorage survives `await` boundaries, so a log emitted deep inside a
 * gateway call still carries the correlation ID of the request that caused it.
 * That is the difference between "a payment verification failed somewhere" and
 * "this request failed, here is its full trail".
 */
export interface RequestContext {
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(
  context: RequestContext,
  fn: () => T,
): T {
  return storage.run(context, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
