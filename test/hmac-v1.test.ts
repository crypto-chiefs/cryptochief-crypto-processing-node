import { describe, it, expect } from 'vitest';
import { CryptoChiefError, ErrorCode } from '../src/errors';
import { hmacV1BodySha256, hmacV1StringToSign, signHmacV1, HMAC_V1_SIGNATURE_PREFIX, type HmacV1Input } from '../src/sign';
import { checkHmacV1, type HmacV1Outcome, type SignedRequest } from './gateway-hmac-v1';
import {
  REQUEST_VECTORS_SHA256,
  requestVector,
  requestVectors,
  requestVectorsSha256,
  vectorHeaderLines,
  type RequestVector,
} from './hmac-v1-vectors';

function inputOf(v: RequestVector): HmacV1Input {
  return {
    timestamp: v.timestamp,
    nonce: v.nonce,
    method: v.method,
    path: v.path,
    query: v.query,
    merchant: v.merchant,
    idempotencyKey: v.idempotency_key,
    body: v.body,
  };
}

/** The request the server sees: the record's fields, with its header overrides. */
function requestOf(v: RequestVector, headers = vectorHeaderLines(v)): SignedRequest {
  return {
    method: v.method,
    path: v.path,
    rawQuery: v.query,
    headers,
    body: Buffer.from(v.body, 'utf8'),
  };
}

function verify(v: RequestVector, req = requestOf(v), nowSec = v.now): HmacV1Outcome {
  return checkHmacV1(req, { keys: { [v.merchant]: v.api_key }, nowSec });
}

describe('HMAC v1 gateway vectors', () => {
  it('is the gateway file, whole', () => {
    expect(requestVectorsSha256).toBe(REQUEST_VECTORS_SHA256);
    expect(requestVectors.length).toBe(50);
    const counts: Record<string, number> = {};
    for (const v of requestVectors) counts[v.expect] = (counts[v.expect] ?? 0) + 1;
    expect(counts).toEqual({ ok: 21, bad_auth_headers: 24, timestamp_out_of_range: 2, invalid_signature: 3 });
  });

  for (const v of requestVectors) {
    it(v.name, () => {
      // Signing side: the string to sign and the signature hold in every record,
      // refusals included.
      expect(hmacV1BodySha256(v.body)).toBe(v.body_sha256);
      expect(hmacV1StringToSign(inputOf(v))).toBe(v.string_to_sign);
      expect(signHmacV1(inputOf(v), v.api_key)).toBe(HMAC_V1_SIGNATURE_PREFIX + v.signature);
      // Same bytes as a Uint8Array body, lower-case method.
      const bytes = {
        ...inputOf(v),
        method: v.method.toLowerCase(),
        body: new Uint8Array(Buffer.from(v.body, 'utf8')),
      };
      expect(signHmacV1(bytes, v.api_key)).toBe(HMAC_V1_SIGNATURE_PREFIX + v.signature);

      // Verifying side: exactly the outcome the record claims.
      expect(verify(v)).toBe(v.expect);
    });
  }

  // One defect per refusal: without the header overrides, and read at the
  // timestamp, the same record passes.
  for (const v of requestVectors) {
    if (v.expect === 'ok') continue;
    it(`${v.name} without its defect`, () => {
      const clean: RequestVector = { ...v, headers: undefined };
      expect(verify(clean, requestOf(clean), Number(v.timestamp))).toBe('ok');
    });
  }

  it('omitted query, idempotency key and body sign as empty', () => {
    const v = requestVector('empty_body');
    const { query: _q, idempotencyKey: _i, body: _b, ...rest } = inputOf(v);
    expect(signHmacV1(rest, v.api_key)).toBe(HMAC_V1_SIGNATURE_PREFIX + v.signature);
  });

  // The value signHmacV1 returns goes into X-CC-Signature untouched, and the
  // verifying side accepts it.
  it('roundtrip: the returned header value verifies as sent', () => {
    const v = requestVector('empty_body');
    const signature = signHmacV1(inputOf(v), v.api_key);
    expect(signature).toMatch(/^v1=[0-9a-f]{64}$/);
    const req: SignedRequest = {
      method: v.method,
      path: v.path,
      rawQuery: v.query,
      headers: [
        ['Merchant', v.merchant],
        ['X-CC-Timestamp', v.timestamp],
        ['X-CC-Nonce', v.nonce],
        ['X-CC-Signature', signature],
      ],
      body: Buffer.from(v.body, 'utf8'),
    };
    expect(checkHmacV1(req, { keys: { [v.merchant]: v.api_key }, nowSec: v.now })).toBe('ok');
  });

  it('rejects CR or LF in a field', () => {
    const base = inputOf(requestVectors[0]!);
    for (const bad of [
      { merchant: 'm\n' },
      { path: '/v1/x\r' },
      { query: 'a=1\r\nb=2' },
      { idempotencyKey: 'k\n' },
      { nonce: '0123456789abcdef\n' },
      { timestamp: '1\r' },
      { method: 'PO\nST' },
    ]) {
      expect(() => hmacV1StringToSign({ ...base, ...bad })).toThrow(CryptoChiefError);
      expect(() => signHmacV1({ ...base, ...bad }, base.merchant)).toThrow(CryptoChiefError);
    }
    // Line breaks in the body are fine: the body enters only as its hash.
    expect(() => hmacV1StringToSign({ ...base, body: '{\r\n}\n' })).not.toThrow();
  });
});

