import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { PayInStatus } from '../src/services/payins';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (c: Captured) => Response, overrides: Partial<ClientOptions> = {}) {
  const calls: Captured[] = [];
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
    const c = { url, init };
    calls.push(c);
    return handler(c);
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

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('pay-in multi-payment response', () => {
  it('parses the accumulated amounts and every payment on order info', async () => {
    const { client } = makeClient(() =>
      json({
        type: 'PayIn',
        uuid: 'inv-1',
        order_id: 'o-1',
        status: 'wrong_amount_waiting',
        is_payment_multiple: true,
        amount_crypto: '10',
        received_amount_crypto: '6.5',
        remaining_amount_crypto: '3.5',
        payments: [
          { txid: '0xaaa', amount_crypto: '4', confirmations: 12, status: 'confirmed', seen_at: '2026-09-30T10:00:00Z' },
          { txid: '0xbbb', amount_crypto: '2.5', confirmations: 3, status: 'pending', seen_at: '2026-09-30T10:05:00Z' },
        ],
      }),
    );

    const p = await client.payIns.info('inv-1');

    expect(p.status).toBe(PayInStatus.WrongAmountWaiting);
    expect(p.isPaymentMultiple).toBe(true);
    expect(p.receivedAmountCrypto).toBe('6.5');
    expect(p.remainingAmountCrypto).toBe('3.5');
    expect(p.payments).toHaveLength(2);
    expect(p.payments?.[0]).toEqual({
      txid: '0xaaa',
      amountCrypto: '4',
      confirmations: 12,
      status: 'confirmed',
      seenAt: '2026-09-30T10:00:00Z',
    });
    expect(p.payments?.[1]?.txid).toBe('0xbbb');
    expect(p.payments?.reduce((sum, x) => sum + Number(x.amountCrypto), 0)).toBe(6.5);
  });

  it('parses the fields on history items and leaves them absent on an old order', async () => {
    const { client } = makeClient(() =>
      json({
        items: [
          {
            type: 'PayIn',
            uuid: 'inv-2',
            order_id: 'o-2',
            status: 'paid',
            is_payment_multiple: true,
            received_amount_crypto: '10',
            remaining_amount_crypto: '0',
            payments: [
              { txid: '0xccc', amount_crypto: '10', confirmations: 20, status: 'confirmed', seen_at: '2026-09-30T11:00:00Z' },
            ],
          },
          { type: 'PayIn', uuid: 'inv-old', order_id: 'o-0', status: 'paid' },
        ],
        meta: { total: 2, page: 1, page_size: 20 },
      }),
    );

    const { items } = await client.payIns.history();
    const [multi, old] = items;

    expect(multi!.isPaymentMultiple).toBe(true);
    expect(multi!.payments?.[0]?.seenAt).toBe('2026-09-30T11:00:00Z');
    expect(old!.isPaymentMultiple).toBeUndefined();
    expect(old!.receivedAmountCrypto).toBeUndefined();
    expect(old!.remainingAmountCrypto).toBeUndefined();
    expect(old!.payments).toBeUndefined();
    expect('payments' in old!).toBe(false);
  });
});
