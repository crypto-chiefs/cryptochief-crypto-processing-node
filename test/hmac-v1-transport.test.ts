import { afterEach, describe, it, expect, vi } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { ApiError, ErrorCode, isApiError } from '../src/errors';
import { signHmacV1 } from '../src/sign';
import { REQUEST_VECTORS_SHA256, requestVector, requestVectorsSha256 } from './hmac-v1-vectors';

const nonceCtl = vi.hoisted(() => ({ hex: undefined as string | undefined }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  const randomBytes = (size: number) =>
    nonceCtl.hex !== undefined ? Buffer.from(nonceCtl.hex, 'hex') : actual.randomBytes(size);
  return { ...actual, randomBytes };
});

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeClient(handler: (attempt: number, c: Captured) => Response, overrides: Partial<ClientOptions> = {}) {
  let attempt = 0;
  const calls: Captured[] = [];
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
    const c = {
      url,
      method: init.method as string,
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body as string | undefined,
    };
    calls.push(c);
    return handler(attempt++, c);
  };
  const client = new CryptoChiefClient({
    merchantId: 'M1',
    apiKey: 'secret',
    fetch: fetchMock,
    retryBackoff: { baseMs: 1, maxMs: 2 },
    ...overrides,
  });
  return { client, calls };
}

function hmacFor(
  c: Captured,
  path: string,
  query: string,
  merchant = 'M1',
  apiKey = 'secret',
  idempotencyKey = '',
  method = 'POST',
): string {
  return signHmacV1(
    {
      timestamp: c.headers['X-CC-Timestamp']!,
      nonce: c.headers['X-CC-Nonce']!,
      method,
      path,
      query,
      merchant,
      idempotencyKey,
      body: c.body,
    },
    apiKey,
  );
}

const ok = () => new Response(JSON.stringify({ uuid: 'u1', status: 'queue' }), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
  nonceCtl.hex = undefined;
});

