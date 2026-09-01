import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { ChainFamily } from '../src/chains';
import { WalletType } from '../src/services/wallets';

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

/** The shape the wallet endpoints answer with: a static wallet with both links and a name. */
const staticWallet = JSON.stringify({
  type: 'static',
  address: '0xstatic',
  chain_family: 'EVM',
  frozen: false,
  master_wallet_address: '0xmaster',
  callback_url: 'https://your.app/webhooks/deposit',
  label: 'customer-4242',
});

/** The same shape with the nullable fields absent - the platform sends null, not "". */
const transitWallet = JSON.stringify({
  type: 'transit',
  address: '0xtransit',
  chain_family: 'EVM',
  frozen: false,
  master_wallet_address: null,
  callback_url: null,
  label: null,
});

describe('wallet generate', () => {
  it('sends the label and omits it when unset', async () => {
    const { client, calls } = makeClient(
      () => new Response(JSON.stringify({ address: '0xnew', chain_family: 'EVM' }), { status: 200 }),
    );

    await client.wallets.generate({
      walletType: WalletType.Master,
      chainFamily: ChainFamily.Evm,
      label: 'Treasury EU',
    });

    const body = sentBody(calls);
    expect(firstCall(calls).url).toContain('/v1/wallets/generate');
    expect(body).toEqual({ wallet_type: 'master', chain_family: 'EVM', label: 'Treasury EU' });

    const second = makeClient(
      () => new Response(JSON.stringify({ address: '0xnew2', chain_family: 'EVM' }), { status: 200 }),
    );
    await second.client.wallets.generate({
      walletType: WalletType.Static,
      chainFamily: ChainFamily.Evm,
      masterWalletAddress: '0xmaster',
    });
    // No label means no key: an empty string is a name, not the absence of one.
    expect('label' in sentBody(second.calls)).toBe(false);
  });
});

describe('wallet rebind-master', () => {
  it('sends exactly the address and the new master', async () => {
    const { client, calls } = makeClient(() => new Response(staticWallet, { status: 200 }));

    const out = await client.wallets.rebindMaster('0xstatic', '0xmaster');

    expect(firstCall(calls).url).toContain('/v1/wallets/rebind-master');
    expect(sentBody(calls)).toEqual({ address: '0xstatic', master_wallet_address: '0xmaster' });
    expect(out.type).toBe('static');
    expect(out.masterWalletAddress).toBe('0xmaster');
  });

  it('decodes a wallet with no master, no callback and no name without tripping over the nulls', async () => {
    const { client } = makeClient(() => new Response(transitWallet, { status: 200 }));

    const out = await client.wallets.rebindMaster('0xtransit', '0xmaster');

    // Null is the platform's "there is none" - it has to survive the case layer
    // as null rather than throw or turn into the string "null".
    expect(out.masterWalletAddress).toBeNull();
    expect(out.callbackUrl).toBeNull();
    expect(out.label).toBeNull();
    expect(out.frozen).toBe(false);
    expect(out.chainFamily).toBe(ChainFamily.Evm);
  });
});

describe('wallet callback-url', () => {
  it('sends the URL it was given', async () => {
    const { client, calls } = makeClient(() => new Response(staticWallet, { status: 200 }));

    const out = await client.wallets.setCallbackUrl('0xstatic', 'https://your.app/webhooks/deposit');

    expect(firstCall(calls).url).toContain('/v1/wallets/callback-url');
    expect(sentBody(calls)).toEqual({
      address: '0xstatic',
      callback_url: 'https://your.app/webhooks/deposit',
    });
    expect(out.callbackUrl).toBe('https://your.app/webhooks/deposit');
  });

  it('sends an empty callback_url rather than omitting it', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            type: 'static',
            address: '0xstatic',
            chain_family: 'EVM',
            frozen: false,
            master_wallet_address: '0xmaster',
            callback_url: null,
          }),
          { status: 200 },
        ),
    );

    const out = await client.wallets.setCallbackUrl('0xstatic', '');

    // "" is the instruction to clear the webhook. Dropping the field would ask
    // the platform to change nothing - the opposite of what the caller meant.
    const body = sentBody(calls);
    expect('callback_url' in body).toBe(true);
    expect(body.callback_url).toBe('');
    expect(firstCall(calls).init.body).toBe('{"address":"0xstatic","callback_url":""}');
    // Cleared reads back as null, never as "".
    expect(out.callbackUrl).toBeNull();
  });
});