// The method line is upper-cased over a-z only: the HTTP method is an RFC 9110
// token, and a Unicode mapping would rewrite bytes outside that range and
// diverge from the server.
describe('HMAC v1 method', () => {
  const methodLine = (method: string): string => {
    const sts = hmacV1StringToSign({
      timestamp: '1789430400',
      nonce: '0123456789abcdef0123456789abcdef',
      method,
      path: '/v1/credits/balance',
      merchant: 'M1',
    });
    const lines = sts.split('\n');
    expect(lines.length).toBe(9);
    return lines[3]!;
  };

  it('upper-cases a-z', () => {
    for (const [method, want] of Object.entries({
      post: 'POST',
      POST: 'POST',
      PoSt: 'POST',
      pOsT: 'POST',
      get: 'GET',
      delete: 'DELETE',
      'x-my.method': 'X-MY.METHOD',
    })) {
      expect(methodLine(method)).toBe(want);
    }
  });

  it('leaves every other byte alone', () => {
    for (const [method, want] of Object.entries({
      pıng: 'PıNG', // ı LATIN SMALL LETTER DOTLESS I
      getµ: 'GETµ', // µ MICRO SIGN
      getß: 'GETß', // ß LATIN SMALL LETTER SHARP S
      poﬅ: 'POﬅ', // ﬅ LATIN SMALL LIGATURE LONG S T
      poﬆ: 'POﬆ', // ﬆ LATIN SMALL LIGATURE ST
      poİst: 'POİST', // İ LATIN CAPITAL LETTER I WITH DOT ABOVE
      ｐｏｓｔ: 'ｐｏｓｔ', // full-width post
      пост: 'пост', // Cyrillic
      'get🚀': 'GET🚀',
    })) {
      const got = methodLine(method);
      expect(got).toBe(want);
      // Same bytes, same length: only a-z changed.
      expect(Buffer.byteLength(got, 'utf8')).toBe(Buffer.byteLength(method, 'utf8'));
      for (let i = 0; i < method.length; i++) {
        const c = method[i]!;
        if (c >= 'a' && c <= 'z') continue;
        expect(got[i]).toBe(c);
      }
    }
  });

  it('is what the server reads back', () => {
    const v = requestVector('method_lowercase');
    expect(v.method).toBe('post');
    expect(v.string_to_sign.split('\n')[3]).toBe('POST');
    expect(verify(v)).toBe('ok');
  });
});

// An empty key, or one of spaces and tabs only, is no key: signing fails and the
// server refuses the request.
describe('HMAC v1 blank api key', () => {
  const v = requestVector('wallets_info');

  it('is an error when signing', () => {
    for (const key of ['', ' ', '\t', ' \t ', '   ']) {
      expect(() => signHmacV1(inputOf(v), key)).toThrow(CryptoChiefError);
      expect(() => signHmacV1(inputOf(v), key)).toThrow('apiKey is required');
    }
  });

  it('is a refusal when verifying', () => {
    for (const key of ['', ' ', '\t', ' \t ']) {
      const signed = checkHmacV1(requestOf(v), { keys: { [v.merchant]: key }, nowSec: v.now });
      expect(signed).toBe('invalid_signature');
    }
    // No project at all is the same refusal.
    expect(checkHmacV1(requestOf(v), { keys: {}, nowSec: v.now })).toBe('invalid_signature');
    expect(verify(v)).toBe('ok');
  });
});

describe('HMAC v1 error codes', () => {
  it('match the gateway', () => {
    expect(ErrorCode.BadAuthHeaders).toBe('BAD_AUTH_HEADERS');
    expect(ErrorCode.SignatureTimestampOutOfRange).toBe('SIGNATURE_TIMESTAMP_OUT_OF_RANGE');
    expect(ErrorCode.InvalidSignature).toBe('INVALID_SIGNATURE');
    expect(ErrorCode.SignatureReplayed).toBe('SIGNATURE_REPLAYED');
    expect(ErrorCode.PayloadTooLarge).toBe('PAYLOAD_TOO_LARGE');
  });
});
