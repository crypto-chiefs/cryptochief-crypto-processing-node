import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { ApiError, ErrorCode, isApiError } from '../src/errors';
import { canonicalJSON, sign } from '../src/sign';

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
  it('signs the canonical body and sets the auth headers', async () => {
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

    // Body is the snake_case canonical form; signature matches it.
    const expectedBody = canonicalJSON({
      amount: '0.0001',
      coin: 'ETH',
      from_addresses: ['0x111', '0x222'],
      network: 'ETH_SEPOLIA',
      to_address: '0xAbC',
    });
    expect(c.init.body).toBe(expectedBody);
    expect(headers['Signature']).toBe(sign(expectedBody, 'secret'));
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

  it('retries 5xx then succeeds', async () => {
    const { client, calls } = makeClient((attempt) =>
      attempt === 0
        ? new Response('upstream', { status: 503 })
        : new Response(JSON.stringify({ uuid: 'u1', status: 'queue' }), { status: 200 }),
    );
    const res = await client.payouts.info('u1');
    expect(res.uuid).toBe('u1');
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

  it('propagates caller cancellation without retrying', async () => {
    const ac = new AbortController();
    ac.abort();
    const { client, calls } = makeClient(() => new Response('{}', { status: 200 }));
    await expect(client.payouts.info('x', { signal: ac.signal })).rejects.toBeTruthy();
    expect(calls.length).toBe(0);
  });
});
