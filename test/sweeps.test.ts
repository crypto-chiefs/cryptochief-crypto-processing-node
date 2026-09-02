import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { SweepFeeMode, SweepGasSource, SweepPolicyMode, SweepStatus } from '../src/services/sweeps';

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

  it('carries completedAt on a failed sweep - presence is not settlement', async () => {
    // The sweeper stamps completed_at at every terminal outcome, failures
    // among them. Reading its presence as "the money landed" books a failed
    // sweep as money received, which is why this fixture exists.
    const { client } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            items: [
              {
                task_id: 't3',
                status: 'failed',
                wallet_address: '0xc',
                chain: 'ETH_MAINNET',
                sweep_confirmations: 0,
                completed_at: '2026-08-28T11:00:00Z',
              },
              {
                task_id: 't4',
                status: 'skipped',
                wallet_address: '0xd',
                chain: 'ETH_MAINNET',
                sweep_confirmations: 0,
                completed_at: '2026-08-28T11:05:00Z',
              },
            ],
            meta: { total: 2, page: 1, page_size: 50 },
          }),
          { status: 200 },
        ),
    );

    const out = await client.sweeps.history({ pageSize: 50 });

    const [failed, skipped] = out.items;
    if (!failed || !skipped) throw new Error('expected two sweeps');

    expect(failed.status).toBe(SweepStatus.Failed);
    expect(failed.completedAt).toBe('2026-08-28T11:00:00Z');
    expect(skipped.status).toBe(SweepStatus.Skipped);
    expect(skipped.completedAt).toBe('2026-08-28T11:05:00Z');

    // The wrong test, spelled out so its result is on the record: both of these
    // read as settled, and neither moved any money.
    const settledByCompletedAt = out.items.filter((s) => s.completedAt !== undefined);
    expect(settledByCompletedAt).toHaveLength(2);

    // The right one: confirmations above zero, or confirmedAt off the webhook.
    const actuallySettled = out.items.filter((s) => (s.sweepConfirmations ?? 0) > 0);
    expect(actuallySettled).toEqual([]);
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

describe('sweep history filters', () => {
  const emptyPage = JSON.stringify({ items: [], meta: { page: 1, page_size: 20, total: 0 } });

  it('narrows the project-wide history by status and search', async () => {
    const { client, calls } = makeClient(() => new Response(emptyPage, { status: 200 }));

    await client.sweeps.history({
      mode: 'auto',
      status: SweepStatus.Failed,
      search: '0x77EDde3213b70c9dd224C874c28f41B23B070f65',
      page: 2,
      pageSize: 50,
    });

    const body = sentBody(calls);
    expect(firstCall(calls).url).toContain('/v1/sweeps/history');
    expect(body).toEqual({
      mode: 'auto',
      status: 'failed',
      search: '0x77EDde3213b70c9dd224C874c28f41B23B070f65',
      page: 2,
      page_size: 50,
    });
  });

  it('narrows one wallet by status and search, address still required', async () => {
    const { client, calls } = makeClient(() => new Response(emptyPage, { status: 200 }));

    await client.sweeps.walletHistory({
      address: '0xabc',
      status: SweepStatus.Skipped,
      search: '898cdbd0-d583-4089-9c53-15f5ca9b53dc',
    });

    expect(firstCall(calls).url).toContain('/v1/sweeps/wallet/history');
    expect(sentBody(calls)).toEqual({
      address: '0xabc',
      status: 'skipped',
      search: '898cdbd0-d583-4089-9c53-15f5ca9b53dc',
    });
  });

  it('leaves both off the wire when unasked, so every status comes back', async () => {
    const { client, calls } = makeClient(() => new Response(emptyPage, { status: 200 }));

    await client.sweeps.history();

    const body = sentBody(calls);
    // An empty status is not "no filter" to the platform - absence is.
    expect('status' in body).toBe(false);
    expect('search' in body).toBe(false);
    expect(firstCall(calls).init.body).toBe('{}');
  });
});

