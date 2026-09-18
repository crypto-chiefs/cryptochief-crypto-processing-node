import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { CryptoChiefError, ApiError } from '../src/errors';
import { EnergyOrderStatus } from '../src/services/energy';

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
  ref: 'q-9f2c1a',
  receive_address: 'TRecipient',
  energy: 65000,
  duration_sec: 3600,
  price_sun: 6955000,
  price_trx: '6.955000',
  price_usd: '2.07',
  credits: 20700000,
  trx_usd: '0.29750000',
  recipient_state: 'cold',
  burn_price_sun: 27950000,
  burn_price_trx: '27.950000',
  burn_price_usd: '8.32',
  burn_price_credits: 83200000,
  saving_trx: '20.995000',
  saving_usd: '6.25',
  saving_credits: 62500000,
  expires_at: '2026-09-18T12:05:00Z',
  expires_in_sec: 90,
  ...over,
});

const order = (over: Record<string, unknown>) => ({
  id: 8814,
  idempotency_key: 'rent-2026-09-18-0001',
  status: 'delivered',
  receive_address: 'TRecipient',
  energy: 65000,
  duration_sec: 3600,
  price_sun: 6955000,
  price_trx: '6.955000',
  price_usd: '2.07',
  credits: 20700000,
  trx_usd: '0.29750000',
  delivered_energy: 65000,
  settled: true,
  needs_attention: false,
  created_at: '2026-09-18T12:00:00Z',
  delivered_at: '2026-09-18T12:00:09Z',
  ...over,
});

describe('energy.quote', () => {
  it('posts the quote request snake_cased and maps the full quote', async () => {
    const { client, calls } = makeClient(() => json(200, quote({})));

    const q = await client.energy.quote({ receiveAddress: 'TRecipient', energy: 65000, durationSec: 3600 });

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/energy\/quote$/);
    expect(c.init.method).toBe('POST');
    expect(JSON.parse(c.init.body as string)).toEqual({
      receive_address: 'TRecipient',
      energy: 65000,
      duration_sec: 3600,
    });

    expect(q.ref).toBe('q-9f2c1a');
    expect(q.receiveAddress).toBe('TRecipient');
    expect(q.energy).toBe(65000);
    expect(q.durationSec).toBe(3600);
    expect(q.priceSun).toBe(6955000);
    expect(q.priceTrx).toBe('6.955000');
    expect(q.priceUsd).toBe('2.07');
    expect(q.credits).toBe(20700000);
    expect(q.trxUsd).toBe('0.29750000');
    expect(q.recipientState).toBe('cold');
    expect(q.burnPriceSun).toBe(27950000);
    expect(q.burnPriceTrx).toBe('27.950000');
    expect(q.burnPriceUsd).toBe('8.32');
    expect(q.burnPriceCredits).toBe(83200000);
    expect(q.savingTrx).toBe('20.995000');
    expect(q.savingUsd).toBe('6.25');
    expect(q.savingCredits).toBe(62500000);
    expect(q.expiresAt).toBe('2026-09-18T12:05:00Z');
    expect(q.expiresInSec).toBe(90);
  });

  it('omits energy and duration_sec when unset and tolerates a rateless quote', async () => {
    const { client, calls } = makeClient(() =>
      json(
        200,
        quote({
          price_usd: undefined,
          credits: undefined,
          trx_usd: undefined,
          burn_price_usd: undefined,
          burn_price_credits: undefined,
          saving_usd: undefined,
          saving_credits: undefined,
        }),
      ),
    );

    const q = await client.energy.quote({ receiveAddress: 'TRecipient' });

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ receive_address: 'TRecipient' });
    expect(q.priceUsd).toBeUndefined();
    expect(q.credits).toBeUndefined();
    expect(q.trxUsd).toBeUndefined();
    expect(q.savingCredits).toBeUndefined();
  });
});

