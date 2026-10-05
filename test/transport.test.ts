import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { ApiError, ErrorCode, isApiError, isRetryable } from '../src/errors';
import { networkError, parseApiError } from '../src/transport';
import { waitForTerminal } from '../src/poll';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (attempt: number, c: Captured) => Response, overrides: Partial<ClientOptions> = {}) {
  let attempt = 0;
  const calls: Captured[] = [];
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const c = { url, init };
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

describe('transport', () => {
  it('sends the snake_case JSON body and sets the auth headers', async () => {
    const { client, calls } = makeClient(
      () => new Response(JSON.stringify({ amount_to_receive: '0.0099', fee_info: { fee_mode: 'service' } }), { status: 200 }),
    );
    const res = await client.payouts.estimate({
      network: 'ETH_SEPOLIA',
      coin: 'ETH',
      amount: '0.0001',
      toAddress: '0xAbC',
      fromAddresses: ['0x111', '0x222'],
    });
    // camelCase conversion of the response.
    expect(res.amountToReceive).toBe('0.0099');
    expect(res.feeInfo?.feeMode).toBe('service');

    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/payout/estimate');
    expect(c.init.method).toBe('POST');
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Merchant']).toBe('M1');
    expect(headers['Content-Type']).toBe('application/json');

    // Body is the snake_case JSON of the request; no Signature header.
    expect(JSON.parse(c.init.body as string)).toEqual({
      amount: '0.0001',
      coin: 'ETH',
      from_addresses: ['0x111', '0x222'],
      network: 'ETH_SEPOLIA',
      to_address: '0xAbC',
    });
    expect(headers).not.toHaveProperty('Signature');
    expect(headers['X-CC-Signature']).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it('maps an error envelope to ApiError with a stable code', async () => {
    const { client } = makeClient(
      () => new Response(JSON.stringify({ error: 'SERVICE_ERROR', msg: 'INSUFFICIENT_FUNDS', ok: false }), { status: 400 }),
    );
    try {
      await client.payouts.info('u1');
      throw new Error('expected rejection');
    } catch (err) {
      expect(isApiError(err, ErrorCode.InsufficientFunds)).toBe(true);
      expect((err as ApiError).httpStatus).toBe(400);
    }
  });

  it('takes the code from `error` when the gateway itself refused', async () => {
    const body = JSON.stringify({ ok: false, error: 'LABEL_TOO_LONG', msg: 'label is longer than 255 characters' });
    const { client } = makeClient(() => new Response(body, { status: 400 }));
    try {
      await client.wallets.setLabel('0xAbC', 'x'.repeat(256));
      throw new Error('expected rejection');
    } catch (err) {
      // The constant this SDK publishes has to match - it is the whole point of publishing it.
      expect(isApiError(err, ErrorCode.LabelTooLong)).toBe(true);
      const e = err as ApiError;
      expect(e.code).toBe(ErrorCode.LabelTooLong);
      expect(e.httpStatus).toBe(400);
      // The sentence is still reachable, and the body is untouched.
      expect(e.message).toContain('label is longer than 255 characters');
      expect(e.raw).toBe(body);
    }
  });

  it('takes the code from `msg` when SERVICE_ERROR relays an upstream refusal', async () => {
    const body = JSON.stringify({ ok: false, error: 'SERVICE_ERROR', msg: 'wallet_not_found' });
    const { client } = makeClient(() => new Response(body, { status: 404 }));
    try {
      await client.wallets.info('0xAbC');
      throw new Error('expected rejection');
    } catch (err) {
      const e = err as ApiError;
      expect(isApiError(e)).toBe(true);
      expect(e.code).toBe('wallet_not_found');
      expect(e.httpStatus).toBe(404);
      expect(e.raw).toBe(body);
    }
  });

  it('resolves the code from either envelope shape', () => {
    // Gateway-decided refusal: code in `error`, sentence in `msg`.
    const gw = parseApiError(400, JSON.stringify({ ok: false, error: 'LABEL_TOO_LONG', msg: 'label is longer than 255 characters' }));
    expect(gw.code).toBe(ErrorCode.LabelTooLong);
    expect(gw.message).toContain('label is longer than 255 characters');

    // Relayed refusal: `error` is the generic marker, code in `msg`.
    expect(parseApiError(400, JSON.stringify({ ok: false, error: 'SERVICE_ERROR', msg: 'INSUFFICIENT_FUNDS' })).code).toBe(
      ErrorCode.InsufficientFunds,
    );
    expect(parseApiError(404, JSON.stringify({ ok: false, error: 'SERVICE_ERROR', msg: 'wallet_not_found' })).code).toBe('wallet_not_found');

    // Other gateway codes, with and without a sentence beside them.
    expect(parseApiError(402, JSON.stringify({ ok: false, error: 'INSUFFICIENT_CREDITS', msg: 'not enough credits' })).code).toBe(
      ErrorCode.InsufficientCredits,
    );
    expect(parseApiError(400, JSON.stringify({ ok: false, error: 'INVALID_PARAMS' })).code).toBe(ErrorCode.InvalidParams);

    // SERVICE_ERROR with nothing in `msg` is all the API said - keep it.
    expect(parseApiError(500, JSON.stringify({ ok: false, error: 'SERVICE_ERROR' })).code).toBe(ErrorCode.ServiceError);

    // Empty and non-JSON bodies fall back to the status.
    expect(parseApiError(502, '{}').code).toBe('HTTP_502');
    expect(parseApiError(502, '<html>bad gateway</html>').code).toBe('HTTP_502');
    expect(parseApiError(502, '<html>bad gateway</html>').raw).toBe('<html>bad gateway</html>');
  });

  it('resolves the code and server_time from the gateway and installation envelopes', () => {
    const gw = parseApiError(
      401,
      JSON.stringify({ ok: false, error: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', msg: 'X-CC-Timestamp differs', server_time: 1_789_430_400 }),
    );
    expect(gw.code).toBe(ErrorCode.SignatureTimestampOutOfRange);
    expect(gw.message).toContain('X-CC-Timestamp differs');
    expect(gw.serverTime).toBe(1_789_430_400);

    const bodyWl = JSON.stringify({
      data: null,
      error: {
        status: 401,
        name: 'UnauthorizedError',
        message: 'X-CC-Timestamp differs from server time by more than 300 seconds',
        details: { code: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', server_time: 1_789_430_401 },
      },
      server_time: 1_789_430_401,
    });
    const wl = parseApiError(401, bodyWl);
    expect(wl.code).toBe(ErrorCode.SignatureTimestampOutOfRange);
    expect(wl.httpStatus).toBe(401);
    expect(wl.message).toContain('X-CC-Timestamp differs from server time by more than 300 seconds');
    expect(wl.serverTime).toBe(1_789_430_401);
    expect(wl.raw).toBe(bodyWl);

    // server_time only in details.
    expect(
      parseApiError(
        401,
        JSON.stringify({ data: null, error: { status: 401, name: 'UnauthorizedError', message: 'x', details: { code: 'SIGNATURE_TIMESTAMP_OUT_OF_RANGE', server_time: 7 } } }),
      ).serverTime,
    ).toBe(7);

    for (const code of ['SIGNATURE_REPLAYED', 'INVALID_SIGNATURE', 'BAD_AUTH_HEADERS', 'PAYLOAD_TOO_LARGE']) {
      const e = parseApiError(401, JSON.stringify({ data: null, error: { status: 401, name: 'UnauthorizedError', message: 'm', details: { code } } }));
      expect(e.code).toBe(code);
      expect(e.serverTime).toBeUndefined();
    }

    // No details.code: error.name; nothing usable: HTTP_<status>.
    expect(parseApiError(404, JSON.stringify({ data: null, error: { status: 404, name: 'NotFoundError', message: 'not found', details: {} } })).code).toBe(
      'NotFoundError',
    );
    expect(parseApiError(400, JSON.stringify({ data: null, error: { details: {} } })).code).toBe('HTTP_400');
    expect(parseApiError(400, JSON.stringify({ ok: false, error: 'INVALID_PARAMS', server_time: '5' })).serverTime).toBeUndefined();
  });

  it.each([502, 503, 504])('retries %d then succeeds', async (status) => {
    const { client, calls } = makeClient((attempt) =>
      attempt === 0
        ? new Response('upstream', { status })
        : new Response(JSON.stringify({ uuid: 'u1', status: 'queue' }), { status: 200 }),
    );
    const res = await client.payouts.info('u1');
    expect(res.uuid).toBe('u1');
    expect(calls.length).toBe(2);
  });

  it.each([502, 503, 504])('makes retries+1 attempts while %d persists, then throws it', async (status) => {
    const { client, calls } = makeClient(() => new Response('upstream', { status }), { retries: 2 });
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).httpStatus).toBe(status);
    expect((err as ApiError).code).toBe(`HTTP_${status}`);
    expect(calls.length).toBe(3);
  });

  it('makes 4 attempts on a persistent 503 with the default retries', async () => {
    const { client, calls } = makeClient(() => new Response('upstream', { status: 503 }));
    await expect(client.payouts.info('u1')).rejects.toBeInstanceOf(ApiError);
    expect(calls.length).toBe(4);
  });

  it('attempts a 500 exactly once', async () => {
    const body = JSON.stringify({ ok: false, error: 'INTERNAL_ERROR', msg: 'internal error' });
    const { client, calls } = makeClient(() => new Response(body, { status: 500 }));
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).httpStatus).toBe(500);
    expect((err as ApiError).code).toBe('INTERNAL_ERROR');
    expect((err as ApiError).message).toBe('cryptochief: 500 INTERNAL_ERROR: internal error');
    expect((err as ApiError).raw).toBe(body);
    expect(calls.length).toBe(1);
  });

  it.each([429, 501, 505, 507, 520, 599])('attempts a %d exactly once', async (status) => {
    const { client, calls } = makeClient(() => new Response('nope', { status }));
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).httpStatus).toBe(status);
    expect(calls.length).toBe(1);
  });

  it('stops at a 500 that follows a retried 503', async () => {
    const { client, calls } = makeClient((attempt) =>
      new Response('x', { status: attempt === 0 ? 503 : 500 }),
    );
    const err = await client.payouts.info('u1').catch((e: unknown) => e);
    expect((err as ApiError).httpStatus).toBe(500);
    expect(calls.length).toBe(2);
  });

  it('does NOT retry 4xx', async () => {
    const { client, calls } = makeClient(() => new Response(JSON.stringify({ error: 'INVALID_PARAMS', ok: false }), { status: 400 }));
    await expect(client.payouts.info('x')).rejects.toBeInstanceOf(ApiError);
    expect(calls.length).toBe(1);
  });

  it('retries transport/network errors', async () => {
    let attempt = 0;
    const calls: number[] = [];
    const fetchMock = async (): Promise<Response> => {
      calls.push(attempt);
      if (attempt++ === 0) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ uuid: 'u2' }), { status: 200 });
    };
    const client = new CryptoChiefClient({
      merchantId: 'M',
      apiKey: 'k',
      fetch: fetchMock,
      retryBackoff: { baseMs: 1, maxMs: 2 },
    });
    const res = await client.payouts.info('u2');
    expect(res.uuid).toBe('u2');
    expect(calls.length).toBe(2);
  });

  it('makes retries+1 attempts while the network keeps failing, then throws NETWORK_ERROR', async () => {
    let calls = 0;
    const client = new CryptoChiefClient({
      merchantId: 'M',
      apiKey: 'k',
      fetch: async () => {
        calls++;
        throw new TypeError('fetch failed');
      },
      retries: 2,
      retryBackoff: { baseMs: 1, maxMs: 2 },
    });
    const err = await client.payouts.info('u2').catch((e: unknown) => e);
    expect(isApiError(err, ErrorCode.NetworkError)).toBe(true);
    expect((err as ApiError).httpStatus).toBe(0);
    expect((err as ApiError).message).toBe('cryptochief: NETWORK_ERROR');
    expect(calls).toBe(3);
  });

  it('retries a response body that fails to read', async () => {
    const { client, calls } = makeClient((attempt) =>
      attempt === 0
        ? new Response(new ReadableStream({ start: (c) => c.error(new Error('socket reset')) }), { status: 200 })
        : new Response(JSON.stringify({ uuid: 'u3' }), { status: 200 }),
    );
    const res = await client.payouts.info('u3');
    expect(res.uuid).toBe('u3');
    expect(calls.length).toBe(2);
  });

  it('propagates caller cancellation without retrying', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, calls } = makeClient(() => new Response('{}', { status: 200 }));
    await expect(client.payouts.info('x', { signal: ac.signal })).rejects.toBeTruthy();
    expect(calls.length).toBe(0);
  });
});

