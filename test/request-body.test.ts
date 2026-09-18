import { describe, it, expect } from 'vitest';
import { toWire } from '../src/case';
import { CryptoChiefClient } from '../src/client';
import { CryptoChiefError } from '../src/errors';
import { signHmacV1 } from '../src/sign';

// Request bodies with `null` optional fields. The expected body is the JSON value 0.9.0 sent.

const N = null as never;
const A1 = '0x1111111111111111111111111111111111111111';
const A2 = '0x2222222222222222222222222222222222222222';

interface Captured {
  url: string;
  headers: Record<string, string>;
  /** Absent when the body is empty: fetch is given no body at all. */
  body?: string;
}

function makeClient() {
  const calls: Captured[] = [];
  const client = new CryptoChiefClient({
    merchantId: 'M1',
    apiKey: 'secret',
    baseUrl: 'https://api.test',
    retries: 0,
    fetch: async (url, init) => {
      calls.push({
        url,
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body as string | undefined,
      });
      return new Response('{"uuid":"u","status":"paid","items":[]}', { status: 200 });
    },
  });
  return { client, calls };
}

function nullMembers(v: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((e, i) => nullMembers(e, `${path}[${i}]`, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, e] of Object.entries(v)) {
      if (e === null) out.push(`${path}.${k}`);
      else nullMembers(e, `${path}.${k}`, out);
    }
  }
  return out;
}

type Case = [name: string, path: string, run: (c: CryptoChiefClient) => Promise<unknown>, body: string];

const execRequired = { network: 'ETH_MAINNET', coin: 'USDT', amount: '1.5', toAddress: A1, orderId: 'o-1', userId: 'user-1', urlCallback: 'https://cb.test/p' };
const payoutNulls = { fromAddresses: N, allowMultipleSources: N, autoConvert: N, autoConvertPolicy: N, maxFeeAmountFiat: N, memo: N };
const historyNulls = { page: N, pageSize: N, status: N, coin: N, network: N, dateFrom: N, dateTo: N };

