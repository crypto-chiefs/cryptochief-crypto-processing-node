import { ApiError, ErrorCode } from './errors';

/** The error envelope shape the API returns on failure. */
interface ErrorEnvelope {
  error?: string;
  msg?: string;
  ok?: boolean;
}

/**
 * Parse a non-2xx response body into an {@link ApiError} with a stable code.
 * The code is `msg || error || HTTP_<status>`, and the message prefers `msg`
 * when it differs from `error`.
 */
export function parseApiError(status: number, body: string): ApiError {
  let env: ErrorEnvelope = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') env = parsed as ErrorEnvelope;
  } catch {
    // Non-JSON error body - fall back to HTTP_<status>.
  }
  const code = env.msg || env.error || `HTTP_${status}`;
  let message = env.error ?? '';
  if (env.msg && env.msg !== env.error) message = env.msg;
  return new ApiError({ httpStatus: status, code, message, raw: body });
}

/**
 * Exponential backoff with full jitter, capped at `maxMs`. `attempt` is
 * 1-indexed (first retry = 1).
 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (baseMs <= 0) baseMs = 200;
  if (maxMs <= 0) maxMs = 5000;
  let d = baseMs * 2 ** (attempt - 1);
  if (d <= 0 || d > maxMs) d = maxMs;
  // Full jitter - uniform in [0, d].
  return Math.floor(Math.random() * (d + 1));
}

/** Promise that resolves after `ms`, or rejects if `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signalReason(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signalReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function signalReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Aborted', 'AbortError');
}

/** Build a {@link ApiError} for a transport-level (network) failure. */
export function networkError(message: string): ApiError {
  return new ApiError({ code: ErrorCode.NetworkError, message });
}
