import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { CryptoChiefError, ApiError } from '../src/errors';
import { NativeOrderStatus } from '../src/services/native';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (c: Captured) => Response) {
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
  });
  return { client, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const quote = (over: Record<string, unknown>) => ({
  ref: 'nq-7a3f01',
  network: 'ETH_MAINNET',
  receive_address: '0xRecipient',
  amount: '0.05',
  coin_price_usd: '133.25',
  transfer_fee: '0.00021',
  transfer_fee_usd: '0.56',
  subtotal_usd: '133.81',
  total_usd: '174.20',
  credits: 174200000,
  coin_usd: '2665.00000000',
  expires_at: '2026-09-18T12:01:30Z',
  expires_in_sec: 90,
  ...over,
});

const order = (over: Record<string, unknown>) => ({
  id: 4321,
  idempotency_key: 'native-2026-09-18-0001',
  status: 'delivered',
  network: 'ETH_MAINNET',
  receive_address: '0xRecipient',
  amount: '0.05',
  tx_hash: '0xabc123',
  transfer_fee: '0.00021',
  transfer_fee_usd: '0.56',
  coin_price_usd: '133.25',
  total_usd: '174.20',
  credits: 174200000,
  coin_usd: '2665.00000000',
  settled: true,
  needs_attention: false,
  created_at: '2026-09-18T12:00:00Z',
  delivered_at: '2026-09-18T12:00:11Z',
  ...over,
});

describe('native.quote', () => {
  it('posts the quote request snake_cased and maps the full quote', async () => {
    const { client, calls } = makeClient(() => json(200, quote({})));

    const q = await client.native.quote({
      network: 'ETH_MAINNET',
      receiveAddress: '0xRecipient',
      amount: '0.05',
    });

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/native\/quote$/);
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(c.init.body as string)).toEqual({
      network: 'ETH_MAINNET',
      receive_address: '0xRecipient',
      amount: '0.05',
    });

    expect(q.ref).toBe('nq-7a3f01');
    expect(q.network).toBe('ETH_MAINNET');
    expect(q.receiveAddress).toBe('0xRecipient');
    expect(q.amount).toBe('0.05');
    expect(q.coinPriceUsd).toBe('133.25');
    expect(q.transferFee).toBe('0.00021');
    expect(q.transferFeeUsd).toBe('0.56');
    expect(q.subtotalUsd).toBe('133.81');
    expect(q.totalUsd).toBe('174.20');
    expect(q.credits).toBe(174200000);
    expect(q.coinUsd).toBe('2665.00000000');
    expect(q.expiresAt).toBe('2026-09-18T12:01:30Z');
    expect(q.expiresInSec).toBe(90);
  });
});

