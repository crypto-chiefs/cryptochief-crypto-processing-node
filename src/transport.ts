import { ApiError, ErrorCode } from './errors';

/** The error envelope shape the API returns on failure. */
interface ErrorEnvelope {
  error?: string;
  msg?: string;
  ok?: boolean;
}

/**
 * Parse a non-2xx response body into an {@link ApiError} with a stable code.
 *
 * The API answers a failure in one of two envelope shapes, and the machine code
 * sits in a different field in each:
 *
 * - a refusal the gateway decided itself carries the code in `error` and a
 *   human sentence in `msg` —
 *   `{"error":"LABEL_TOO_LONG","msg":"label is longer than 255 characters"}`;
 * - a refusal relayed from an upstream service marks `error` as
 *   `SERVICE_ERROR` and carries the code in `msg` —
 *   `{"error":"SERVICE_ERROR","msg":"wallet_not_found"}`.
 *
 * So the code is `error` unless `error` is the generic `SERVICE_ERROR` marker,
 * in which case it is `msg`; an empty result falls back to `error` and then to
 * `HTTP_<status>`. The message prefers `msg` — the sentence, when there is one —
 * and falls back to `error`. The untouched body stays on {@link ApiError.raw}.
 */
export function parseApiError(status: number, body: string): ApiError {
  let env: ErrorEnvelope = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === 'object') env = parsed as ErrorEnvelope;
  } catch {
    // Non-JSON error body - fall back to HTTP_<status>.
  }
  const gatewayCode = env.error && env.error !== ErrorCode.ServiceError ? env.error : env.msg;
  const code = gatewayCode || env.error || `HTTP_${status}`;
  const message = env.msg || env.error || '';
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