const cases: Case[] = [
  [
    'payouts.execute, optional fields null',
    '/v1/payout/execute',
    (c) => c.payouts.execute({ ...execRequired, ...payoutNulls }),
    '{"amount":"1.5","coin":"USDT","network":"ETH_MAINNET","order_id":"o-1","to_address":"0x1111111111111111111111111111111111111111","url_callback":"https://cb.test/p","user_id":"user-1"}',
  ],
  [
    'payouts.estimate, null inside autoConvertPolicy',
    '/v1/payout/estimate',
    (c) =>
      c.payouts.estimate({
        network: 'ETH_MAINNET',
        coin: 'USDT',
        amount: '1.5',
        toAddress: A1,
        autoConvert: false,
        autoConvertPolicy: { allow: [{ network: 'ANY', coin: N }], exclude: N },
        memo: '',
      }),
    '{"amount":"1.5","auto_convert":false,"auto_convert_policy":{"allow":[{"network":"ANY"}]},"coin":"USDT","memo":"","network":"ETH_MAINNET","to_address":"0x1111111111111111111111111111111111111111"}',
  ],
  [
    'payouts.batchExecute, urlCallback and item fields null',
    '/v1/payout/batch/execute',
    (c) => c.payouts.batchExecute({ urlCallback: N, items: [{ ...execRequired, ...payoutNulls }] }),
    '{"items":[{"amount":"1.5","coin":"USDT","network":"ETH_MAINNET","order_id":"o-1","to_address":"0x1111111111111111111111111111111111111111","url_callback":"https://cb.test/p","user_id":"user-1"}]}',
  ],
  ['payouts.history, filters null', '/v1/payout/history', (c) => c.payouts.history(historyNulls), '{}'],
  [
    'staticDeposits.history, filters null',
    '/v1/static-deposit/history',
    (c) => c.staticDeposits.history({ ...historyNulls, address: N }),
    '{}',
  ],
  [
    'payIns.create, optional fields null',
    '/v1/payments/order/create',
    (c) =>
      c.payIns.create({
        orderId: 'o-1',
        userId: 'user-1',
        mode: 'fiat',
        toAddress: N,
        masterWalletAddress: N,
        environment: N,
        lifetimeSec: N,
        urlCallback: N,
        urlSuccess: N,
        urlError: N,
        additionalData: N,
        accuracyPaymentPercent: N,
        amountFiat: N,
        currency: N,
        courseSource: N,
        assets: N,
        amountCrypto: N,
        asset: N,
      }),
    '{"mode":"fiat","order_id":"o-1","user_id":"user-1"}',
  ],
  [
    'payIns.create, asset coin null',
    '/v1/payments/order/create',
    (c) => c.payIns.create({ orderId: 'o-2', userId: 'user-2', mode: 'crypto', amountCrypto: '0.1', asset: { network: 'ETH_MAINNET', coin: N } }),
    '{"amount_crypto":"0.1","asset":{"network":"ETH_MAINNET"},"mode":"crypto","order_id":"o-2","user_id":"user-2"}',
  ],
  [
    'payIns.selectAsset, masterWalletAddress null',
    '/v1/payments/asset/select',
    (c) => c.payIns.selectAsset({ uuid: 'u', coin: 'USDT', network: 'TRON_MAINNET', masterWalletAddress: N }),
    '{"coin":"USDT","network":"TRON_MAINNET","uuid":"u"}',
  ],
  [
    'wallets.generate, optional fields null',
    '/v1/wallets/generate',
    (c) => c.wallets.generate({ walletType: 'transit', chainFamily: 'TON', masterWalletAddress: N, callbackUrl: N, label: N }),
    '{"chain_family":"TON","wallet_type":"transit"}',
  ],
  [
    'wallets.payInHistory, optional fields null',
    '/v1/wallets/history',
    (c) => c.wallets.payInHistory({ address: A1, dateFrom: N, dateTo: N, page: N, pageSize: N }),
    '{"address":"0x1111111111111111111111111111111111111111"}',
  ],
  [
    'wallets.setLabel, label null',
    '/v1/wallets/label',
    (c) => c.wallets.setLabel(A1, N),
    '{"address":"0x1111111111111111111111111111111111111111"}',
  ],
  [
    'wallets.setCallbackUrl, empty string clears',
    '/v1/wallets/callback-url',
    (c) => c.wallets.setCallbackUrl(A1, ''),
    '{"address":"0x1111111111111111111111111111111111111111","callback_url":""}',
  ],
  [
    'wallets.rebindMaster, master null',
    '/v1/wallets/rebind-master',
    (c) => c.wallets.rebindMaster(A1, N),
    '{"address":"0x1111111111111111111111111111111111111111"}',
  ],
  [
    'sweeps.updateSettings, every override removed',
    '/v1/sweeps/settings/update',
    (c) => c.sweeps.updateSettings({ address: A1, networkCode: 'TRON_MAINNET', typeWork: N, thresholdAmountUsd: N, feeMode: N, gasSource: N }),
    '{"address":"0x1111111111111111111111111111111111111111","fields":["type_work","threshold_amount_usd","fee_mode","gas_source"],"network_code":"TRON_MAINNET"}',
  ],
  [
    'sweeps.updateSettings, one set, one removed, one untouched',
    '/v1/sweeps/settings/update',
    (c) => c.sweeps.updateSettings({ address: A1, typeWork: 'momentum', feeMode: N, thresholdAmountUsd: undefined }),
    '{"address":"0x1111111111111111111111111111111111111111","fields":["type_work","fee_mode"],"type_work":"momentum"}',
  ],
  [
    'sweeps.updateSettings, networkCode null',
    '/v1/sweeps/settings/update',
    (c) => c.sweeps.updateSettings({ address: A1, networkCode: N, gasSource: 'rented' }),
    '{"address":"0x1111111111111111111111111111111111111111","fields":["gas_source"],"gas_source":"rented"}',
  ],
  ['sweeps.settings, query null', '/v1/sweeps/settings', (c) => c.sweeps.settings({ address: N, networkCode: N }), '{}'],
  [
    'sweeps.history, filters null',
    '/v1/sweeps/history',
    (c) => c.sweeps.history({ mode: N, status: N, search: N, page: N, pageSize: N }),
    '{}',
  ],
  [
    'transactions.sign, optional fields and call fields null',
    '/v1/transaction/signature',
    (c) =>
      c.transactions.sign({
        network: 'TON_MAINNET',
        fromAddress: 'from',
        type: 'contract',
        toAddress: N,
        value: N,
        contract: N,
        urlCallback: N,
        calls: [{ to: 'to', data: 'te6c', value: N, accounts: N, bounce: N }],
      }),
    '{"calls":[{"data":"te6c","to":"to"}],"from_address":"from","network":"TON_MAINNET","type":"contract"}',
  ],
  [
    'transactions.execute, signedTxHex null',
    '/v1/transaction/execute',
    (c) => c.transactions.execute({ uuid: 't-uuid', signedTxHex: N }),
    '{"uuid":"t-uuid"}',
  ],
  [
    'transactions.signEvmCall, value and urlCallback null',
    '/v1/transaction/signature',
    (c) =>
      c.transactions.signEvmCall({
        network: 'ETH_MAINNET',
        fromAddress: A1,
        contract: A2,
        method: 'approve(address,uint256)',
        args: [A1, 5n],
        value: N,
        urlCallback: N,
      }),
    '{"calls":[{"data":"0x095ea7b300000000000000000000000011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000005","to":"0x2222222222222222222222222222222222222222"}],"from_address":"0x1111111111111111111111111111111111111111","network":"ETH_MAINNET","type":"contract"}',
  ],
  [
    'transactions.signTonCall, value, bounce and urlCallback null',
    '/v1/transaction/signature',
    (c) =>
      c.transactions.signTonCall({
        network: 'TON_MAINNET',
        fromAddress: 'from',
        contract: 'to',
        bodyCell: new Uint8Array([9, 8]),
        value: N,
        bounce: N,
        urlCallback: N,
      }),
    '{"calls":[{"data":"CQg=","to":"to"}],"from_address":"from","network":"TON_MAINNET","type":"contract"}',
  ],
  [
    'blockchain.walletBalance, contracts null',
    '/v1/blockchain/wallet/balance',
    (c) => c.blockchain.walletBalance('ETH_MAINNET', [A1], N),
    '{"addresses":["0x1111111111111111111111111111111111111111"],"chain":"ETH_MAINNET"}',
  ],
  [
    'currencies.fiatToCrypto, provider null',
    '/v1/currencies/convert/fiat-crypto',
    (c) => c.currencies.fiatToCrypto({ provider: N, from: 'USD', to: 'BTC', amount: '100' }),
    '{"amount":"100","from":"USD","to":"BTC"}',
  ],
  [
    'credits.topup, redirect URLs null',
    '/v1/credits/topup',
    (c) => c.credits.topup({ amount: '50', currency: 'USDT', urlSuccess: N, urlError: N }),
    '{"amount":"50","currency":"USDT"}',
  ],
  [
    'energy.quote, optional fields null',
    '/v1/energy/quote',
    (c) => c.energy.quote({ receiveAddress: A1, energy: N, durationSec: N }),
    '{"receive_address":"0x1111111111111111111111111111111111111111"}',
  ],
  [
    'energy.rent, optional fields null',
    '/v1/energy/rent',
    (c) => c.energy.rent({ receiveAddress: A1, energy: N, durationSec: N, quoteRef: N }, { idempotencyKey: 'rent-1' }),
    '{"receive_address":"0x1111111111111111111111111111111111111111"}',
  ],
  ['energy.order, by key', '/v1/energy/order', (c) => c.energy.order('rent-1'), '{"key":"rent-1"}'],
  [
    'native.buy, quoteRef null',
    '/v1/native/buy',
    (c) => c.native.buy({ network: 'ETH_MAINNET', receiveAddress: A1, amount: '0.05', quoteRef: N }, { idempotencyKey: 'buy-1' }),
    '{"network":"ETH_MAINNET","receive_address":"0x1111111111111111111111111111111111111111","amount":"0.05"}',
  ],
  ['native.order, by key', '/v1/native/order', (c) => c.native.order('buy-1'), '{"key":"buy-1"}'],
  [
    'request, nested null members',
    '/v1/raw',
    (c) => c.request('/v1/raw', { a: 1, b: null, c: { d: null, e: 'x' }, f: [null, 1, { g: null, h: 2 }], u: undefined, arr: [undefined] }),
    '{"a":1,"arr":[null],"c":{"e":"x"},"f":[null,1,{"h":2}]}',
  ],
  [
    'request, array at the top level',
    '/v1/raw',
    (c) => c.request('/v1/raw', [1, null, { a: null, b: [null] }]),
    '[1,null,{"b":[null]}]',
  ],
  ['request, negative zero', '/v1/raw', (c) => c.request('/v1/raw', { neg0: -0, f: 1.5 }), '{"f":1.5,"neg0":0}'],
  ['request, null body', '/v1/raw', (c) => c.request('/v1/raw', null), ''],
];

