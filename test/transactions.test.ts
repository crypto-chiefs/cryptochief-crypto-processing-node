import { describe, it, expect } from 'vitest';
import { CryptoChiefClient } from '../src/client';
import { ApiError, ErrorCode, isApiError } from '../src/errors';
import { TxStatus, TxType, isTransactionTerminal } from '../src/services/transactions';

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

const estimateTx = (over: Record<string, unknown>) => ({
  network: 'ETH_MAINNET',
  chain_family: 'EVM',
  type: 'native',
  from_address: '0xfrom',
  to_address: '0xto',
  estimated_fee: '0.00021',
  estimated_fee_fiat: '0.84',
  required: '0.00121',
  required_fiat: '4.84',
  ...over,
});

describe('transaction fee estimate', () => {
  it('estimates a native transfer, sending the sign fields without url_callback', async () => {
    const { client, calls } = makeClient(() => json(200, estimateTx({})));

    const out = await client.transactions.estimate({
      network: 'ETH_MAINNET',
      fromAddress: '0xfrom',
      type: TxType.Native,
      toAddress: '0xto',
      value: '1000000000000000',
    });

    expect(calls[0]!.url).toMatch(/\/v1\/transaction\/estimate$/);
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      network: 'ETH_MAINNET',
      from_address: '0xfrom',
      type: 'native',
      to_address: '0xto',
      value: '1000000000000000',
    });
    expect(out.network).toBe('ETH_MAINNET');
    expect(out.chainFamily).toBe('EVM');
    expect(out.type).toBe(TxType.Native);
    expect(out.estimatedFee).toBe('0.00021');
    expect(out.estimatedFeeFiat).toBe('0.84');
    expect(out.required).toBe('0.00121');
    expect(out.requiredFiat).toBe('4.84');
  });

  it('estimates a token transfer, where required is the fee alone', async () => {
    const { client, calls } = makeClient(() =>
      json(200, estimateTx({ type: 'token', required: '0.00021', required_fiat: '0.84' })),
    );

    const out = await client.transactions.estimate({
      network: 'ETH_MAINNET',
      fromAddress: '0xfrom',
      type: TxType.Token,
      toAddress: '0xto',
      value: '12500000',
      contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    });

    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      type: 'token',
      contract: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    });
    expect(out.type).toBe(TxType.Token);
    expect(out.required).toBe('0.00021');
  });

  it('keeps an empty fiat string when no rate is available', async () => {
    const { client } = makeClient(() => json(200, estimateTx({ estimated_fee_fiat: '', required_fiat: '' })));

    const out = await client.transactions.estimate({
      network: 'ETH_MAINNET',
      fromAddress: '0xfrom',
      toAddress: '0xto',
      value: '1000',
    });

    expect(out.estimatedFeeFiat).toBe('');
    expect(out.requiredFiat).toBe('');
  });

  it('maps the TRON fee breakdown, which sums to the gross estimated fee', async () => {
    const { client, calls } = makeClient(() =>
      json(200, {
        network: 'TRON_MAINNET',
        chain_family: 'TRON',
        type: 'token',
        from_address: 'TFrom',
        to_address: 'TTo',
        estimated_fee: '14.195',
        estimated_fee_fiat: '4.20',
        required: '14.195',
        required_fiat: '4.20',
        fee_expected: '1.195',
        fee_limit: '150',
        energy: 65000,
        energy_fee: '13',
        bandwidth_fee: '1',
        activation_fee: '0.195',
      }),
    );

    const out = await client.transactions.estimate({
      network: 'TRON_MAINNET',
      fromAddress: 'TFrom',
      type: TxType.Token,
      toAddress: 'TTo',
      value: '12500000',
      contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    });

    expect(calls[0]!.url).toMatch(/\/v1\/transaction\/estimate$/);
    expect(out.network).toBe('TRON_MAINNET');
    expect(out.estimatedFee).toBe('14.195');
    expect(out.feeExpected).toBe('1.195');
    expect(out.feeLimit).toBe('150');
    expect(out.energy).toBe(65000);
    expect(out.energyFee).toBe('13');
    expect(out.bandwidthFee).toBe('1');
    expect(out.activationFee).toBe('0.195');
  });

  it('leaves the TRON breakdown undefined on other networks', async () => {
    const { client } = makeClient(() => json(200, estimateTx({})));

    const out = await client.transactions.estimate({
      network: 'ETH_MAINNET',
      fromAddress: '0xfrom',
      toAddress: '0xto',
      value: '1000',
    });

    expect(out.feeExpected).toBeUndefined();
    expect(out.feeLimit).toBeUndefined();
    expect(out.energy).toBeUndefined();
    expect(out.energyFee).toBeUndefined();
    expect(out.bandwidthFee).toBeUndefined();
    expect(out.activationFee).toBeUndefined();
  });

  it('propagates CONTRACT_ESTIMATE_UNSUPPORTED for a contract-type request', async () => {
    const { client, calls } = makeClient(() =>
      json(400, { ok: false, error: 'CONTRACT_ESTIMATE_UNSUPPORTED', msg: 'contract calls cannot be estimated' }),
    );

    const err = await client.transactions
      .estimate({ network: 'ETH_MAINNET', fromAddress: '0xfrom', type: TxType.Contract })
      .catch((e: unknown) => e);

    expect(calls[0]!.url).toMatch(/\/v1\/transaction\/estimate$/);
    expect(err).toBeInstanceOf(ApiError);
    expect(isApiError(err, ErrorCode.ContractEstimateUnsupported)).toBe(true);
    expect((err as ApiError).httpStatus).toBe(400);
  });
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
