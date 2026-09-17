import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CryptoChiefClient } from '../src/client';
import { ApiError, ErrorCode, isApiError } from '../src/errors';
import { checkHmacV1, OUTCOME_CODE, OUTCOME_STATUS } from './gateway-hmac-v1';

// A gateway stand-in: the client talks to it over real HTTP with the global
// fetch, and it checks the signature with the rules in ./gateway-hmac-v1.ts,
// written from the specification without the SDK's signing code.

const KEYS: Record<string, string> = { M1: 'secret' };

interface Received {
  method: string;
  url: string;
  headers: Record<string, string[]>;
  body: Buffer;
  result: number;
}

class MockGateway {
  readonly received: Received[] = [];
  clockOffsetSec = 0;
  private readonly nonces = new Set<string>();
  private server?: Server;
  port = 0;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const lines: [string, string][] = [];
    const headers: Record<string, string[]> = {};
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      lines.push([req.rawHeaders[i]!, req.rawHeaders[i + 1]!]);
      (headers[req.rawHeaders[i]!.toLowerCase()] ??= []).push(req.rawHeaders[i + 1]!);
    }
    const entry: Received = { method: req.method ?? '', url: req.url ?? '', headers, body, result: 0 };
    this.received.push(entry);
    const [status, payload] = this.check(entry, lines);
    entry.result = status;
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  }

  private check(r: Received, lines: [string, string][]): [number, Record<string, unknown>] {
    // The route the server signs is percent-decoded (Go's r.URL.Path); the
    // query is signed as it arrives (r.URL.RawQuery).
    const cut = r.url.search(/[?#]/);
    const path = decodeURIComponent(cut < 0 ? r.url : r.url.slice(0, cut));
    const q = r.url.indexOf('?');
    const rawQuery = q < 0 ? '' : r.url.slice(q + 1).split('#')[0]!;
    const serverTime = Math.floor(Date.now() / 1000) + this.clockOffsetSec;

    const outcome = checkHmacV1(
      { method: r.method, path, rawQuery, headers: lines, body: r.body },
      { keys: KEYS, nowSec: serverTime, nonces: this.nonces },
    );
    if (outcome !== 'ok') {
      const code = OUTCOME_CODE[outcome];
      const extra = outcome === 'timestamp_out_of_range' ? { server_time: serverTime } : {};
      return [OUTCOME_STATUS[outcome], { ok: false, error: code, msg: code.toLowerCase(), ...extra }];
    }
    return [200, { uuid: 'u1', status: 'paid', credits_balance: 5, items: [] }];
  }
}

const gw = new MockGateway();
let baseUrl = '';

beforeAll(async () => {
  await gw.start();
  baseUrl = `http://127.0.0.1:${gw.port}`;
});

afterAll(async () => {
  await gw.stop();
});

function client(apiKey = 'secret'): CryptoChiefClient {
  return new CryptoChiefClient({ merchantId: 'M1', apiKey, baseUrl, retries: 0 });
}

describe('HMAC v1 against a gateway over HTTP', () => {
  it('is accepted for service calls, and sends no Signature', async () => {
    const start = gw.received.length;
    const c = client();
    expect((await c.payouts.info('u1')).uuid).toBe('u1');
    expect((await c.credits.balance()).creditsBalance).toBe(5);
    await c.request('/v1/payments/history?page=2&page_size=10', {});
    await c.payouts.execute({
      network: 'TRON_MAINNET',
      coin: 'USDT',
      amount: '10.5',
      toAddress: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
      orderId: 'заказ-1 <&>',
      userId: 'u',
      urlCallback: 'https://shop.example/cb?a=1&b=2',
      memo: null as never,
    });
    await c.request('/v1/raw', { n: 2n ** 64n + 1n, s: 'x'.repeat(70_000) });

    const got = gw.received.slice(start);
    expect(got.map((r) => r.result)).toEqual([200, 200, 200, 200, 200]);
    for (const r of got) {
      expect(r.headers).not.toHaveProperty('signature');
      expect(r.headers['x-cc-signature']).toHaveLength(1);
    }
    expect(got[0]!.body.toString('utf8')).toBe('{"uuid":"u1"}');
    expect(got[2]!.url).toBe('/v1/payments/history?page=2&page_size=10');
    expect(JSON.parse(got[3]!.body.toString('utf8'))).toEqual({
      network: 'TRON_MAINNET',
      coin: 'USDT',
      amount: '10.5',
      to_address: 'TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7',
      order_id: 'заказ-1 <&>',
      user_id: 'u',
      url_callback: 'https://shop.example/cb?a=1&b=2',
    });
    expect(got[4]!.body.toString('utf8').startsWith('{"n":18446744073709551617,"s":"xxx')).toBe(true);
  });

  it('signs the percent-decoded path the server reads', async () => {
    const start = gw.received.length;
    const c = client();
    await c.request('/v1/orders/payout%2F8814', {});
    await c.request('/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%20%231?q=a%2Fb', {});
    // %2F, %20 and non-ASCII in the path, and the same in the query.
    await c.request(
      '/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F%E2%84%9642%20b?q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F1&r=a%20b',
      {},
    );
    // Written as text: fetch escapes it on the wire, the server decodes the path back.
    await c.request('/v1/orders/заказ №42?q=заказ 1', {});
    const got = gw.received.slice(start);
    expect(got.map((r) => r.result)).toEqual([200, 200, 200, 200]);
    // The wire keeps the escapes; only the string to sign is decoded.
    expect(got[0]!.url).toBe('/v1/orders/payout%2F8814');
    expect(got[1]!.url).toBe('/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%20%231?q=a%2Fb');
    expect(got[2]!.url).toBe(
      '/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F%E2%84%9642%20b?q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%2F1&r=a%20b',
    );
    expect(got[3]!.url).toBe(
      '/v1/orders/%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%20%E2%84%9642?q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7%201',
    );
  });

  it('accepts a signed request with any method, GET with a query included', async () => {
    const start = gw.received.length;
    const c = client();
    const res = await c.send<{ uuid: string }>(
      'GET',
      '/v1/payments/order/info?uuid=5b0c7a52-8a1e-4c0e-9d7b-2f3e4a5b6c7d&q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7',
    );
    expect(res.uuid).toBe('u1');
    await c.send('get', '/v1/payments/history?page=2');
    await c.send('DELETE', '/v1/wallets/label', { address: 'T1' });
    const got = gw.received.slice(start);
    expect(got.map((r) => r.result)).toEqual([200, 200, 200]);
    expect(got.map((r) => r.method)).toEqual(['GET', 'GET', 'DELETE']);
    expect(got[0]!.url).toBe(
      '/v1/payments/order/info?uuid=5b0c7a52-8a1e-4c0e-9d7b-2f3e4a5b6c7d&q=%D0%B7%D0%B0%D0%BA%D0%B0%D0%B7',
    );
    // No body, no Content-Type; the service calls keep sending POST.
    expect(got[0]!.body.length).toBe(0);
    expect(got[0]!.headers).not.toHaveProperty('content-type');
    expect(got[2]!.body.toString('utf8')).toBe('{"address":"T1"}');
    expect((await c.payouts.info('u1')).uuid).toBe('u1');
    expect(gw.received[gw.received.length - 1]!.method).toBe('POST');
  });

  it('sends Idempotency-Key inside the signature', async () => {
    const start = gw.received.length;
    const c = client();
    const key = 'payout-2026-09-16-0001';
    expect((await c.payouts.info('u1', { idempotencyKey: key })).uuid).toBe('u1');
    await c.request('/v1/payout/info', { uuid: 'u2' }, { idempotencyKey: key });
    const got = gw.received.slice(start);
    expect(got.map((r) => r.result)).toEqual([200, 200]);
    for (const r of got) expect(r.headers['idempotency-key']).toEqual([key]);

    // No key: no header, and the empty line is signed.
    await c.payouts.info('u3');
    const plain = gw.received[gw.received.length - 1]!;
    expect(plain.result).toBe(200);
    expect(plain.headers).not.toHaveProperty('idempotency-key');
  });

  it('refuses a key added after signing', async () => {
    const start = gw.received.length;
    await client().payouts.info('u1');
    const signed = gw.received[start]!;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(signed.headers)) headers[k] = v[0]!;
    delete headers['content-length'];
    delete headers['host'];
    delete headers['connection'];
    const send = (extra: Record<string, string> = {}) =>
      fetch(`${baseUrl}${signed.url}`, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: signed.body,
      });

    // The same bytes reach the signature check; only the added header changes
    // the answer, so the header alone is what breaks the signature.
    const asIs = await send();
    expect(((await asIs.json()) as { error: string }).error).toBe('SIGNATURE_REPLAYED');
    const withKey = await send({ 'Idempotency-Key': 'added-by-a-fetch-wrapper' });
    expect(withKey.status).toBe(401);
    expect(((await withKey.json()) as { error: string }).error).toBe('INVALID_SIGNATURE');
  });

  it('rejects a request signed only with Signature', async () => {
    const start = gw.received.length;
    const body = '{"uuid":"u1"}';
    const res = await fetch(`${baseUrl}/v1/payout/info`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Merchant: 'M1',
        Signature: '8736fa6829d988843b78daafab392b70',
      },
      body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('BAD_AUTH_HEADERS');
    expect(gw.received.slice(start).map((r) => r.result)).toEqual([400]);
  });

  it('maps a wrong key to INVALID_SIGNATURE without repeating', async () => {
    const start = gw.received.length;
    const err = await client('wrong').payouts.info('u1').catch((e: unknown) => e);
    expect(isApiError(err, ErrorCode.InvalidSignature)).toBe(true);
    expect((err as ApiError).httpStatus).toBe(401);
    expect(gw.received.length - start).toBe(1);
  });

  it('refuses a replayed request', async () => {
    const start = gw.received.length;
    await client().payouts.info('u1');
    const first = gw.received[start]!;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(first.headers)) headers[k] = v[0]!;
    delete headers['content-length'];
    delete headers['host'];
    delete headers['connection'];
    const res = await fetch(`${baseUrl}${first.url}`, { method: 'POST', headers, body: first.body });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('SIGNATURE_REPLAYED');
  });

  it('corrects a skewed clock from server_time and repeats once', async () => {
    const start = gw.received.length;
    gw.clockOffsetSec = 1_000;
    try {
      const c = client();
      expect((await c.payouts.info('u1')).uuid).toBe('u1');
      expect(gw.received.slice(start).map((r) => r.result)).toEqual([401, 200]);
      await c.payouts.info('u2');
      expect(gw.received.slice(start).map((r) => r.result)).toEqual([401, 200, 200]);
    } finally {
      gw.clockOffsetSec = 0;
    }
  });
});
