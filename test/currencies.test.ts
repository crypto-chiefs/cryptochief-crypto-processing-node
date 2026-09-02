import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: () => Response, overrides: Partial<ClientOptions> = {}) {
  const calls: Captured[] = [];
  const fetchMock = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return handler();
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

describe('fiat currency list', () => {
  it('decodes the bare top-level array the endpoint actually sends', async () => {
    // Verbatim from the API reference: an array, not an `items` envelope. A
    // type written for {"items":[...]} compiles against this call and fails
    // only against the live API, which is the whole reason this test exists.
    const { client, calls } = makeClient(
      () =>
        new Response(
          JSON.stringify([
            { code: 'JMD', name: 'Jamaican Dollar' },
            { code: 'KYD', name: 'Cayman Islands Dollar' },
            { code: 'SEK', name: 'Swedish Krona' },
          ]),
          { status: 200 },
        ),
    );

    const fiats = await client.currencies.fiats();

    expect(firstCall(calls).url).toContain('/v1/currencies/fiats');
    // Nothing to filter by, but the empty body is still what gets signed - it
    // must go on the wire as `{}`, not as an absent body.
    expect(firstCall(calls).init.body).toBe('{}');
    expect(JSON.parse(firstCall(calls).init.body as string)).toEqual({});
    expect((firstCall(calls).init.headers as Record<string, string>).Signature).toBeTruthy();

    expect(Array.isArray(fiats)).toBe(true);
    expect(fiats).toHaveLength(3);
    const first = fiats[0];
    if (!first) throw new Error('expected a currency');
    expect(first.code).toBe('JMD');
    expect(first.name).toBe('Jamaican Dollar');
    expect(fiats.map((f) => f.code)).toEqual(['JMD', 'KYD', 'SEK']);
    expect(fiats[2]?.name).toBe('Swedish Krona');
  });

  it('answers an empty array without inventing an envelope', async () => {
    const { client } = makeClient(() => new Response('[]', { status: 200 }));

    expect(await client.currencies.fiats()).toEqual([]);
  });

  it('turns the literal null an empty result sends into an empty array', async () => {
    // The service builds its answer with `var list []FiatCurrency`, and an
    // empty slice marshals as JSON `null` rather than `[]`. A method whose
    // signature promises FiatCurrency[] has to hand back a list either way -
    // the documented pattern iterates the result, and null throws a TypeError
    // there instead of iterating zero times.
    const { client } = makeClient(() => new Response('null', { status: 200 }));

    const fiats = await client.currencies.fiats();

    expect(fiats).not.toBeNull();
    expect(Array.isArray(fiats)).toBe(true);
    expect(fiats).toEqual([]);
    expect(fiats).toHaveLength(0);

    // The usage the guide shows, run against the null body.
    const codes: string[] = [];
    for (const f of fiats) codes.push(f.code);
    expect(codes).toEqual([]);
    expect(fiats.slice(0, 3)).toEqual([]);
    expect(fiats.map((f) => f.code)).toEqual([]);
  });
});

describe('crypto ticker list', () => {
  const body = JSON.stringify({
    by_exchange: {
      binance: ['0G', '1000CAT', '1000SATS'],
      bybit: ['0G', '1INCH', 'AAVE'],
      exmo: ['AAVE', 'ADA'],
      kucoin: ['0G', 'AAVE'],
    },
    count: 5,
    quote: 'USDT',
    tickers: ['0G', '1000CAT', '1000SATS', '1INCH', 'AAVE'],
  });

  it('decodes the by_exchange map across several exchanges', async () => {
    const { client, calls } = makeClient(() => new Response(body, { status: 200 }));

    const cryptos = await client.currencies.cryptos();

    expect(firstCall(calls).url).toContain('/v1/currencies/cryptos');
    expect(firstCall(calls).init.body).toBe('{}');
    expect(JSON.parse(firstCall(calls).init.body as string)).toEqual({});
    expect((firstCall(calls).init.headers as Record<string, string>).Signature).toBeTruthy();

    expect(cryptos.quote).toBe('USDT');
    expect(cryptos.count).toBe(5);
    expect(cryptos.tickers).toEqual(['0G', '1000CAT', '1000SATS', '1INCH', 'AAVE']);

    // Four exchanges, each with its own list - not one flattened set, and not
    // only whichever exchange happened to be first.
    expect(Object.keys(cryptos.byExchange).sort()).toEqual(['binance', 'bybit', 'exmo', 'kucoin']);
    expect(cryptos.byExchange.binance).toEqual(['0G', '1000CAT', '1000SATS']);
    expect(cryptos.byExchange.bybit).toEqual(['0G', '1INCH', 'AAVE']);
    expect(cryptos.byExchange.exmo).toEqual(['AAVE', 'ADA']);
    expect(cryptos.byExchange.kucoin).toEqual(['0G', 'AAVE']);
  });

  it('keeps exchange names verbatim - they are data, not field names', async () => {
    // The SDK camelCases response *keys*; an exchange name is a value that
    // happens to sit in key position, so `gate_io` must not become `gateIo`.
    const { client } = makeClient(
      () =>
        new Response(
          JSON.stringify({
            by_exchange: { gate_io: ['BTC'], 'crypto.com': ['ETH'] },
            count: 2,
            quote: 'USDT',
            tickers: ['BTC', 'ETH'],
          }),
          { status: 200 },
        ),
    );

    const cryptos = await client.currencies.cryptos();

    expect(Object.keys(cryptos.byExchange).sort()).toEqual(['crypto.com', 'gate_io']);
    expect(cryptos.byExchange.gate_io).toEqual(['BTC']);
    expect(cryptos.byExchange).not.toHaveProperty('gateIo');
  });

  it('survives an empty exchange map', async () => {
    const { client } = makeClient(
      () =>
        new Response('{"by_exchange":{},"count":0,"quote":"USDT","tickers":[]}', { status: 200 }),
    );

    const cryptos = await client.currencies.cryptos();

    expect(cryptos.byExchange).toEqual({});
    expect(cryptos.tickers).toEqual([]);
    expect(cryptos.count).toBe(0);
    expect(cryptos.quote).toBe('USDT');
  });

  it('turns a null nested inside the envelope into an empty list and map', async () => {
    // The service builds `tickers` with `var list []string` and the map the
    // same way, so an empty one marshals as JSON `null`, not `[]`/`{}`. The
    // types promise a list and a map; both have to arrive iterable.
    const { client } = makeClient(
      () =>
        new Response('{"by_exchange":null,"count":0,"quote":"USDT","tickers":null}', {
          status: 200,
        }),
    );

    const cryptos = await client.currencies.cryptos();

    expect(cryptos.tickers).not.toBeNull();
    expect(cryptos.byExchange).not.toBeNull();
    expect(cryptos.tickers).toEqual([]);
    expect(cryptos.byExchange).toEqual({});
    expect(Array.isArray(cryptos.tickers)).toBe(true);
    expect(Object.keys(cryptos.byExchange)).toEqual([]);
    expect(new Set(cryptos.tickers).size).toBe(0);
    expect(cryptos.quote).toBe('USDT');
  });

  it('turns a null inside the map into an empty list for that exchange', async () => {
    // The map's values are built the same way its keys are, so ONE exchange's
    // list can be `null` while the others are ordinary arrays. `byExchange` is
    // typed Record<string, string[]>; a caller indexing it and iterating the
    // result - the documented use - gets a TypeError if the null survives.
    const { client } = makeClient(
      () =>
        new Response(
          '{"by_exchange":{"binance":null,"bybit":["BTC","ETH"]},"count":2,"quote":"USDT","tickers":["BTC","ETH"]}',
          { status: 200 },
        ),
    );

    const cryptos = await client.currencies.cryptos();

    expect(Object.keys(cryptos.byExchange).sort()).toEqual(['binance', 'bybit']);
    expect(cryptos.byExchange.binance).not.toBeNull();
    expect(cryptos.byExchange.binance).toEqual([]);
    expect(cryptos.byExchange.bybit).toEqual(['BTC', 'ETH']);
    // Every value has to be iterable, not just the ones the API filled in.
    for (const [exchange, tickers] of Object.entries(cryptos.byExchange)) {
      expect(Array.isArray(tickers)).toBe(true);
      expect(tickers.includes('DOGE')).toBe(false);
      expect(exchange.length).toBeGreaterThan(0);
    }
  });

  it('turns a null whole body into an empty catalogue', async () => {
    const { client } = makeClient(() => new Response('null', { status: 200 }));

    const cryptos = await client.currencies.cryptos();

    expect(cryptos.tickers).toEqual([]);
    expect(cryptos.byExchange).toEqual({});
    expect(cryptos.count).toBe(0);
    expect(cryptos.quote).toBe('');
    // The guide's "price from cryptos(), offer from contractsAvailable()"
    // pattern builds a Set out of the tickers; null would throw here.
    const quotable = new Set(cryptos.tickers);
    expect(quotable.has('BTC')).toBe(false);
  });
});
