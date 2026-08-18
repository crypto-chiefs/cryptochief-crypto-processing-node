import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
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

describe('credits', () => {
  it('posts a signed empty body to /v1/credits/balance and maps the full response', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            credits_balance: -15200000,
            usd_balance: '-1.52',
            is_postpaid: true,
            debt_limit_credits: 500000000,
            can_execute_gas_operations: false,
            gas_ops_min_credits: 3000000,
            timestamp: '2026-08-18T12:34:56Z',
          }),
          { status: 200 },
        ),
    );
    const res = await client.credits.balance();

    // Full camelCase mapping, including the negative pre-formatted USD string.
    expect(res.creditsBalance).toBe(-15200000);
    expect(res.usdBalance).toBe('-1.52');
    expect(res.isPostpaid).toBe(true);
    expect(res.debtLimitCredits).toBe(500000000);
    expect(res.canExecuteGasOperations).toBe(false);
    expect(res.gasOpsMinCredits).toBe(3000000);
    expect(res.timestamp).toBe('2026-08-18T12:34:56Z');

    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/credits/balance');
    expect(c.init.method).toBe('POST');
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Merchant']).toBe('M1');
    expect(headers['Content-Type']).toBe('application/json');

    // Body is the canonical empty object; signature matches it.
    const expectedBody = canonicalJSON({});
    expect(expectedBody).toBe('{}');
    expect(c.init.body).toBe(expectedBody);
    expect(headers['Signature']).toBe(sign(expectedBody, 'secret'));
  });

  it('posts a signed topup body omitting unset optional urls and maps the minimal response', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            invoice_id: 9107,
            payment_link: 'https://pay.crypto-chief.com/i/9107',
            amount: '25',
            currency: 'USDT',
            status: 'pending',
          }),
          { status: 200 },
        ),
    );
    // urlError is explicitly undefined to prove the case layer drops it too.
    const res = await client.credits.topup({ amount: '25', currency: 'USDT', urlError: undefined });

    expect(res.invoiceId).toBe(9107);
    expect(res.paymentLink).toBe('https://pay.crypto-chief.com/i/9107');
    expect(res.amount).toBe('25');
    expect(res.currency).toBe('USDT');
    expect(res.status).toBe('pending');
    expect(res.orderUuid).toBeUndefined();
    expect(res.expiredAt).toBeUndefined();

    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/credits/topup');
    expect(c.init.method).toBe('POST');
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Merchant']).toBe('M1');

    // Unset optional urls are omitted from the wire entirely, not sent as "".
    const expectedBody = canonicalJSON({ amount: '25', currency: 'USDT' });
    expect(expectedBody).toBe('{"amount":"25","currency":"USDT"}');
    expect(c.init.body).toBe(expectedBody);
    expect(c.init.body).not.toContain('url_success');
    expect(c.init.body).not.toContain('url_error');
    expect(headers['Signature']).toBe(sign(expectedBody, 'secret'));
  });

  it('sends snake_case redirect urls when set and maps order_uuid/expired_at', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            invoice_id: 9108,
            payment_link: 'https://pay.crypto-chief.com/i/9108',
            amount: '100000',
            currency: 'USDC',
            status: 'pending',
            order_uuid: '3f1c8a52-9d0e-4b7a-8f21-6c0d9e5a4b3c',
            expired_at: 1755522896,
          }),
          { status: 200 },
        ),
    );
    const res = await client.credits.topup({
      amount: '100000',
      currency: 'USDC',
      urlSuccess: 'https://shop.example/topup/ok',
      urlError: 'https://shop.example/topup/fail',
    });

    expect(res.invoiceId).toBe(9108);
    expect(res.paymentLink).toBe('https://pay.crypto-chief.com/i/9108');
    expect(res.amount).toBe('100000');
    expect(res.currency).toBe('USDC');
    expect(res.status).toBe('pending');
    expect(res.orderUuid).toBe('3f1c8a52-9d0e-4b7a-8f21-6c0d9e5a4b3c');
    expect(res.expiredAt).toBe(1755522896);

    const c = calls[0]!;
    expect(c.url).toBe('https://api-processing.crypto-chief.com/v1/credits/topup');

    // camelCase params reach the wire snake_cased, keys canonically sorted.
    const expectedBody = canonicalJSON({
      amount: '100000',
      currency: 'USDC',
      url_success: 'https://shop.example/topup/ok',
      url_error: 'https://shop.example/topup/fail',
    });
    expect(expectedBody).toBe(
      '{"amount":"100000","currency":"USDC","url_error":"https://shop.example/topup/fail","url_success":"https://shop.example/topup/ok"}',
    );
    expect(c.init.body).toBe(expectedBody);
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Signature']).toBe(sign(expectedBody, 'secret'));
  });
});
