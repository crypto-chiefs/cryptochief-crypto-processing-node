import { createHash, createHmac } from 'node:crypto';
import { CryptoChiefError } from './errors';

/**
 * HMAC-SHA256 v1 request signing.
 *
 * `signature = hex(HMAC-SHA256(key = apiKey, message = string to sign))`, sent
 * as `X-CC-Signature: v1=<signature>`. The body is hashed as the exact bytes
 * sent.
 */

/** First line of the HMAC v1 string to sign. */
export const HMAC_V1_SCOPE = 'CC-HMAC-SHA256-REQ-V1';

/** Request headers of HMAC v1. `X-CC-Signature` carries `v1=<64 hex>`. */
export const HMAC_V1_HEADERS = {
  timestamp: 'X-CC-Timestamp',
  nonce: 'X-CC-Nonce',
  signature: 'X-CC-Signature',
  idempotencyKey: 'Idempotency-Key',
} as const;

/** Fields of the HMAC v1 string to sign. */
export interface HmacV1Input {
  /** Unix time in seconds, decimal. */
  timestamp: string;
  /** 16–64 chars of `[A-Za-z0-9_-]`. */
  nonce: string;
  /** Signed upper-cased, `a`-`z` only; every other byte as it is. */
  method: string;
  /** API route path from `/v1/`, percent-decoded, without query and base URL prefix. */
  path: string;
  /** Query without `?`; empty when none. */
  query?: string;
  /** `Merchant` header value. */
  merchant: string;
  /** `Idempotency-Key` header value; empty when none. */
  idempotencyKey?: string;
  /** Body exactly as sent. A string is hashed as UTF-8. */
  body?: string | Uint8Array;
}

/**
 * Upper-cases `a`-`z` and leaves every other byte alone. The HTTP method is an
 * RFC 9110 token; a Unicode mapping would rewrite bytes outside that range
 * (`ı` to `I`, `ß` to `SS`) and the signature would stop matching the server's.
 *
 * @internal
 */
export function upperAsciiMethod(method: string): string {
  return method.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

/**
 * An API key of nothing, or of spaces and tabs only, is no key: signing with it
 * is an error and the server refuses the request.
 *
 * @internal
 */
export function isBlankApiKey(apiKey: unknown): boolean {
  return typeof apiKey !== 'string' || /^[ \t]*$/.test(apiKey);
}

/** Lowercase hex SHA-256 of the body bytes. */
export function hmacV1BodySha256(body: string | Uint8Array = ''): string {
  return createHash('sha256')
    .update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body)
    .digest('hex');
}

/**
 * HMAC v1 string to sign: `CC-HMAC-SHA256-REQ-V1`, timestamp, nonce, METHOD,
 * path, query, merchant, idempotency key, hex SHA-256 of the body, joined by
 * `\n`. Throws {@link CryptoChiefError} when a field contains CR or LF.
 */
export function hmacV1StringToSign(input: HmacV1Input): string {
  const fields = [
    input.timestamp,
    input.nonce,
    upperAsciiMethod(input.method),
    input.path,
    input.query ?? '',
    input.merchant,
    input.idempotencyKey ?? '',
  ];
  for (const f of fields) {
    if (/[\r\n]/.test(f)) {
      throw new CryptoChiefError('cryptochief: hmac v1 field contains CR or LF');
    }
  }
  return [HMAC_V1_SCOPE, ...fields, hmacV1BodySha256(input.body)].join('\n');
}

/**
 * HMAC v1 signature: lowercase hex `HMAC-SHA256(key = apiKey, message =
 * hmacV1StringToSign(input))`. The `X-CC-Signature` header value is `v1=` plus
 * this.
 *
 * Throws {@link CryptoChiefError} when `apiKey` is empty or only spaces and
 * tabs - the server refuses such a key, so there is nothing to sign with.
 */
export function signHmacV1(input: HmacV1Input, apiKey: string): string {
  if (isBlankApiKey(apiKey)) throw new CryptoChiefError('cryptochief: apiKey is required');
  return createHmac('sha256', Buffer.from(apiKey, 'utf8'))
    .update(hmacV1StringToSign(input), 'utf8')
    .digest('hex');
}