describe('sweep gas source', () => {
  // Verbatim from the API reference: the override does not decide gas_source,
  // the effective layer does, and the project default carries one of its own.
  const gasSourceSettings = JSON.stringify({
    wallet_address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
    network_code: 'TRON_MAINNET',
    effective: {
      type_work: 'threshold',
      threshold_amount_usd: '250',
      fee_mode: 'mix',
      gas_source: 'native',
      source: 'wallet',
    },
    override: {
      network_code: '',
      type_work: 'threshold',
      threshold_amount_usd: '250',
      fee_mode: null,
      gas_source: null,
      source: 'merchant',
      locked: false,
    },
    project_default: { type_work: 'momentum', fee_mode: 'mix', gas_source: 'native' },
  });

  it('reads a concrete effective value and a null override as "not decided"', async () => {
    const { client } = makeClient(() => new Response(gasSourceSettings, { status: 200 }));

    const out = await client.sweeps.settings({ address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb' });

    // What will actually happen is always concrete on `effective`.
    expect(out.effective.gasSource).toBe(SweepGasSource.Native);
    expect(out.projectDefault.gasSource).toBe(SweepGasSource.Native);
    // null on the override means this layer does not decide it: the value is
    // inherited, NOT switched off. Reading it as a value would say the wallet
    // burns nothing, when the effective policy says it burns its own TRX.
    expect(out.override?.gasSource).toBeNull();
    expect(out.override?.gasSource).not.toBe(SweepGasSource.Native);
    expect(out.override?.gasSource).not.toBeUndefined();

    // Compile-time half of the same statement, checked by `npm run typecheck`:
    // on a resolved policy gasSource is a concrete value, so it assigns to a
    // plain string with nothing to narrow away - exactly like typeWork and
    // feeMode beside it. Only the override layer is nullable.
    const effectiveGas: string = out.effective.gasSource;
    const defaultGas: string = out.projectDefault.gasSource;
    const overrideGas: string | null | undefined = out.override?.gasSource;
    expect(effectiveGas).toBe(SweepGasSource.Native);
    expect(defaultGas).toBe(SweepGasSource.Native);
    expect(overrideGas).toBeNull();
  });

  it('reads a rented wallet - the platform default nobody switched on', async () => {
    const { client } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            wallet_address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
            network_code: 'TRON_MAINNET',
            effective: { type_work: 'momentum', fee_mode: 'mix', gas_source: 'rented', source: 'default' },
            override: null,
            project_default: { type_work: 'momentum', fee_mode: 'mix', gas_source: 'rented' },
          }),
          { status: 200 },
        ),
    );

    const out = await client.sweeps.settings({ address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb' });

    // Nobody chose. Energy is still rented and billed to API credits, and
    // `effective` is where a caller finds that out.
    expect(out.override).toBeNull();
    expect(out.effective.gasSource).toBe(SweepGasSource.Rented);
    expect(out.effective.source).toBe('default');
  });

  it('sends native explicitly - not sending it is not the same thing', async () => {
    const { client, calls } = makeClient(() => new Response(gasSourceSettings, { status: 200 }));

    await client.sweeps.updateSettings({
      address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
      gasSource: SweepGasSource.Native,
    });

    const body = sentBody(calls);
    expect(body.gas_source).toBe('native');
    expect(body.fields).toEqual(['gas_source']);

    const untouched = makeClient(() => new Response(gasSourceSettings, { status: 200 }));
    await untouched.client.sweeps.updateSettings({
      address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
      feeMode: SweepFeeMode.Client,
    });
    const other = sentBody(untouched.calls);
    // Omitted leaves the stored value alone; where nothing is stored that is
    // the platform default `rented`, not `native`.
    expect('gas_source' in other).toBe(false);
    expect(other.fields).toEqual(['fee_mode']);
  });

  it('clears the override by naming gas_source in the mask with no value', async () => {
    const { client, calls } = makeClient(() => new Response(gasSourceSettings, { status: 200 }));

    await client.sweeps.updateSettings({
      address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
      gasSource: null,
      feeMode: SweepFeeMode.Mix,
    });

    const body = sentBody(calls);
    // Named in `fields`, absent from the body: the API's only way of saying
    // "stop overriding this one and keep the rest".
    expect(body.fields).toEqual(['fee_mode', 'gas_source']);
    expect('gas_source' in body).toBe(false);
    expect(body.fee_mode).toBe('mix');
  });
});
