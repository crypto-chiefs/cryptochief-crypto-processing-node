import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { WithdrawalStatus, isWithdrawalTerminal } from '../src/services/withdrawals';

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

// In a block with 5 of 32: the platform used to call this completed.
const confirming = {
  uuid: 'w-1',
  status: 'confirm_check',
  from_address: '0xmaster',
  to_address: '0xdest',
  amount: '100.5',
  network: 'ETH_MAINNET',
  coin: 'USDT',
  need_refuel: true,
  refuel_tx_hash: '0xrefuel',
  refuel_status: 'done',
  tx_hash: '0xwd',
  confirmations: 5,
  required_confirmations: 32,
  estimated_fee_fiat: '1.20',
  fee_mode: 'service',
  created_at: '2026-09-14T10:00:00Z',
};

// Not sent yet: no count at all, the depth is there regardless.
const queued = {
  uuid: 'w-2',
  status: 'queue',
  from_address: '0xmaster',
  to_address: '0xdest',
  amount: '10',
  network: 'ETH_MAINNET',
  coin: 'USDT',
  need_refuel: false,
  required_confirmations: 32,
  estimated_fee_fiat: '0.40',
  fee_mode: 'client',
  created_at: '2026-09-14T10:05:00Z',
};

describe('withdrawal statuses', () => {
  it('lists the WithdrawalStatus constants', () => {
    expect(Object.values(WithdrawalStatus).sort()).toEqual(
      [
        'queue',
        'refueling',
        'refuel_confirmed',
        'broadcasting',
        'sending',
        'in_mempool',
        'confirm_check',
        'completed',
        'failed',
        'cancelled',
      ].sort(),
    );
  });

  it('treats completed and failed as terminal, and no in-flight status', () => {
    const terminal = Object.values(WithdrawalStatus).filter(isWithdrawalTerminal);
    // `cancelled` stays terminal for compatibility; the API does not report it.
    expect(terminal.sort()).toEqual(['cancelled', 'completed', 'failed']);
    expect(isWithdrawalTerminal(WithdrawalStatus.ConfirmCheck)).toBe(false);
    expect(isWithdrawalTerminal(WithdrawalStatus.InMempool)).toBe(false);
    // Payout statuses, not withdrawal ones: a withdrawal never reports them.
    expect(isWithdrawalTerminal('paid')).toBe(false);
    expect(isWithdrawalTerminal('system_fail')).toBe(false);
  });
});

describe('withdrawal confirmations', () => {
  it('reads the count and the depth of a withdrawal still short of finality', async () => {
    const { client, calls } = makeClient(() => json(200, confirming));

    const out = await client.withdrawals.info('w-1');

    expect(calls[0]!.url).toMatch(/\/v1\/withdrawal\/info$/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uuid: 'w-1' });
    expect(out.status).toBe(WithdrawalStatus.ConfirmCheck);
    expect(isWithdrawalTerminal(out.status)).toBe(false);
    expect(out.confirmations).toBe(5);
    expect(out.requiredConfirmations).toBe(32);
    expect(out.confirmations!).toBeLessThan(out.requiredConfirmations!);
    expect(out.txHash).toBe('0xwd');
    expect(out.refuelTxHash).toBe('0xrefuel');
    expect(out.refuelStatus).toBe('done');
    expect(out.needRefuel).toBe(true);
    expect(out.feeMode).toBe('service');
    expect(out.completedAt).toBeUndefined();
  });

  it('leaves confirmations absent until the transaction is seen in a block', async () => {
    const { client } = makeClient(() => json(200, queued));

    const out = await client.withdrawals.info('w-2');

    expect(out.status).toBe(WithdrawalStatus.Queue);
    expect(out.confirmations).toBeUndefined();
    expect('confirmations' in out).toBe(false);
    expect(out.requiredConfirmations).toBe(32);
  });

  it('keeps zero as a value, not a missing field', async () => {
    const { client } = makeClient(() => json(200, { ...confirming, confirmations: 0 }));

    const out = await client.withdrawals.info('w-1');

    expect(out.confirmations).toBe(0);
    expect('confirmations' in out).toBe(true);
  });

  it('reads a completed withdrawal at or above the depth', async () => {
    const completed = {
      ...confirming,
      status: 'completed',
      confirmations: 32,
      actual_fee_fiat: '1.18',
      completed_at: '2026-09-14T10:09:00Z',
    };
    const { client } = makeClient(() => json(200, completed));

    const out = await client.withdrawals.info('w-1');

    expect(out.status).toBe(WithdrawalStatus.Completed);
    expect(isWithdrawalTerminal(out.status)).toBe(true);
    expect(out.confirmations).toBeGreaterThanOrEqual(out.requiredConfirmations!);
    expect(out.actualFeeFiat).toBe('1.18');
    expect(out.completedAt).toBe('2026-09-14T10:09:00Z');
  });

  it('parses a withdrawal completed before the platform counted confirmations', async () => {
    const { confirmations: _omitted, ...rest } = confirming;
    const legacy = { ...rest, status: 'completed', completed_at: '2026-02-10T12:02:30Z' };
    const { client } = makeClient(() => json(200, legacy));

    const out = await client.withdrawals.info('w-1');

    expect(out.status).toBe(WithdrawalStatus.Completed);
    expect(out.confirmations).toBeUndefined();
    expect(out.requiredConfirmations).toBe(32);
  });

  it('parses a payload from a platform that predates the depth field', async () => {
    const { confirmations: _c, required_confirmations: _r, ...rest } = confirming;
    const { client } = makeClient(() => json(200, { ...rest, status: 'completed' }));

    const out = await client.withdrawals.info('w-1');

    expect(out.status).toBe(WithdrawalStatus.Completed);
    expect(out.confirmations).toBeUndefined();
    expect(out.requiredConfirmations).toBeUndefined();
    expect('requiredConfirmations' in out).toBe(false);
  });

  it('carries the counts on history items', async () => {
    const failed = {
      ...queued,
      uuid: 'w-3',
      status: 'failed',
      error_reason: 'TX_CONFIRM_TIMEOUT',
      network: 'TRON_MAINNET',
      required_confirmations: 20,
    };
    const { client, calls } = makeClient(() =>
      json(200, {
        items: [confirming, queued, failed],
        meta: { page: 1, page_size: 20, total: 3, total_pages: 1 },
      }),
    );

    const history = await client.withdrawals.history({ page: 1, pageSize: 20 });

    expect(calls[0]!.url).toMatch(/\/v1\/withdrawal\/history$/);
    expect(history.items.map((w) => w.status)).toEqual(['confirm_check', 'queue', 'failed']);
    expect(history.items.map((w) => w.confirmations)).toEqual([5, undefined, undefined]);
    expect(history.items.map((w) => w.requiredConfirmations)).toEqual([32, 32, 20]);
    expect(history.items[2]!.errorReason).toBe('TX_CONFIRM_TIMEOUT');
    expect(history.meta.totalPages).toBe(1);
  });
});
