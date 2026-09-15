import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { TxStatus, isTransactionTerminal } from '../src/services/transactions';

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

const tx = (over: Record<string, unknown>) => ({
  uuid: 't-1',
  status: 'confirmed',
  network: 'ETH_MAINNET',
  chain_family: 'EVM',
  type: 'native',
  from_address: '0xfrom',
  to_address: '0xto',
  value: '1000',
  tx_hash: '0xhash',
  confirmations: 12,
  required_confirmations: 12,
  expires_at: '2026-09-14T10:10:00Z',
  created_at: '2026-09-14T10:00:00Z',
  completed_at: '2026-09-14T10:03:00Z',
  ...over,
});

describe('transaction confirmations', () => {
  it('reads the count a confirmed transaction settled at and the threshold applied', async () => {
    const { client, calls } = makeClient(() => json(200, tx({})));

    const out = await client.transactions.info('t-1');

    expect(calls[0]!.url).toMatch(/\/v1\/transaction\/info$/);
    expect(out.status).toBe(TxStatus.Confirmed);
    expect(out.confirmations).toBe(12);
    expect(out.requiredConfirmations).toBe(12);
  });

  it('keeps 0 as a value, not a missing field, right after execute', async () => {
    const { client } = makeClient(() =>
      json(200, tx({ status: 'broadcasted', confirmations: 0, required_confirmations: 12, completed_at: undefined })),
    );

    const out = await client.transactions.execute({ uuid: 't-1' });

    expect(out.status).toBe(TxStatus.Broadcasted);
    expect(out.confirmations).toBe(0);
    expect(out.requiredConfirmations).toBe(12);
  });

  it('reads a growing count on a broadcasted transaction already in a block', async () => {
    const { client } = makeClient(() =>
      json(200, tx({ status: 'broadcasted', confirmations: 5, required_confirmations: 12, completed_at: undefined })),
    );

    const out = await client.transactions.info('t-1');

    expect(out.status).toBe(TxStatus.Broadcasted);
    expect(isTransactionTerminal(out.status)).toBe(false);
    expect(out.confirmations).toBe(5);
    expect(out.requiredConfirmations).toBe(12);
    expect(out.confirmations!).toBeGreaterThan(0);
    expect(out.confirmations!).toBeLessThan(out.requiredConfirmations!);
  });

  it('keeps waiting through a counting and reorged broadcasted transaction until confirmed', async () => {
    const states = [
      tx({ status: 'broadcasted', confirmations: 0, required_confirmations: 12, completed_at: undefined }),
      tx({ status: 'broadcasted', confirmations: 3, required_confirmations: 12, completed_at: undefined }),
      tx({ status: 'broadcasted', confirmations: 2, required_confirmations: 12, completed_at: undefined }),
      tx({ status: 'confirmed', confirmations: 12, required_confirmations: 12 }),
    ];
    const seen: unknown[] = [];
    const { client, calls } = makeClient(() => {
      const next = states[Math.min(calls.length - 1, states.length - 1)]!;
      seen.push(next.confirmations);
      return json(200, next);
    });

    const out = await client.transactions.waitFor('t-1', { intervalMs: 1, timeoutMs: 5_000 });

    expect(seen).toEqual([0, 3, 2, 12]);
    expect(out.status).toBe(TxStatus.Confirmed);
    expect(out.confirmations).toBe(12);
    expect(out.requiredConfirmations).toBe(12);
  });

  it('carries both on every history item, failed and in-flight ones included', async () => {
    const { client } = makeClient(() =>
      json(200, {
        items: [
          tx({}),
          tx({ uuid: 't-2', status: 'failed', confirmations: 0, required_confirmations: 1, error_reason: 'tx reverted' }),
          tx({ uuid: 't-3', status: 'broadcasted', confirmations: 7, required_confirmations: 12, completed_at: undefined }),
        ],
        meta: { page: 1, page_size: 20, total: 3, total_page: 1 },
      }),
    );

    const out = await client.transactions.history();

    expect(out.items.map((t) => [t.status, t.confirmations, t.requiredConfirmations])).toEqual([
      ['confirmed', 12, 12],
      ['failed', 0, 1],
      ['broadcasted', 7, 12],
    ]);
  });
});
