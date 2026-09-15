import { afterEach, describe, it, expect, vi } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { PollTimeoutError } from '../src/poll';
import { isPayoutTerminal, PayoutStatus, type PayoutInfo } from '../src/services/payouts';

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

// A payout drawing on two wallets, one of which needed gas first. The first
// source is counted, the second is broadcast and not yet seen confirmed.
const inFlight = {
  uuid: 'p-1',
  order_id: 'o-1',
  user_id: 'u-1',
  status: 'confirm_check',
  amount_requested: '150',
  amount_to_receive: '150',
  to_address: '0xdest',
  fee_info: { fee_mode: 'client', estimated_fiat: '1.20', limit_currency: 'USD' },
  sources: [
    {
      address: '0xa',
      network: 'ETH_MAINNET',
      coin: 'USDT',
      amount_crypto: '100',
      need_refuel: true,
      refuel_amount: '0.001',
      estimated_fee: '0.0004',
      estimated_fee_fiat: '0.80',
      txid: '0xaaa',
      confirmations: 15,
    },
    {
      address: '0xb',
      network: 'ETH_MAINNET',
      coin: 'USDT',
      amount_crypto: '50',
      need_refuel: false,
      refuel_amount: '0',
      estimated_fee: '0.0002',
      estimated_fee_fiat: '0.40',
      txid: '0xbbb',
    },
  ],
  service_operations: [
    {
      type: 'gas_refuel',
      context: 'payout_prepare',
      status: 'done',
      network: 'ETH_MAINNET',
      coin: 'ETH',
      amount_native: '0.001',
      from_address: '0xservice',
      to_address: '0xa',
      estimated_fee: '0.00002',
      estimated_fee_fiat: '0.04',
      txid: '0xgas',
      confirmations: 40,
    },
  ],
  confirmations: 0,
  required_confirmations: 32,
  created_at: '2026-09-14T10:00:00Z',
  completed_at: null,
};

// Nothing has been sent yet, so the platform leaves every count out. The depth
// is known from creation, so it is there regardless.
const queued = {
  uuid: 'p-2',
  order_id: 'o-2',
  user_id: 'u-1',
  status: 'queue',
  amount_requested: '10',
  amount_to_receive: '10',
  to_address: '0xdest',
  fee_info: { fee_mode: 'client', limit_currency: 'USD' },
  sources: [
    {
      address: '0xa',
      network: 'ETH_MAINNET',
      coin: 'USDT',
      amount_crypto: '10',
      need_refuel: false,
      refuel_amount: '0',
      estimated_fee: '0.0002',
      estimated_fee_fiat: '0.40',
    },
  ],
  required_confirmations: 32,
  created_at: '2026-09-14T10:05:00Z',
  completed_at: null,
};

describe('payout statuses', () => {
  it('lists the statuses the payout worker reports', () => {
    expect(Object.values(PayoutStatus).sort()).toEqual(
      [
        'queue',
        'process',
        'refueling',
        'refuel_confirmed',
        'sending',
        'broadcasting',
        'in_mempool',
        'confirm_check',
        'paid',
        'failed',
        'system_fail',
        'expired',
        'cancel',
      ].sort(),
    );
  });

  it('keeps every in-flight status non-terminal', () => {
    const terminal = Object.values(PayoutStatus).filter(isPayoutTerminal);
    expect(terminal.sort()).toEqual(['cancel', 'expired', 'failed', 'paid', 'system_fail']);
    for (const s of [
      PayoutStatus.Queue,
      PayoutStatus.Refueling,
      PayoutStatus.RefuelConfirmed,
      PayoutStatus.Sending,
      PayoutStatus.Broadcasting,
      PayoutStatus.InMempool,
      PayoutStatus.ConfirmCheck,
    ]) {
      expect(isPayoutTerminal(s)).toBe(false);
    }
  });
});

describe('payout sources', () => {
  it('reads the source fields the API sends', async () => {
    const { client } = makeClient(() => json(200, inFlight));

    const out = await client.payouts.info('p-1');

    const [first, second] = out.sources ?? [];
    expect(first).toMatchObject({
      address: '0xa',
      network: 'ETH_MAINNET',
      coin: 'USDT',
      amountCrypto: '100',
      needRefuel: true,
      refuelAmount: '0.001',
      estimatedFee: '0.0004',
      estimatedFeeFiat: '0.80',
      txid: '0xaaa',
    });
    // `amount` is not on the wire.
    expect(first!.amount).toBeUndefined();
    expect(second!.amountCrypto).toBe('50');
    expect(second!.txid).toBe('0xbbb');
    expect(second!.feePaid).toBeUndefined();
  });
});