describe('isRetryable', () => {
  it('accepts 502, 503, 504 and network errors only', () => {
    for (const status of [502, 503, 504]) {
      expect(isRetryable(parseApiError(status, 'upstream'))).toBe(true);
    }
    for (const status of [400, 401, 404, 409, 429, 500, 501, 505, 507, 520, 599]) {
      expect(isRetryable(parseApiError(status, 'x'))).toBe(false);
    }
    expect(isRetryable(parseApiError(500, JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' })))).toBe(false);
    expect(isRetryable(parseApiError(500, JSON.stringify({ ok: false, error: 'NETWORK_ERROR' })))).toBe(false);
    expect(isRetryable(networkError('connect ECONNREFUSED'))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new ApiError({ code: 'SOMETHING_ELSE' }))).toBe(false);
    expect(isRetryable('fetch failed')).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('waitForTerminal', () => {
  const poll = { intervalMs: 1, timeoutMs: 5_000 };

  it('throws a 500 on the first poll', async () => {
    let calls = 0;
    const err = await waitForTerminal(
      async () => {
        calls++;
        throw parseApiError(500, JSON.stringify({ ok: false, error: 'INTERNAL_ERROR' }));
      },
      () => true,
      poll,
    ).catch((e: unknown) => e);
    expect((err as ApiError).httpStatus).toBe(500);
    expect(calls).toBe(1);
  });

  it('polls again after a 503 or a network error', async () => {
    let calls = 0;
    const res = await waitForTerminal(
      async () => {
        calls++;
        if (calls === 1) throw parseApiError(503, 'upstream');
        if (calls === 2) throw networkError('socket hang up');
        return 'done';
      },
      (v) => v === 'done',
      poll,
    );
    expect(res).toBe('done');
    expect(calls).toBe(3);
  });
});
