import { ApiError, ErrorCode } from './errors';

/**
 * Parse a non-2xx response body into an {@link ApiError} with a stable code.
 *
 * Gateway envelope, `error` is a string:
 *
 * - `{"ok":false,"error":"LABEL_TOO_LONG","msg":"label is longer than 255 characters"}` —
 *   code in `error`, sentence in `msg`;
 * - `{"ok":false,"error":"SERVICE_ERROR","msg":"wallet_not_found"}` — code in `msg`.
 *   `SERVICE_ERROR` with an empty `msg` stays the code.
 *
 * Installation envelope, `error` is an object:
 *
 * - `{"data":null,"error":{"status":401,"name":"UnauthorizedError","message":"...",
 *   "details":{"code":"SIGNATURE_TIMESTAMP_OUT_OF_RANGE","server_time":1789430400}},"server_time":1789430400}` —
 *   code in `error.details.code`, else `error.name`; sentence in `error.message`.
 *
 * Without a code the result is `HTTP_<status>`. `server_time` is read from the
 * top level, else from `error.details`. The body stays on {@link ApiError.raw}.
 */
export function parseApiError(status: number, body: string): ApiError {
  let env: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) env = parsed as Record<string, unknown>;
  } catch {
    // Non-JSON error body - fall back to HTTP_<status>.
  }

  let code: string | undefined;
  let message: string | undefined;
  let serverTime = unixSeconds(env.server_time);

  const err = env.error;
  if (isObject(err)) {
    const details = isObject(err.details) ? err.details : {};
    code = str(details.code) || str(err.name);
    message = str(err.message);
    serverTime ??= unixSeconds(details.server_time);
  } else {
    const error = str(err);
    const msg = str(env.msg);
    code = (error && error !== ErrorCode.ServiceError ? error : msg) || error;
    message = msg || error;
  }

  return new ApiError({
    httpStatus: status,
    code: code || `HTTP_${status}`,
    message: message ?? '',
    raw: body,
    serverTime,
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function unixSeconds(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined;
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