describe('payout body', () => {
  it('reads the payout fields the API sends', async () => {
    const { client } = makeClient(() => json(200, inFlight));

    const out = await client.payouts.info('p-1');

    expect(out.uuid).toBe('p-1');
    expect(out.orderId).toBe('o-1');
    expect(out.userId).toBe('u-1');
    expect(out.amountRequested).toBe('150');
    expect(out.amountToReceive).toBe('150');
    expect(out.toAddress).toBe('0xdest');
    expect(out.feeInfo).toMatchObject({ feeMode: 'client', estimatedFiat: '1.20', limitCurrency: 'USD' });
    expect(out.feeInfo?.totalFeePaidFiat).toBeUndefined();
    expect(out.feeInfo?.estimatedCoin).toBeUndefined();
    expect(out.createdAt).toBe('2026-09-14T10:00:00Z');
    expect(out.completedAt).toBeNull();
    // The transaction hashes are per source.
    expect(out.sources?.map((s) => s.txid)).toEqual(['0xaaa', '0xbbb']);
  });

  it('reads the fee fields of a paid payout', async () => {
    const paid = {
      ...inFlight,
      status: 'paid',
      fee_info: {
        fee_mode: 'mix',
        estimated_fiat: '1.20',
        limit_fiat: '5.00',
        limit_currency: 'USD',
        total_fee_paid_fiat: '1.07',
      },
    };
    const { client } = makeClient(() => json(200, paid));

    const out = await client.payouts.info('p-1');

    expect(out.feeInfo).toEqual({
      feeMode: 'mix',
      estimatedFiat: '1.20',
      limitFiat: '5.00',
      limitCurrency: 'USD',
      totalFeePaidFiat: '1.07',
    });
  });

  it('has no payout-level network, coin, amount or txid', async () => {
    const { client } = makeClient(() => json(200, inFlight));

    const out = await client.payouts.info('p-1');

    expect(out.network).toBeUndefined();
    expect(out.coin).toBeUndefined();
    expect(out.amount).toBeUndefined();
    expect(out.txid).toBeUndefined();
    expect(out.updatedAt).toBeUndefined();
  });
});

describe('payouts.waitFor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits 90 minutes by default, beyond the 10-minute poll default', async () => {
    vi.useFakeTimers();
    const { client } = makeClient(() => json(200, inFlight));

    let settled: unknown;
    const done = client.payouts.waitFor('p-1', { intervalMs: 60_000 }).then(
      (v) => (settled = v),
      (err: unknown) => (settled = err),
    );

    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(settled).toBeUndefined();

    await vi.advanceTimersByTimeAsync(80 * 60_000);
    await done;
    expect(settled).toBeInstanceOf(PollTimeoutError);
    const err = settled as PollTimeoutError<PayoutInfo>;
    expect(err.message).toContain('5400000ms');
    expect(err.lastState?.status).toBe(PayoutStatus.ConfirmCheck);
  });

  it('keeps an explicit timeoutMs', async () => {
    const { client } = makeClient(() => json(200, inFlight));

    const err = await client.payouts.waitFor('p-1', { intervalMs: 1, timeoutMs: 20 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err as Error).message).toContain('20ms');
  });

  it('returns once the payout turns paid', async () => {
    const paid = { ...inFlight, status: 'paid', confirmations: 33 };
    let n = 0;
    const { client } = makeClient(() => json(200, n++ < 2 ? inFlight : paid));

    const out = await client.payouts.waitFor('p-1', { intervalMs: 1 });

    expect(out.status).toBe(PayoutStatus.Paid);
    expect(n).toBe(3);
  });
});

