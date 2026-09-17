import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The server side of HMAC v1, written from the specification without the SDK's
 * signing code. Used by the vector runner and by the mock gateway the client
 * talks to over HTTP, so both answer with the same rules the gateway applies.
 */

/** What the server answers with. */
export type HmacV1Outcome =
  | 'ok'
  | 'bad_auth_headers'
  | 'timestamp_out_of_range'
  | 'invalid_signature'
  | 'signature_replayed';

export const HMAC_V1_WINDOW_SEC = 300;

/** A request as the server reads it: the route decoded, the query raw. */
export interface SignedRequest {
  method: string;
  /** Route path, percent-decoded. */
  path: string;
  /** Query without `?`, exactly as it arrived. */
  rawQuery: string;
  /** Header lines in arrival order; a repeated header appears twice. */
  headers: readonly (readonly [string, string])[];
  body: Uint8Array;
}

export interface GatewayState {
  /** Project key by merchant. Missing, or blank, refuses the signature. */
  keys: Readonly<Record<string, string>>;
  /** The server's Unix time in seconds. */
  nowSec: number;
  /** Nonces already used, as `merchant|nonce`. Omit to skip the replay check. */
  nonces?: Set<string>;
}

const SCOPE = 'CC-HMAC-SHA256-REQ-V1';
const SIGNATURE_PREFIX = 'v1=';
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,17})$/;
const HEX64 = /^[0-9a-fA-F]{64}$/;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Only spaces and tabs are trimmed off a header value. */
function trimOws(v: string): string {
  return v.replace(/^[ \t]+|[ \t]+$/g, '');
}

/**
 * The only value of a header, trimmed. `undefined` when the header is repeated;
 * an absent header reads as empty, the way `http.Header.Get` does.
 */
function single(headers: SignedRequest['headers'], name: string): string | undefined {
  const want = name.toLowerCase();
  const values = headers.filter(([k]) => k.toLowerCase() === want).map(([, v]) => v);
  if (values.length > 1) return undefined;
  return values.length === 0 ? '' : trimOws(values[0]!);
}

/** `application/json` without case, parameters allowed, and the value has to parse. */
function isJsonContentType(value: string): boolean {
  const semi = value.indexOf(';');
  const base = semi < 0 ? value : value.slice(0, semi);
  if (trimOws(base).toLowerCase() !== 'application/json') return false;
  if (semi < 0) return true;
  const params = value.slice(semi + 1).split(';');
  for (let i = 0; i < params.length; i++) {
    const p = trimOws(params[i]!);
    // A trailing semicolon is tolerated; an empty parameter elsewhere is not.
    if (p === '') return i === params.length - 1;
    const eq = p.indexOf('=');
    if (eq <= 0) return false;
    const name = p.slice(0, eq);
    const v = p.slice(eq + 1);
    if (!TOKEN.test(name)) return false;
    if (!TOKEN.test(v) && !/^"([^"\\]|\\[\s\S])*"$/.test(v)) return false;
  }
  return true;
}

/** Upper-cases `a`-`z` only, as the string to sign does. */
function upperAscii(s: string): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
}

export function stringToSign(fields: {
  timestamp: string;
  nonce: string;
  method: string;
  path: string;
  query: string;
  merchant: string;
  idempotencyKey: string;
  body: Uint8Array;
}): string | undefined {
  const lines = [
    fields.timestamp,
    fields.nonce,
    upperAscii(fields.method),
    fields.path,
    fields.query,
    fields.merchant,
    fields.idempotencyKey,
  ];
  if (lines.some((f) => /[\r\n]/.test(f))) return undefined;
  return [SCOPE, ...lines, createHash('sha256').update(fields.body).digest('hex')].join('\n');
}

/**
 * Verify a request: header format, then the timestamp window, then the
 * signature, then the nonce. The order is the gateway's, and so is each refusal.
 */
export function checkHmacV1(req: SignedRequest, state: GatewayState): HmacV1Outcome {
  const merchant = single(req.headers, 'Merchant');
  const ts = single(req.headers, 'X-CC-Timestamp');
  const nonce = single(req.headers, 'X-CC-Nonce');
  const sig = single(req.headers, 'X-CC-Signature');
  const idem = single(req.headers, 'Idempotency-Key');
  if (merchant === undefined || ts === undefined || nonce === undefined || sig === undefined || idem === undefined) {
    return 'bad_auth_headers';
  }
  if (merchant === '' || !DECIMAL.test(ts) || !NONCE.test(nonce)) return 'bad_auth_headers';
  if (!sig.startsWith(SIGNATURE_PREFIX) || !HEX64.test(sig.slice(SIGNATURE_PREFIX.length))) {
    return 'bad_auth_headers';
  }
  if (req.body.length > 0 && !isJsonContentType(single(req.headers, 'Content-Type') ?? '')) {
    return 'bad_auth_headers';
  }

  const sts = stringToSign({
    timestamp: ts,
    nonce,
    method: req.method,
    path: req.path,
    query: req.rawQuery,
    merchant,
    idempotencyKey: idem,
    body: req.body,
  });
  if (sts === undefined) return 'bad_auth_headers';

  const skew = state.nowSec - Number(ts);
  if (skew > HMAC_V1_WINDOW_SEC || skew < -HMAC_V1_WINDOW_SEC) return 'timestamp_out_of_range';

  // A project without a key - empty, or spaces and tabs only - never matches.
  const key = state.keys[merchant] ?? '';
  if (/^[ \t]*$/.test(key)) return 'invalid_signature';
  const want = createHmac('sha256', Buffer.from(key, 'utf8')).update(sts, 'utf8').digest();
  const got = Buffer.from(sig.slice(SIGNATURE_PREFIX.length), 'hex');
  if (got.length !== want.length || !timingSafeEqual(want, got)) return 'invalid_signature';

  if (state.nonces) {
    const used = `${merchant}|${nonce}`;
    if (state.nonces.has(used)) return 'signature_replayed';
    state.nonces.add(used);
  }
  return 'ok';
}

/** HTTP status and gateway error code for an outcome. */
export const OUTCOME_STATUS: Record<Exclude<HmacV1Outcome, 'ok'>, number> = {
  bad_auth_headers: 400,
  timestamp_out_of_range: 401,
  invalid_signature: 401,
  signature_replayed: 401,
};

export const OUTCOME_CODE: Record<Exclude<HmacV1Outcome, 'ok'>, string> = {
  bad_auth_headers: 'BAD_AUTH_HEADERS',
  timestamp_out_of_range: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE',
  invalid_signature: 'INVALID_SIGNATURE',
  signature_replayed: 'SIGNATURE_REPLAYED',
};
