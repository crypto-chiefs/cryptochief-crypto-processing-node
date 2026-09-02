/**
 * Error model for the Crypto Chief SDK.
 *
 * Everything the SDK throws derives from {@link CryptoChiefError}, so a single
 * `catch (e) { if (e instanceof CryptoChiefError) ... }` covers the library.
 * API-level failures arrive as {@link ApiError} with a stable {@link ApiError.code}
 * string - branch on {@link ErrorCode} (or `error.code`) rather than parsing
 * messages.
 */

/** Base class for every error thrown by the SDK. */
export class CryptoChiefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoChiefError';
    // Restore prototype chain for transpiled targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Typed form of a Crypto Chief error response.
 *
 * The API returns either `{"error":"<CODE>","msg":"<sentence>","ok":false}` —
 * a refusal the gateway decided itself, code in `error` — or
 * `{"error":"SERVICE_ERROR","msg":"<CODE>","ok":false}` — a refusal relayed
 * from an upstream service, code in `msg`. Both resolve to {@link code}, the
 * stable identifier to switch on; {@link message} carries the human sentence
 * when the response has one, and {@link raw} the whole body:
 *
 * ```ts
 * try {
 *   await client.payouts.execute(req);
 * } catch (e) {
 *   if (e instanceof ApiError && e.code === ErrorCode.InsufficientFunds) {
 *     // top up and retry
 *   }
 * }
 * ```
 */
export class ApiError extends CryptoChiefError {
  /** HTTP status code returned by the server (0 for transport-level errors). */
  readonly httpStatus: number;
  /**
   * Stable string identifier callers should branch on - resolved from whichever
   * envelope field carries the machine code, so the {@link ErrorCode} constants
   * match whichever shape the API used.
   */
  readonly code: string;
  /** Raw response body, verbatim. */
  readonly raw?: string;

  constructor(params: { httpStatus?: number; code: string; message?: string; raw?: string }) {
    const { httpStatus = 0, code, message, raw } = params;
    super(ApiError.format(httpStatus, code, message));
    this.name = 'ApiError';
    this.httpStatus = httpStatus;
    this.code = code;
    this.raw = raw;
  }

  private static format(status: number, code: string, message?: string): string {
    if (status === 0) return `cryptochief: ${code}`;
    if (message && message !== code) return `cryptochief: ${status} ${code}: ${message}`;
    return `cryptochief: ${status} ${code}`;
  }
}

/**
 * Stable error codes. Not exhaustive - Crypto Chief defines more per endpoint
 * and may add new ones, so treat an unknown {@link ApiError.code} as opaque.
 */
export const ErrorCode = {
  InsufficientFunds: 'INSUFFICIENT_FUNDS',
  InsufficientCredits: 'INSUFFICIENT_CREDITS',
  DebtLimitExceeded: 'DEBT_LIMIT_EXCEEDED',
  AssetNotEnabled: 'ASSET_NOT_ENABLED',
  OrderAlreadyExists: 'ORDER_ALREADY_EXIST',
  OrderCannotCancel: 'ORDER_CANNOT_CANCEL',
  OrderNotLive: 'ORDER_NOT_LIVE',
  AssetAlreadySelected: 'ASSET_ALREADY_SELECTED',
  InvalidParams: 'INVALID_PARAMS',
  ServiceError: 'SERVICE_ERROR',
  Unauthorized: 'UNAUTHORIZED',
  UrlCallbackRequired: 'URL_CALLBACK_REQUIRED',
  LabelTooLong: 'LABEL_TOO_LONG',
  BatchEmpty: 'BATCH_EMPTY',
  BatchTooLarge: 'BATCH_TOO_LARGE',
  BatchDuplicateOrderId: 'BATCH_DUPLICATE_ORDER_ID',
  FromWalletNotOwned: 'FROM_WALLET_NOT_OWNED',
  SignatureExpired: 'SIGNATURE_EXPIRED',
  AlreadyExecuted: 'ALREADY_EXECUTED',
  PreflightFailed: 'PREFLIGHT_FAILED',
  BroadcastFailed: 'BROADCAST_FAILED',
  SignedTxMismatch: 'SIGNED_TX_MISMATCH',
  ContractRequiredForToken: 'CONTRACT_REQUIRED_FOR_TOKEN',
  TransferFieldsForbidden: 'TRANSFER_FIELDS_NOT_ALLOWED_FOR_CONTRACT',
  CallsRequired: 'CALLS_REQUIRED',
  CallsNotAllowed: 'CALLS_NOT_ALLOWED_FOR_TRANSFER',
  ContractCallsUnsupported: 'CONTRACT_CALLS_UNSUPPORTED_ON_NETWORK',
  NetworkError: 'NETWORK_ERROR',
} as const;

/** Union of the known stable error codes. */
export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/**
 * Narrowing helper: `true` when `err` is an {@link ApiError} (optionally with a
 * specific {@link ErrorCode}).
 *
 * ```ts
 * if (isApiError(err, ErrorCode.InsufficientFunds)) { ... }
 * ```
 */
export function isApiError(err: unknown, code?: string): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

/**
 * Reports whether an error is plausibly transient and worth retrying. The
 * transport uses it internally; callers retrying at a higher level can too.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof ApiError) {
    // Structured response - only 5xx (and transport NETWORK_ERROR) are retryable.
    return err.httpStatus >= 500 || err.code === ErrorCode.NetworkError;
  }
  // Bare network/transport errors are retryable.
  return err instanceof Error;
}