describe('HMAC v1 transport', () => {
  it('reads the gateway vector file', () => {
    expect(requestVectorsSha256).toBe(REQUEST_VECTORS_SHA256);
  });

  it('sends the gateway vector signature for the same request', async () => {
    for (const name of ['wallets_info', 'empty_body', 'idempotency_key_payout_execute']) {
      const v = requestVector(name);
      nonceCtl.hex = v.nonce;
      vi.spyOn(Date, 'now').mockReturnValue(Number(v.timestamp) * 1000 + 999);
      const { client, calls } = makeClient(() => new Response('{}', { status: 200 }), {
        merchantId: v.merchant,
        apiKey: v.api_key,
      });
      const body = v.body === '' ? undefined : JSON.parse(v.body);
      const opts = v.idempotency_key === '' ? undefined : { idempotencyKey: v.idempotency_key };
      await client.request(v.path, body, opts);
      const c = calls[0]!;
      expect(c.body ?? '').toBe(v.body);
      expect(c.headers['X-CC-Timestamp']).toBe(v.timestamp);
      expect(c.headers['X-CC-Nonce']).toBe(v.nonce);
      expect(c.headers['X-CC-Signature']).toBe('v1=' + v.signature);
      vi.restoreAllMocks();
    }
  });

  it('sends the gateway vector signature for a signed GET', async () => {
    const v = requestVector('get_query_empty_body');
    nonceCtl.hex = v.nonce;
    vi.spyOn(Date, 'now').mockReturnValue(Number(v.timestamp) * 1000 + 999);
    const { client, calls } = makeClient(() => new Response('{}', { status: 200 }), {
      merchantId: v.merchant,
      apiKey: v.api_key,
    });
    await client.send(v.method, `${v.path}?${v.query}`);
    const c = calls[0]!;
    expect(c.method).toBe('GET');
    expect(c.body).toBeUndefined();
    expect(c.headers).not.toHaveProperty('Content-Type');
    expect(c.headers['X-CC-Signature']).toBe('v1=' + v.signature);
  });

  // The vectors whose point is the path, the query and the method: the client is
  // given the request as a caller writes it and has to reach the same signature.
  it('sends the gateway vector signature for the path, query and method records', async () => {
    const cases: [string, string, string][] = [
      // Percent-decoded path: %2F, %20 and non-ASCII decode into the signature.
      [
        'path_percent_decoded',
        'GET',
        '/v1/payments/order/info/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%20%E2%84%961/ord%2F1',
      ],
      // Raw query: escapes and "+" are signed exactly as the URL carries them.
      [
        'query_raw_percent_encoded',
        'GET',
        '/v1/payments/history?id=ord%2F1&name=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%20%E2%84%961&note=a+b',
      ],
      ['method_mixed_case', 'PoSt', '/v1/credits/balance'],
    ];
    for (const [name, method, path] of cases) {
      const v = requestVector(name);
      expect(v.method).toBe(method);
      nonceCtl.hex = v.nonce;
      vi.spyOn(Date, 'now').mockReturnValue(Number(v.timestamp) * 1000 + 999);
      const { client, calls } = makeClient(() => new Response('{}', { status: 200 }), {
        merchantId: v.merchant,
        apiKey: v.api_key,
      });
      await client.send(method, path);
      const c = calls[0]!;
      expect(c.url).toBe('https://api-processing.crypto-chief.com' + path);
      expect(c.method).toBe(method.replace(/[a-z]/g, (x) => x.toUpperCase()));
      expect(c.headers['X-CC-Signature']).toBe('v1=' + v.signature);
      vi.restoreAllMocks();
    }
  });

  it('sends the HMAC v1 headers and no Signature', async () => {
    const now = 1_789_430_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { client, calls } = makeClient(ok);
    await client.payouts.info('u1');
    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/payout/info');
    expect(c.headers['Merchant']).toBe('M1');
    expect(c.body).toBe('{"uuid":"u1"}');
    expect(c.headers).not.toHaveProperty('Signature');
    expect(c.headers['X-CC-Timestamp']).toBe(String(now / 1000));
    expect(c.headers['X-CC-Nonce']).toMatch(/^[0-9a-f]{32}$/);
    expect(c.headers['X-CC-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
    expect(c.headers['X-CC-Signature']).toBe(hmacFor(c, '/v1/payout/info', ''));
  });

  it('trims merchantId once and signs the value sent in Merchant', async () => {
    nonceCtl.hex = '00112233445566778899aabbccddeeff';
    vi.spyOn(Date, 'now').mockReturnValue(1_789_430_400_000);
    const sent: Captured[] = [];
    for (const merchantId of [' M1 ', '\tM1\r\n', 'M1']) {
      const { client, calls } = makeClient(ok, { merchantId });
      expect(client.merchantId).toBe('M1');
      await client.payouts.info('u1');
      sent.push(calls[0]!);
    }
    for (const c of sent) {
      expect(c.headers['Merchant']).toBe('M1');
      expect(c.headers['X-CC-Signature']).toBe(hmacFor(c, '/v1/payout/info', '', 'M1'));
      expect(c.headers['X-CC-Signature']).toBe(sent[2]!.headers['X-CC-Signature']);
    }
  });

  it('rejects a blank merchantId', () => {
    expect(() => makeClient(ok, { merchantId: ' \t\n' })).toThrow('merchantId is required');
  });

  it('recomputes timestamp, nonce and signature on every retry', async () => {
    let now = 1_789_430_400_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { client, calls } = makeClient((attempt) => {
      now += 7_000;
      return attempt < 2 ? new Response('upstream', { status: 503 }) : ok();
    });
    await client.payouts.info('u1');
    expect(calls.length).toBe(3);
    const ts = calls.map((c) => c.headers['X-CC-Timestamp']);
    expect(ts).toEqual(['1789430400', '1789430407', '1789430414']);
    expect(new Set(calls.map((c) => c.headers['X-CC-Nonce'])).size).toBe(3);
    expect(new Set(calls.map((c) => c.headers['X-CC-Signature'])).size).toBe(3);
    for (const c of calls) {
      expect(c.headers['X-CC-Signature']).toBe(hmacFor(c, '/v1/payout/info', ''));
      expect(c.body).toBe(calls[0]!.body);
    }
  });

  it('signs the route path without the base URL prefix, and the query from the URL', async () => {
    const { client, calls } = makeClient(ok, { baseUrl: 'https://wl.example/platform/' });
    await client.request('/v1/payments/history?a=1&b=2', {});
    const c = calls[0]!;
    expect(c.url).toBe('https://wl.example/platform/v1/payments/history?a=1&b=2');
    expect(c.headers['X-CC-Signature']).toBe(hmacFor(c, '/v1/payments/history', 'a=1&b=2'));
  });

  it('signs the percent-decoded path and the encoded query', async () => {
    const cases: [string, string, string][] = [
      ['/v1/orders/payout%2F8814', '/v1/orders/payout/8814', ''],
      ['/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7', '/v1/orders/заказ', ''],
      ['/v1/orders/a%20b?q=a%2Fb&r=%20', '/v1/orders/a b', 'q=a%2Fb&r=%20'],
      // Percent-decoded path with %2F, %20 and non-ASCII at once; the query
      // keeps its own escapes, including a non-ASCII value.
      [
        '/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F%E2%84%9642%20b?q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F1&r=a%20b',
        '/v1/orders/заказ/№42 b',
        'q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F1&r=a%20b',
      ],
      ['/v1/payout/info', '/v1/payout/info', ''],
    ];
    for (const [path, signedPath, signedQuery] of cases) {
      const { client, calls } = makeClient(ok);
      await client.request(path, {});
      const c = calls[0]!;
      expect(c.url).toBe('https://api-processing.crypto-chief.com' + path);
      expect(c.headers['X-CC-Signature']).toBe(hmacFor(c, signedPath, signedQuery));
    }
  });

  // A path and a query that are not percent-encoded at all: fetch encodes them
  // on the wire, and the server decodes the path back to what was signed.
  it('signs a path and query written as text', async () => {
    const { client, calls } = makeClient(ok);
    await client.request('/v1/orders/заказ №42?q=заказ 1', {});
    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/orders/заказ №42?q=заказ 1');
    expect(c.headers['X-CC-Signature']).toBe(
      hmacFor(c, '/v1/orders/заказ №42', 'q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%201'),
    );
  });

  it('rejects a path that is not valid percent-encoding before sending', async () => {
    const { client, calls } = makeClient(ok);
    await expect(client.request('/v1/orders/100%', {})).rejects.toThrow(
      'path is not valid percent-encoding',
    );
    expect(calls.length).toBe(0);
  });

  it('signs and sends any HTTP method, upper-cased over a-z', async () => {
    for (const [method, sent] of Object.entries({ GET: 'GET', get: 'GET', PaTcH: 'PATCH', delete: 'DELETE' })) {
      const { client, calls } = makeClient(ok);
      await client.send(method, '/v1/payments/order/info?uuid=u1');
      const c = calls[0]!;
      expect(c.method).toBe(sent);
      expect(c.headers['X-CC-Signature']).toBe(
        hmacFor(c, '/v1/payments/order/info', 'uuid=u1', 'M1', 'secret', '', sent),
      );
    }
  });

  it('refuses a method that is not an RFC 9110 token, and a body on GET', async () => {
    const { client, calls } = makeClient(ok);
    for (const method of ['пост', 'poﬅ', 'GET POST', 'GET\n', '']) {
      await expect(client.send(method, '/v1/payout/info', { uuid: 'u1' })).rejects.toThrow(
        'HTTP method must be an RFC 9110 token',
      );
    }
    for (const method of ['GET', 'head']) {
      await expect(client.send(method, '/v1/payout/info', { uuid: 'u1' })).rejects.toThrow(
        'cannot carry a body',
      );
    }
    expect(calls.length).toBe(0);
  });

  it('rejects a blank apiKey', () => {
    for (const apiKey of ['', ' ', '\t', ' \t ']) {
      expect(() => makeClient(ok, { apiKey })).toThrow('apiKey is required');
    }
  });

  it('signs and sends Idempotency-Key from the per-call options', async () => {
    const key = 'payout-2026-09-16-0001';
    const { client, calls } = makeClient(ok);
    await client.payouts.info('u1', { idempotencyKey: key });
    await client.request('/v1/payout/info', { uuid: 'u2' }, { idempotencyKey: key });
    await client.payouts.info('u3');
    expect(calls.map((c) => c.headers['Idempotency-Key'])).toEqual([key, key, undefined]);
    expect(calls[0]!.headers['X-CC-Signature']).toBe(
      hmacFor(calls[0]!, '/v1/payout/info', '', 'M1', 'secret', key),
    );
    // Signed with the key, so the signature without it does not match.
    expect(calls[0]!.headers['X-CC-Signature']).not.toBe(hmacFor(calls[0]!, '/v1/payout/info', ''));
    expect(calls[2]!.headers['X-CC-Signature']).toBe(hmacFor(calls[2]!, '/v1/payout/info', ''));
  });

  it('keeps the same Idempotency-Key across retries', async () => {
    const key = 'batch-7';
    const { client, calls } = makeClient((attempt) =>
      attempt < 2 ? new Response('upstream', { status: 503 }) : ok(),
    );
    await client.payouts.info('u1', { idempotencyKey: key });
    expect(calls.length).toBe(3);
    for (const c of calls) {
      expect(c.headers['Idempotency-Key']).toBe(key);
      expect(c.headers['X-CC-Signature']).toBe(
        hmacFor(c, '/v1/payout/info', '', 'M1', 'secret', key),
      );
    }
  });

  it('refuses an Idempotency-Key the server would not see as signed', async () => {
    const { client, calls } = makeClient(ok);
    for (const key of [' k', 'k ', '\tk', 'k\t', 'k\tk', 'k\r\n', 'ключ', 'k\u0000', ' ']) {
      await expect(client.payouts.info('u1', { idempotencyKey: key })).rejects.toThrow(
        'idempotencyKey must be printable ASCII',
      );
    }
    expect(calls.length).toBe(0);
    // An empty key is no key.
    await client.payouts.info('u1', { idempotencyKey: '' });
    expect(calls[0]!.headers).not.toHaveProperty('Idempotency-Key');
    expect(calls[0]!.headers['X-CC-Signature']).toBe(hmacFor(calls[0]!, '/v1/payout/info', ''));
    // Inner spaces are the server's to keep.
    await client.payouts.info('u1', { idempotencyKey: 'order 42' });
    expect(calls[1]!.headers['Idempotency-Key']).toBe('order 42');
  });

  it('corrects the clock once on SIGNATURE_TIMESTAMP_OUT_OF_RANGE and repeats', async () => {
    const now = 1_789_430_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const serverTime = 1_789_430_400 + 1_000;
    const { client, calls } = makeClient(
      (attempt) =>
        attempt === 0
          ? new Response(
              JSON.stringify({
                ok: false,
                error: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE',
                msg: 'X-CC-Timestamp differs from server time by more than 300 seconds',
                server_time: serverTime,
              }),
              { status: 401 },
            )
          : ok(),
      { retries: 0 },
    );
    await client.payouts.info('u1');
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers['X-CC-Timestamp']).toBe('1789430400');
    expect(calls[1]!.headers['X-CC-Timestamp']).toBe(String(serverTime));
    expect(calls[1]!.headers['X-CC-Nonce']).not.toBe(calls[0]!.headers['X-CC-Nonce']);
    expect(calls[1]!.headers['X-CC-Signature']).toBe(hmacFor(calls[1]!, '/v1/payout/info', ''));

    // The offset stays for later requests.
    await client.payouts.info('u2');
    expect(calls[2]!.headers['X-CC-Timestamp']).toBe(String(serverTime));
  });

  it('corrects the clock once on SIGNATURE_TIMESTAMP_OUT_OF_RANGE from the installation envelope', async () => {
    const now = 1_789_430_400_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const serverTime = 1_789_430_400 - 900;
    const refusal = JSON.stringify({
      data: null,
      error: {
        status: 401,
        name: 'UnauthorizedError',
        message: 'X-CC-Timestamp differs from server time by more than 300 seconds',
        details: { code: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', server_time: serverTime },
      },
      server_time: serverTime,
    });
    const { client, calls } = makeClient(
      (attempt) => (attempt === 0 ? new Response(refusal, { status: 401 }) : ok()),
      { baseUrl: 'https://wl.example/platform', retries: 0 },
    );
    await client.payouts.info('u1');
    expect(calls.length).toBe(2);
    expect(calls[0]!.headers['X-CC-Timestamp']).toBe('1789430400');
    expect(calls[1]!.headers['X-CC-Timestamp']).toBe(String(serverTime));
    expect(calls[1]!.headers['X-CC-Nonce']).not.toBe(calls[0]!.headers['X-CC-Nonce']);
    expect(calls[1]!.headers['X-CC-Signature']).toBe(hmacFor(calls[1]!, '/v1/payout/info', ''));

    // A second refusal in the same request is thrown with the parsed code.
    const again = makeClient(() => new Response(refusal, { status: 401 }), { baseUrl: 'https://wl.example/platform' });
    const err = await again.client.payouts.info('u1').catch((e: unknown) => e);
    expect(isApiError(err, ErrorCode.SignatureTimestampOutOfRange)).toBe(true);
    expect((err as ApiError).httpStatus).toBe(401);
    expect((err as ApiError).serverTime).toBe(serverTime);
    expect(again.calls.length).toBe(2);
  });

  it('does not repeat on installation SIGNATURE_REPLAYED', async () => {
    const body = JSON.stringify({
      data: null,
      error: { status: 401, name: 'UnauthorizedError', message: 'X-CC-Nonce has already been used', details: { code: 'SIGNATURE_REPLAYED' } },
    });
    const { client, calls } = makeClient(() => new Response(body, { status: 401 }));
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect(isApiError(err, ErrorCode.SignatureReplayed)).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('corrects the clock only once per request', async () => {
    const body = JSON.stringify({ ok: false, error: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', msg: 'x', server_time: 5 });
    const { client, calls } = makeClient(() => new Response(body, { status: 401 }));
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect(isApiError(err, ErrorCode.SignatureTimestampOutOfRange)).toBe(true);
    expect((err as ApiError).httpStatus).toBe(401);
    expect(calls.length).toBe(2);
  });

  it('does not repeat without server_time, nor on SIGNATURE_REPLAYED', async () => {
    for (const body of [
      { ok: false, error: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', msg: 'x' },
      { ok: false, error: 'SIGNATURE_REPLAYED', msg: 'X-CC-Nonce has already been used' },
    ]) {
      const { client, calls } = makeClient(() => new Response(JSON.stringify(body), { status: 401 }));
      const err = await client.payouts.info('u1').catch((e: unknown) => e);
      expect(isApiError(err, body.error)).toBe(true);
      expect(calls.length).toBe(1);
    }
  });
});
