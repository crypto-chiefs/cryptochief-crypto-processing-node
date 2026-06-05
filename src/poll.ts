import { CryptoChiefError, isRetryable } from './errors';
import { sleep } from './transport';

/** Tuning for the `waitFor*` polling helpers. Defaults: 5s interval, 10m timeout. */
export interface PollOptions {
  /** Delay between polls, in ms. Default 5000. */
  intervalMs?: number;
  /** Overall timeout, in ms. Default 600000 (10 minutes). */
  timeoutMs?: number;
  /** Abort the wait early. */
  signal?: AbortSignal;
}

/** Thrown when a `waitFor*` helper times out before reaching a terminal state. */
export class PollTimeoutError<T> extends CryptoChiefError {
  /** The last observed state before the timeout (if any was fetched). */
  readonly lastState?: T;
  constructor(timeoutMs: number, lastState?: T) {
    super(`cryptochief: poll did not reach a terminal state within ${timeoutMs}ms`);
    this.name = 'PollTimeoutError';
    this.lastState = lastState;
  }
}

/**
 * Poll `fetchOne` until `isTerminal` is satisfied or the timeout elapses.
 * Transient (retryable) fetch errors are tolerated and retried on the next
 * tick; non-retryable errors propagate immediately. On timeout a
 * {@link PollTimeoutError} carrying the last observed state is thrown.
 */
export async function waitForTerminal<T>(
  fetchOne: (signal?: AbortSignal) => Promise<T>,
  isTerminal: (value: T) => boolean,
  opts: PollOptions = {},
): Promise<T> {
  const intervalMs = opts.intervalMs && opts.intervalMs > 0 ? opts.intervalMs : 5_000;
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : 600_000;
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;

  for (;;) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new DOMException('Aborted', 'AbortError');
    try {
      const value = await fetchOne(opts.signal);
      last = value;
      if (isTerminal(value)) return value;
    } catch (err) {
      if (!isRetryable(err)) throw err;
      // Tolerate transient errors (e.g. uuid not yet visible) and retry.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new PollTimeoutError<T>(timeoutMs, last);
    await sleep(Math.min(intervalMs, remaining), opts.signal);
  }
}
