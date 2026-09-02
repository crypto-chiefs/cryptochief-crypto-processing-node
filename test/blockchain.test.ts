import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { Chain, ChainFamily } from '../src/chains';

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

function firstCall(calls: Captured[]): Captured {
  const c = calls[0];
  if (!c) throw new Error('no request was made');
  return c;
}

function sentBody(calls: Captured[]): Record<string, unknown> {
  return JSON.parse(firstCall(calls).init.body as string) as Record<string, unknown>;
}

describe('supported blockchains', () => {
  it('decodes the bare top-level array the endpoint actually sends', async () => {
    // Verbatim from the API reference: no `items`, no envelope of any kind.
    // A type written for {"items":[...]} compiles against this call and fails
    // only in production, which is the whole reason this test exists.
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify([
            { name: 'ETH_MAINNET', type: 'evm' },
            { name: 'ETH_SEPOLIA', type: 'evm' },
            { name: 'TRON_MAINNET', type: 'tron' },
            { name: 'SOLANA_MAINNET', type: 'solana' },
          ]),
          { status: 200 },
        ),
    );

    const out = await client.blockchain.supportedBlockchains();

    expect(firstCall(calls).url).toContain('/v1/blockchains/list');
    // Nothing to filter by, but the empty body is still signed like any other.
    expect(sentBody(calls)).toEqual({});
    expect(firstCall(calls).init.body).toBe('{}');

    expect(Array.isArray(out)).toBe(true);
    expect(out).toHaveLength(4);
    const first = out[0];
    if (!first) throw new Error('expected a chain');
    expect(first.name).toBe(Chain.EthMainnet);
    // Lower case, unlike ChainFamily.Evm - the scanner's protocol name, not the
    // `chain_family` value the rest of the API speaks.
    expect(first.type).toBe('evm');
    expect(first.type).not.toBe(ChainFamily.Evm);
    expect(out.map((c) => c.name)).toEqual([
      'ETH_MAINNET',
      'ETH_SEPOLIA',
      'TRON_MAINNET',
      'SOLANA_MAINNET',
    ]);
  });

  it('answers an empty array without inventing an envelope', async () => {
    const { client } = makeClient(() => new Response('[]', { status: 200 }));

    const out = await client.blockchain.supportedBlockchains();

    expect(out).toEqual([]);
  });

  it('turns the literal null an empty result sends into an empty array', async () => {
    // The service builds its answer with `var list []Chain`, and an empty slice
    // marshals as JSON `null` rather than `[]`. A method whose signature
    // promises SupportedBlockchain[] has to hand back a list either way: the
    // documented pattern is a `for...of` over the result, and null would throw
    // a TypeError there instead of iterating zero times.
    const { client } = makeClient(() => new Response('null', { status: 200 }));

    const out = await client.blockchain.supportedBlockchains();

    expect(out).not.toBeNull();
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
    expect(out).toHaveLength(0);

    // The usage the README and the guides show, run against the null body.
    const names: string[] = [];
    for (const c of out) names.push(c.name);
    expect(names).toEqual([]);
    expect(out.map((c) => c.name)).toEqual([]);
    expect(out.filter((c) => c.type === 'evm')).toEqual([]);
  });
});

describe('platform assets catalogue', () => {
  const catalogue = JSON.stringify({
    items: [
      {
        network: 'ETH_MAINNET',
        coin: 'ETH',
        contract: '',
        chain_family: 'EVM',
        type: 'native',
        is_test: false,
        decimals: 18,
      },
      {
        network: 'TRON_MAINNET',
        coin: 'USDT',
        contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
        chain_family: 'TRON',
        type: 'token',
        is_test: false,
        decimals: 6,
      },
      {
        network: 'ETH_SEPOLIA',
        coin: 'ETH',
        contract: '',
        chain_family: 'EVM',
        type: 'native',
        is_test: true,
        decimals: 18,
      },
    ],
  });

  it('keeps chain_family and is_test, and a native coin keeps its empty contract', async () => {
    const { client, calls } = makeClient(() => new Response(catalogue, { status: 200 }));

    const out = await client.blockchain.contractsList();

    expect(firstCall(calls).url).toContain('/v1/blockchain/contracts/list');
    // Platform-wide: there is nothing to filter by, and the body is still signed.
    expect(firstCall(calls).init.body).toBe('{}');

    const [eth, usdt, sepolia] = out.items;
    if (!eth || !usdt || !sepolia) throw new Error('expected three assets');

    expect(eth.chainFamily).toBe(ChainFamily.Evm);
    expect(usdt.chainFamily).toBe(ChainFamily.Tron);
    // Both fields used to be dropped on the floor by the item type; a caller
    // building an "assets we could enable" picker needs both to sort the list.
    expect(eth.isTest).toBe(false);
    expect(sepolia.isTest).toBe(true);

    // A native coin has no contract, and the API says so with "" rather than
    // null. It must arrive as "" - not null, not undefined, not an error.
    expect(eth.contract).toBe('');
    expect(eth.contract).not.toBeNull();
    expect(eth.contract).not.toBeUndefined();
    expect(eth.type).toBe('native');
    expect(eth.decimals).toBe(18);

    expect(usdt.contract).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(usdt.type).toBe('token');
    expect(usdt.decimals).toBe(6);
  });

  it('reads the same fields off the project catalogue - one row shape, two endpoints', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            items: [
              {
                network: 'ARBITRUM_SEPOLIA',
                coin: 'ETH',
                contract: '',
                chain_family: 'EVM',
                type: 'native',
                is_test: true,
                decimals: 18,
              },
            ],
          }),
          { status: 200 },
        ),
    );

    const out = await client.blockchain.contractsAvailable(Chain.ArbitrumSepolia);

    expect(firstCall(calls).url).toContain('/v1/blockchain/contracts/available');
    expect(sentBody(calls)).toEqual({ network: 'ARBITRUM_SEPOLIA' });

    const row = out.items[0];
    if (!row) throw new Error('expected an asset');
    expect(row.chainFamily).toBe(ChainFamily.Evm);
    expect(row.isTest).toBe(true);
    expect(row.contract).toBe('');
  });
});
