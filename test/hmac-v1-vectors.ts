import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The gateway's HMAC v1 request vectors, copied byte for byte from
 * `processing-api-gateway/internal/auth/testdata/hmac_v1_vectors.json`. The
 * digest pins the copy: every reader goes through this module, so a stale or
 * edited file fails on load instead of silently testing something else.
 */
export const REQUEST_VECTORS_SHA256 = 'a87df4921399dc14c7ceaa7e4c0dfa02495ad0400a5e722adfc0d3e3c1e064fe';

/** Outcome of verifying a vector's request on the server. */
export type VectorExpect = 'ok' | 'bad_auth_headers' | 'timestamp_out_of_range' | 'invalid_signature';

/**
 * One record. Fields up to `body_sha256` describe the signed request,
 * `string_to_sign` and `signature` are computed from them and hold in every
 * record - including the refusals - `now` is the verifier's Unix time, `expect`
 * the outcome, and `headers` replaces the listed headers on the receiver's side.
 */
export interface RequestVector {
  name: string;
  api_key: string;
  method: string;
  path: string;
  query: string;
  merchant: string;
  idempotency_key: string;
  timestamp: string;
  nonce: string;
  body: string;
  body_sha256: string;
  string_to_sign: string;
  signature: string;
  now: number;
  expect: VectorExpect;
  headers?: Record<string, string[]>;
}

export const requestVectorsFile = readFileSync(new URL('./testdata/hmac_v1_vectors.json', import.meta.url));

export const requestVectorsSha256 = createHash('sha256').update(requestVectorsFile).digest('hex');

if (requestVectorsSha256 !== REQUEST_VECTORS_SHA256) {
  throw new Error(
    `test/testdata/hmac_v1_vectors.json sha256 ${requestVectorsSha256}, want ${REQUEST_VECTORS_SHA256}`,
  );
}

export const requestVectors: RequestVector[] = JSON.parse(requestVectorsFile.toString('utf8'));

export function requestVector(name: string): RequestVector {
  const v = requestVectors.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  return v;
}

/**
 * Header lines the receiver sees: `Merchant`, `X-CC-Timestamp`, `X-CC-Nonce`,
 * `X-CC-Signature`, `Idempotency-Key` when the record has one and
 * `Content-Type: application/json` when the body is not empty, with `headers`
 * replacing the names it lists (matched without case). An override of `[]`
 * removes the header, `[""]` leaves it empty, two values repeat it.
 */
export function vectorHeaderLines(v: RequestVector): [string, string][] {
  const lines = new Map<string, string[]>([
    ['Merchant', [v.merchant]],
    ['X-CC-Timestamp', [v.timestamp]],
    ['X-CC-Nonce', [v.nonce]],
    ['X-CC-Signature', [`v1=${v.signature}`]],
  ]);
  if (v.idempotency_key !== '') lines.set('Idempotency-Key', [v.idempotency_key]);
  if (v.body !== '') lines.set('Content-Type', ['application/json']);
  for (const [name, values] of Object.entries(v.headers ?? {})) {
    for (const key of [...lines.keys()]) {
      if (key.toLowerCase() === name.toLowerCase()) lines.delete(key);
    }
    lines.set(name, values);
  }
  const out: [string, string][] = [];
  for (const [name, values] of lines) for (const value of values) out.push([name, value]);
  return out;
}