describe('wallet label', () => {
  it('sends exactly the address and the name', async () => {
    const { client, calls } = makeClient(() => new Response(staticWallet, { status: 200 }));

    const out = await client.wallets.setLabel('0xstatic', 'customer-4242');

    expect(firstCall(calls).url).toContain('/v1/wallets/label');
    expect(sentBody(calls)).toEqual({ address: '0xstatic', label: 'customer-4242' });
    expect(out.label).toBe('customer-4242');
  });

  it('sends an empty label rather than omitting it', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            type: 'static',
            address: '0xstatic',
            chain_family: 'EVM',
            frozen: false,
            master_wallet_address: '0xmaster',
            callback_url: 'https://your.app/webhooks/deposit',
            label: null,
          }),
          { status: 200 },
        ),
    );

    const out = await client.wallets.setLabel('0xstatic', '');

    // "" is the instruction to clear the name. Dropping the field would ask the
    // platform to change nothing - the opposite of what the caller meant.
    const body = sentBody(calls);
    expect('label' in body).toBe(true);
    expect(body.label).toBe('');
    expect(firstCall(calls).init.body).toBe('{"address":"0xstatic","label":""}');
    // Cleared reads back as null, never as "".
    expect(out.label).toBeNull();
  });

  it('names a master wallet too - it is not static-only like the callback URL', async () => {
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            type: 'master',
            address: '0xmaster',
            chain_family: 'EVM',
            frozen: false,
            master_wallet_address: null,
            callback_url: null,
            label: 'Treasury EU',
          }),
          { status: 200 },
        ),
    );

    const out = await client.wallets.setLabel('0xmaster', 'Treasury EU');

    expect(sentBody(calls)).toEqual({ address: '0xmaster', label: 'Treasury EU' });
    expect(out.type).toBe('master');
    expect(out.label).toBe('Treasury EU');
    expect(out.masterWalletAddress).toBeNull();
  });
});

describe('wallet reads carry the label', () => {
  it('reads the name off info, and a nameless wallet as null', async () => {
    const { client, calls } = makeClient(() => new Response(staticWallet, { status: 200 }));

    const named = await client.wallets.info('0xstatic');

    expect(firstCall(calls).url).toContain('/v1/wallets/info');
    expect(named.label).toBe('customer-4242');

    const second = makeClient(() => new Response(transitWallet, { status: 200 }));
    const nameless = await second.client.wallets.info('0xtransit');
    // The key is always there; null is "no name", not "not reported".
    expect(nameless.label).toBeNull();
  });

  it('reads the name off every item of the list', async () => {
    const { client } = makeClient(
      () => new Response(`{"items":[${staticWallet},${transitWallet}]}`, { status: 200 }),
    );

    const out = await client.wallets.list();

    expect(out.items.map((w) => w.label)).toEqual(['customer-4242', null]);
  });

  it('reads the name off a freshly generated wallet', async () => {
    const { client } = makeClient(
      () =>
        new Response(JSON.stringify({ address: '0xnew', chain_family: 'EVM', label: 'Treasury EU' }), {
          status: 200,
        }),
    );

    const out = await client.wallets.generate({
      walletType: WalletType.Master,
      chainFamily: ChainFamily.Evm,
      label: 'Treasury EU',
    });

    expect(out.label).toBe('Treasury EU');
  });
});