describe('request bodies', () => {
  for (const [name, path, run, expected] of cases) {
    it(name, async () => {
      const { client, calls } = makeClient();
      await run(client);
      expect(calls).toHaveLength(1);
      const c = calls[0]!;
      expect(c.url).toBe('https://api.test' + path);
      if (expected === '') {
        expect(c.body).toBeUndefined();
      } else {
        const sent: unknown = JSON.parse(c.body!);
        expect(sent).toEqual(JSON.parse(expected));
        expect(c.body).toBe(JSON.stringify(sent));
        expect(nullMembers(sent)).toEqual([]);
      }
      expect(c.headers).not.toHaveProperty('Signature');
      expect(c.headers['X-CC-Signature']).toBe(
        'v1=' +
          signHmacV1(
            {
              timestamp: c.headers['X-CC-Timestamp']!,
              nonce: c.headers['X-CC-Nonce']!,
              method: 'POST',
              path,
              merchant: 'M1',
              idempotencyKey: c.headers['Idempotency-Key'],
              body: c.body,
            },
            'secret',
          ),
      );
    });
  }
});

describe('request body encoding', () => {
  async function sentBody(value: unknown): Promise<string> {
    const { client, calls } = makeClient();
    await client.request('/v1/raw', value);
    // An empty body reaches fetch as no body at all.
    return calls[0]!.body ?? '';
  }

  it('keeps key order and writes compact JSON', async () => {
    expect(await sentBody({ z: 1, a: { y: 'x', b: [true, false] }, m: '' })).toBe(
      '{"z":1,"a":{"y":"x","b":[true,false]},"m":""}',
    );
  });

  it('sends a bigint as its exact integer', async () => {
    const body = await sentBody({ n: 2n ** 64n + 1n, m: -5n, s: 2n ** 53n + 1n, a: [10n ** 30n] });
    expect(body).toBe('{"n":18446744073709551617,"m":-5,"s":9007199254740993,"a":[1000000000000000000000000000000]}');
  });

  it('writes strings as JSON.stringify does', async () => {
    const chars = [0x3c, 0x26, 0x3e, 0x2028, 0x2029, 0xd83d, 0xde00, 0x22, 0x5c, 0x08, 0x0c, 0x0a, 0x0d, 0x09, 0x00, 0xd800, 0x61];
    const s = String.fromCharCode(...chars);
    const body = await sentBody({ s });
    expect(body).toBe(JSON.stringify({ s }));
    expect(JSON.parse(body)).toEqual({ s });
  });

  it('writes numbers as JSON.stringify does', async () => {
    const value = { a: 1e21, b: 1e-7, c: 0.000001, d: 1e20, e: -0, f: 1.5 };
    expect(await sentBody(value)).toBe(JSON.stringify(value));
  });

  it('writes null, undefined and holes in arrays as null', async () => {
    const sparse: unknown[] = [1];
    sparse[2] = undefined;
    sparse[3] = null;
    sparse[4] = 3;
    expect(await sentBody(sparse)).toBe('[1,null,null,null,3]');
  });

  it('sends an empty body for undefined and null', async () => {
    expect(await sentBody(undefined)).toBe('');
    expect(await sentBody(null)).toBe('');
    expect(await sentBody({})).toBe('{}');
    expect(await sentBody([])).toBe('[]');
  });

  it('throws CryptoChiefError on values JSON cannot carry', async () => {
    for (const value of [{ n: NaN }, { n: Infinity }, [() => 1], { s: Symbol('x') }]) {
      await expect(sentBody(value)).rejects.toThrow(CryptoChiefError);
    }
  });

  it('handles deep values and throws CryptoChiefError past 10000', async () => {
    let v: unknown = {};
    for (let i = 1; i < 10000; i++) v = { a: v };
    expect(await sentBody(v)).toBe('{"a":'.repeat(9999) + '{}' + '}'.repeat(9999));
    await expect(sentBody({ a: v })).rejects.toThrow(CryptoChiefError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = [cyclic];
    await expect(sentBody(cyclic)).rejects.toThrow(CryptoChiefError);
    expect(() => toWire(cyclic)).toThrow(CryptoChiefError);
  });

  it('keeps a __proto__ key as data', async () => {
    expect(await sentBody(JSON.parse('{"__proto__":{"x":1},"a":null}'))).toBe('{"__proto__":{"x":1}}');
  });
});