describe('native.buy', () => {
  it('sends the Idempotency-Key header and maps a delivered order', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    const o = await client.native.buy(
      { network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' },
      { idempotencyKey: 'native-2026-09-18-0001' },
    );

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/native\/buy$/);
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('native-2026-09-18-0001');
    expect(JSON.parse(c.init.body as string)).toEqual({
      network: 'ETH_MAINNET',
      receive_address: '0xRecipient',
      amount: '0.05',
    });

    expect(o.id).toBe(4321);
    expect(o.idempotencyKey).toBe('native-2026-09-18-0001');
    expect(o.status).toBe(NativeOrderStatus.Delivered);
    expect(o.network).toBe('ETH_MAINNET');
    expect(o.amount).toBe('0.05');
    expect(o.txHash).toBe('0xabc123');
    expect(o.transferFee).toBe('0.00021');
    expect(o.coinPriceUsd).toBe('133.25');
    expect(o.totalUsd).toBe('174.20');
    expect(o.credits).toBe(174200000);
    expect(o.coinUsd).toBe('2665.00000000');
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
    expect(o.deliveredAt).toBe('2026-09-18T12:00:11Z');
  });

  it('buys at a quoted price when quoteRef is given', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    await client.native.buy({ quoteRef: 'nq-7a3f01' }, { idempotencyKey: 'native-2026-09-18-0001' });

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ quote_ref: 'nq-7a3f01' });
  });

  it('maps a refused order with no charge fields set', async () => {
    // Nothing was sent or charged: tx_hash / total_usd / credits are absent
    // rather than zero, while the fee/rate fields are always present - empty
    // ('') or zero ('0.00').
    const { client } = makeClient(() =>
      json(
        200,
        order({
          status: 'refused',
          tx_hash: undefined,
          transfer_fee: '',
          transfer_fee_usd: '0.00',
          coin_price_usd: '0.00',
          total_usd: undefined,
          credits: undefined,
          coin_usd: '0.00',
          delivered_at: undefined,
          error: 'no liquidity available',
          error_code: 'INSUFFICIENT_LIQUIDITY',
        }),
      ),
    );

    const o = await client.native.buy(
      { network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' },
      { idempotencyKey: 'native-2026-09-18-0001' },
    );

    expect(o.status).toBe(NativeOrderStatus.Refused);
    expect(o.txHash).toBeUndefined();
    expect(o.transferFee).toBe('');
    expect(o.transferFeeUsd).toBe('0.00');
    expect(o.coinPriceUsd).toBe('0.00');
    expect(o.totalUsd).toBeUndefined();
    expect(o.credits).toBeUndefined();
    expect(o.coinUsd).toBe('0.00');
    expect(o.deliveredAt).toBeUndefined();
    expect(o.error).toBe('no liquidity available');
    expect(o.errorCode).toBe('INSUFFICIENT_LIQUIDITY');
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
  });

  it('recovers a refused order from a 502 instead of throwing', async () => {
    // A refused order answers 502 with the order itself as the body - a
    // business outcome, not a transport failure.
    const { client } = makeClient(() =>
      json(
        502,
        order({
          status: 'refused',
          tx_hash: undefined,
          transfer_fee: '',
          transfer_fee_usd: '0.00',
          coin_price_usd: '0.00',
          total_usd: undefined,
          credits: undefined,
          coin_usd: '0.00',
          delivered_at: undefined,
          error: 'no liquidity available',
          error_code: 'INSUFFICIENT_LIQUIDITY',
        }),
      ),
    );

    const o = await client.native.buy(
      { network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' },
      { idempotencyKey: 'native-2026-09-18-0001' },
    );

    expect(o.status).toBe(NativeOrderStatus.Refused);
    expect(o.errorCode).toBe('INSUFFICIENT_LIQUIDITY');
    expect(o.credits).toBeUndefined();
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
  });

  it('recovers an unresolved order from a 409 instead of throwing', async () => {
    // The transfer's outcome never arrived: the coins may already be sent, so
    // the order must be followed, not retried.
    const { client } = makeClient(() =>
      json(
        409,
        order({
          status: 'unresolved',
          tx_hash: undefined,
          delivered_at: undefined,
          settled: false,
          needs_attention: true,
          error: 'supplier call timed out',
          error_code: 'SUPPLIER_TIMEOUT',
        }),
      ),
    );

    const o = await client.native.buy(
      { network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' },
      { idempotencyKey: 'native-2026-09-18-0001' },
    );

    expect(o.status).toBe(NativeOrderStatus.Unresolved);
    expect(o.settled).toBe(false);
    expect(o.needsAttention).toBe(true);
    expect(o.errorCode).toBe('SUPPLIER_TIMEOUT');
  });

  it('recovers a refused order from a 402 when the credits balance is short', async () => {
    const { client } = makeClient(() =>
      json(
        402,
        order({
          status: 'refused',
          tx_hash: undefined,
          transfer_fee: '',
          transfer_fee_usd: '0.00',
          coin_price_usd: '0.00',
          total_usd: undefined,
          credits: undefined,
          coin_usd: '0.00',
          delivered_at: undefined,
          error: 'your credit balance will not cover this order',
          error_code: 'INSUFFICIENT_CREDITS',
        }),
      ),
    );

    const o = await client.native.buy(
      { network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' },
      { idempotencyKey: 'native-2026-09-18-0001' },
    );

    expect(o.status).toBe(NativeOrderStatus.Refused);
    expect(o.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(o.credits).toBeUndefined();
  });

  it('throws an ApiError for an error envelope with no order to report', async () => {
    // `ok:false` is an error envelope, not an order - a spent quote has no
    // order to recover.
    const { client } = makeClient(() =>
      json(409, { ok: false, error: 'QUOTE_EXPIRED', msg: 'the quote has expired' }),
    );

    const err = await client.native
      .buy({ quoteRef: 'nq-7a3f01' }, { idempotencyKey: 'native-2026-09-18-0001' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).httpStatus).toBe(409);
    expect((err as ApiError).code).toBe('QUOTE_EXPIRED');
  });

  it('refuses to send without an idempotency key', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    await expect(client.native.buy({ network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' })).rejects.toThrow(
      CryptoChiefError,
    );
    await expect(
      client.native.buy({ network: 'ETH_MAINNET', receiveAddress: '0xRecipient', amount: '0.05' }, {}),
    ).rejects.toThrow(/idempotencyKey/);
    expect(calls).toHaveLength(0);
  });
});

describe('native.order', () => {
  it('fetches an order by its idempotency key', async () => {
    const { client, calls } = makeClient(() =>
      json(
        200,
        order({
          status: 'unresolved',
          tx_hash: undefined,
          transfer_fee: undefined,
          transfer_fee_usd: undefined,
          coin_price_usd: undefined,
          total_usd: undefined,
          credits: undefined,
          coin_usd: undefined,
          delivered_at: undefined,
          settled: false,
          needs_attention: true,
          error: 'supplier call timed out',
        }),
      ),
    );

    const o = await client.native.order('native-2026-09-18-0001');

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/native\/order$/);
    expect(JSON.parse(c.init.body as string)).toEqual({ key: 'native-2026-09-18-0001' });

    expect(o.status).toBe(NativeOrderStatus.Unresolved);
    expect(o.settled).toBe(false);
    expect(o.needsAttention).toBe(true);
    expect(o.credits).toBeUndefined();
    expect(o.error).toBe('supplier call timed out');
  });
});
