import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { SweepPolicyMode, SweepStatus } from '../src/services/sweeps';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (attempt: number, c: Captured) => Response, overrides: Partial<ClientOptions> = {}) {
  let attempt = 0;
  const calls: Captured[] = [];
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
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

const settingsResponse = JSON.stringify({
  wallet_address: '0xabc',
  network_code: 'ETH_MAINNET',
  effective: { type_work: 'threshold', threshold_amount_usd: '250', fee_mode: 'mix', source: 'wallet' },
  override: {
    network_code: '',
    type_work: 'threshold',
    threshold_amount_usd: '250',
    fee_mode: null,
    source: 'merchant',
    locked: false,
  },
  project_default: { type_work: 'momentum', fee_mode: 'client' },
});

function firstCall(calls: Captured[]): Captured {
  const c = calls[0];
  if (!c) throw new Error('no request was made');
  return c;
}

function sentBody(calls: Captured[]): Record<string, unknown> {
  return JSON.parse(firstCall(calls).init.body as string) as Record<string, unknown>;
}

describe('sweep settings', () => {
  it('reads the three layers and keeps them distinguishable', async () => {
    const { client, calls } = makeClient(() => new Response(settingsResponse, { status: 200 }));

    const out = await client.sweeps.settings({ address: '0xabc' });

    expect(firstCall(calls).url).toContain('/v1/sweeps/settings');
    expect(out.effective.typeWork).toBe(SweepPolicyMode.Threshold);
    expect(out.effective.thresholdAmountUsd).toBe('250');
    expect(out.effective.source).toBe('wallet');
    // An inherited field reads as null on the override while the effective
    // policy still has a value - that difference is the point of the shape.
    expect(out.override?.feeMode).toBeNull();
    expect(out.override?.typeWork).toBe('threshold');
    expect(out.projectDefault.typeWork).toBe(SweepPolicyMode.Momentum);
  });

  it('writes only the fields it was given', async () => {
    const { client, calls } = makeClient(() => new Response(settingsResponse, { status: 200 }));

    await client.sweeps.updateSettings({
      address: '0xabc',
      typeWork: SweepPolicyMode.Threshold,
      thresholdAmountUsd: '500',
    });

    const body = sentBody(calls);
    expect(firstCall(calls).url).toContain('/v1/sweeps/settings/update');
    expect(body.type_work).toBe('threshold');
    expect(body.threshold_amount_usd).toBe('500');
    // Sending fee_mode as null would CLEAR it. Untouched means absent.
    expect('fee_mode' in body).toBe(false);
    expect(body.fields).toEqual(['type_work', 'threshold_amount_usd']);
  });

  it('clears a field with null and leaves the others alone', async () => {
    const { client, calls } = makeClient(() => new Response(settingsResponse, { status: 200 }));

    await client.sweeps.updateSettings({ address: '0xabc', typeWork: null });

    const body = sentBody(calls);
    // Named in fields, carrying no value: the API's way of saying "inherit it".
    expect(body.fields).toEqual(['type_work']);
    expect('type_work' in body).toBe(false);
  });
});

describe('sweep history', () => {
  it('tells a broadcast sweep from a settled one', async () => {
    const { client } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            items: [
              {
                task_id: 't1',
                status: 'broadcasted',
                wallet_address: '0xa',
                chain: 'ETH_MAINNET',
                sweep_confirmations: 2,
                type_work: 'threshold',
                total_fee_usd: '1.20',
              },
              {
                task_id: 't2',
                status: 'completed',
                wallet_address: '0xb',
                chain: 'ETH_MAINNET',
                sweep_confirmations: 12,
                completed_at: '2026-08-28T10:00:00Z',
                real_sweep_fee_usd: '0.98',
              },
            ],
            meta: { total: 2, page: 1, page_size: 50 },
          }),
          { status: 200 },
        ),
    );

    const out = await client.sweeps.history({ pageSize: 50 });

    const [inFlight, settled] = out.items;
    if (!inFlight || !settled) throw new Error('expected two sweeps');
    expect(inFlight.status).toBe(SweepStatus.Broadcasted);
    expect(inFlight.sweepConfirmations).toBe(2);
    // Still in flight: there is no settlement moment to report yet.
    expect(inFlight.completedAt).toBeUndefined();
    expect(inFlight.typeWork).toBe('threshold');
    expect(inFlight.totalFeeUsd).toBe('1.20');
    expect(settled.status).toBe(SweepStatus.Completed);
    expect(settled.completedAt).toBe('2026-08-28T10:00:00Z');
    expect(settled.realSweepFeeUsd).toBe('0.98');
  });
});

describe('pay-in environment', () => {
  it('sends the environment and omits it when unset', async () => {
    const { client, calls } = makeClient(
      () => new Response(JSON.stringify({ uuid: 'u1', status: 'pending' }), { status: 200 }),
    );

    await client.payIns.create({
      orderId: 'o1',
      userId: 'u',
      mode: 'fiat',
      amountFiat: '10',
      currency: 'USD',
      environment: 'testnet',
    });
    expect(sentBody(calls).environment).toBe('testnet');

    const second = makeClient(
      () => new Response(JSON.stringify({ uuid: 'u2', status: 'pending' }), { status: 200 }),
    );
    await second.client.payIns.create({
      orderId: 'o2',
      userId: 'u',
      mode: 'fiat',
      amountFiat: '10',
      currency: 'USD',
    });
    // Unset must stay off the wire: an empty string is a value the platform has
    // to reject, not the "use the project default" the caller meant.
    expect('environment' in sentBody(second.calls)).toBe(false);
  });
});