describe('payout confirmations', () => {
  it('reads the count per source, per service operation and for the payout', async () => {
    const { client, calls } = makeClient(() => json(200, inFlight));

    const out = await client.payouts.info('p-1');

    expect(calls[0]!.url).toMatch(/\/v1\/payout\/info$/);
    const [counted, broadcast] = out.sources ?? [];
    expect(counted!.confirmations).toBe(15);
    // Broadcast but not yet counted: the source has no count of its own...
    expect(broadcast!.confirmations).toBeUndefined();
    // ...and holds the payout at 0, which is a value, not a missing field.
    expect(out.confirmations).toBe(0);
    expect(out.serviceOperations).toHaveLength(1);
    const [refuel] = out.serviceOperations ?? [];
    expect(refuel!.type).toBe('gas_refuel');
    expect(refuel!.amountNative).toBe('0.001');
    expect(refuel!.txid).toBe('0xgas');
    expect(refuel!.confirmations).toBe(40);
  });

  it('leaves every count absent while nothing has been sent', async () => {
    const { client } = makeClient(() => json(200, queued));

    const out = await client.payouts.info('p-2');

    expect(out.confirmations).toBeUndefined();
    expect('confirmations' in out).toBe(false);
    expect(out.sources?.[0]?.confirmations).toBeUndefined();
    expect(out.serviceOperations).toBeUndefined();
    expect(out.requiredConfirmations).toBe(32);
  });

  it('reads the finality depth a payout waits for before it is paid', async () => {
    // Every source reached the depth: the payout is paid, and its lowest count
    // is at or above the threshold it carries.
    const paid = {
      ...inFlight,
      status: 'paid',
      sources: [
        { ...inFlight.sources[0], confirmations: 40 },
        { ...inFlight.sources[1], confirmations: 33 },
      ],
      confirmations: 33,
      completed_at: '2026-09-14T10:09:00Z',
    };
    const { client } = makeClient(() => json(200, paid));

    const out = await client.payouts.info('p-1');

    expect(out.status).toBe('paid');
    expect(out.requiredConfirmations).toBe(32);
    expect(out.confirmations).toBeGreaterThanOrEqual(out.requiredConfirmations!);
    expect(out.sources?.map((s) => s.confirmations)).toEqual([40, 33]);
  });

  it('keeps a source that is in a block but short of the depth non-terminal (confirm_check)', async () => {
    // One source is final, the other has 5 of 32: not paid, whatever the
    // first block would once have meant.
    const confirming = {
      ...inFlight,
      sources: [inFlight.sources[0], { ...inFlight.sources[1], confirmations: 5 }],
      confirmations: 5,
    };
    const { client } = makeClient(() => json(200, confirming));

    const out = await client.payouts.info('p-1');

    expect(out.status).toBe(PayoutStatus.ConfirmCheck);
    expect(isPayoutTerminal(out.status)).toBe(false);
    expect(out.confirmations).toBe(5);
    expect(out.requiredConfirmations).toBe(32);
    expect(out.confirmations!).toBeLessThan(out.requiredConfirmations!);
  });

  it('parses a payout that carries no depth at all', async () => {
    const { required_confirmations: _omitted, ...legacy } = inFlight;
    const { client } = makeClient(() => json(200, legacy));

    const out = await client.payouts.info('p-1');

    expect(out.requiredConfirmations).toBeUndefined();
    expect('requiredConfirmations' in out).toBe(false);
    expect(out.confirmations).toBe(0);
    expect(out.sources?.[0]?.confirmations).toBe(15);
  });

  it('carries the counts on history items and on a repeated execute', async () => {
    const { client } = makeClient((c) =>
      c.url.endsWith('/v1/payout/history')
        ? json(200, { items: [inFlight, queued], meta: { page: 1, page_size: 20, total: 2, total_page: 1 } })
        : json(200, inFlight),
    );

    const history = await client.payouts.history();
    expect(history.items.map((p) => p.confirmations)).toEqual([0, undefined]);
    expect(history.items.map((p) => p.requiredConfirmations)).toEqual([32, 32]);
    expect(history.items[0]!.sources?.[0]?.confirmations).toBe(15);

    // Resubmitting a known orderId answers with the stored payout, counts included.
    const replay = await client.payouts.execute({
      network: 'ETH_MAINNET',
      coin: 'USDT',
      amount: '150',
      toAddress: '0xdest',
      orderId: 'o-1',
      userId: 'u-1',
      urlCallback: 'https://m.example/hook',
    });
    expect(replay.uuid).toBe('p-1');
    expect(replay.confirmations).toBe(0);
    expect(replay.requiredConfirmations).toBe(32);
    expect(replay.serviceOperations?.[0]?.confirmations).toBe(40);
  });
});