describe('energy.rent', () => {
  it('sends the Idempotency-Key header and maps a delivered order', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    const o = await client.energy.rent(
      { receiveAddress: 'TRecipient', energy: 65000 },
      { idempotencyKey: 'rent-2026-09-18-0001' },
    );

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/energy\/rent$/);
    const headers = c.init.headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBe('rent-2026-09-18-0001');
    expect(JSON.parse(c.init.body as string)).toEqual({ receive_address: 'TRecipient', energy: 65000 });

    expect(o.id).toBe(8814);
    expect(o.idempotencyKey).toBe('rent-2026-09-18-0001');
    expect(o.status).toBe(EnergyOrderStatus.Delivered);
    expect(o.credits).toBe(20700000);
    expect(o.priceUsd).toBe('2.07');
    expect(o.deliveredEnergy).toBe(65000);
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
    expect(o.deliveredAt).toBe('2026-09-18T12:00:09Z');
  });

  it('buys at a quoted price when quoteRef is given', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    await client.energy.rent({ quoteRef: 'q-9f2c1a' }, { idempotencyKey: 'rent-2026-09-18-0001' });

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ quote_ref: 'q-9f2c1a' });
  });

  it('maps a refused order with no charge fields set', async () => {
    // A retry of a refused key comes back 200 with the same order; nothing was
    // charged, so credits/price_usd/trx_usd are absent rather than zero.
    const { client } = makeClient(() =>
      json(
        200,
        order({
          status: 'refused',
          price_usd: undefined,
          credits: undefined,
          trx_usd: undefined,
          delivered_energy: undefined,
          delivered_at: undefined,
          error: 'no supplier took the order',
          error_code: 'NO_SUPPLIER',
        }),
      ),
    );

    const o = await client.energy.rent({ receiveAddress: 'TRecipient' }, { idempotencyKey: 'rent-2026-09-18-0001' });

    expect(o.status).toBe(EnergyOrderStatus.Refused);
    expect(o.credits).toBeUndefined();
    expect(o.priceUsd).toBeUndefined();
    expect(o.trxUsd).toBeUndefined();
    expect(o.deliveredEnergy).toBeUndefined();
    expect(o.deliveredAt).toBeUndefined();
    expect(o.error).toBe('no supplier took the order');
    expect(o.errorCode).toBe('NO_SUPPLIER');
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
  });

  it('recovers a refused order from a 502 instead of throwing', async () => {
    // A refused order answers 502 with the order itself as the body - a
    // business outcome, not a transport failure. Nothing was charged, so
    // credits/price_usd/trx_usd are absent; error_code is the machine reason.
    const { client } = makeClient(() =>
      json(
        502,
        order({
          status: 'refused',
          price_usd: undefined,
          credits: undefined,
          trx_usd: undefined,
          delivered_energy: undefined,
          delivered_at: undefined,
          error: 'insufficient supplier balance',
          error_code: 'NO_SUPPLIER',
        }),
      ),
    );

    const o = await client.energy.rent({ receiveAddress: 'TRecipient' }, { idempotencyKey: 'rent-2026-09-18-0001' });

    expect(o.status).toBe(EnergyOrderStatus.Refused);
    expect(o.error).toBe('insufficient supplier balance');
    expect(o.errorCode).toBe('NO_SUPPLIER');
    expect(o.credits).toBeUndefined();
    expect(o.settled).toBe(true);
    expect(o.needsAttention).toBe(false);
  });

  it('recovers an unresolved order from a 409 instead of throwing', async () => {
    // The supplier's answer never arrived: the energy may already be delegated,
    // so the order must be followed, not retried.
    const { client } = makeClient(() =>
      json(
        409,
        order({
          status: 'unresolved',
          price_usd: undefined,
          credits: undefined,
          trx_usd: undefined,
          delivered_energy: undefined,
          delivered_at: undefined,
          settled: false,
          needs_attention: true,
          error: 'supplier call timed out',
          error_code: 'SUPPLIER_TIMEOUT',
        }),
      ),
    );

    const o = await client.energy.rent({ receiveAddress: 'TRecipient' }, { idempotencyKey: 'rent-2026-09-18-0001' });

    expect(o.status).toBe(EnergyOrderStatus.Unresolved);
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
          price_usd: undefined,
          credits: undefined,
          trx_usd: undefined,
          delivered_energy: undefined,
          delivered_at: undefined,
          error: 'your credit balance will not cover this order',
          error_code: 'INSUFFICIENT_CREDITS',
        }),
      ),
    );

    const o = await client.energy.rent({ receiveAddress: 'TRecipient' }, { idempotencyKey: 'rent-2026-09-18-0001' });

    expect(o.status).toBe(EnergyOrderStatus.Refused);
    expect(o.errorCode).toBe('INSUFFICIENT_CREDITS');
    expect(o.credits).toBeUndefined();
  });

  it('throws an ApiError for an error envelope with no order to report', async () => {
    // `ok:false` is an error envelope, not an order - a spent quote has no
    // order to recover.
    const { client } = makeClient(() =>
      json(409, { ok: false, error: 'QUOTE_EXPIRED', msg: 'the quote has expired' }),
    );

    const err = await client.energy
      .rent({ quoteRef: 'q-9f2c1a' }, { idempotencyKey: 'rent-2026-09-18-0001' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).httpStatus).toBe(409);
    expect((err as ApiError).code).toBe('QUOTE_EXPIRED');
  });

  it('refuses to send without an idempotency key', async () => {
    const { client, calls } = makeClient(() => json(200, order({})));

    await expect(client.energy.rent({ receiveAddress: 'TRecipient' })).rejects.toThrow(CryptoChiefError);
    await expect(client.energy.rent({ receiveAddress: 'TRecipient' }, {})).rejects.toThrow(/idempotencyKey/);
    expect(calls).toHaveLength(0);
  });
});

describe('energy.order', () => {
  it('fetches an order by its idempotency key', async () => {
    const { client, calls } = makeClient(() =>
      json(
        200,
        order({
          status: 'unresolved',
          credits: undefined,
          price_usd: undefined,
          trx_usd: undefined,
          delivered_energy: undefined,
          delivered_at: undefined,
          settled: false,
          needs_attention: true,
          error: 'supplier call timed out',
        }),
      ),
    );

    const o = await client.energy.order('rent-2026-09-18-0001');

    const c = calls[0]!;
    expect(c.url).toMatch(/\/v1\/energy\/order$/);
    expect(JSON.parse(c.init.body as string)).toEqual({ key: 'rent-2026-09-18-0001' });

    expect(o.status).toBe(EnergyOrderStatus.Unresolved);
    expect(o.settled).toBe(false);
    expect(o.needsAttention).toBe(true);
    expect(o.credits).toBeUndefined();
    expect(o.error).toBe('supplier call timed out');
  });
});
