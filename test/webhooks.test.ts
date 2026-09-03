import { describe, it, expect } from 'vitest';
import { CryptoChiefClient, type ClientOptions } from '../src/client';
import { ApiError, ErrorCode } from '../src/errors';
import { WebhookDeliveryStatus } from '../src/services/webhooks';
import { WEBHOOK_DELIVERY_HEADER } from '../src/webhook';

interface Captured {
  url: string;
  init: RequestInit;
}

function makeClient(handler: (c: Captured) => Response, overrides: Partial<ClientOptions> = {}) {
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
    ...overrides,
  });
  return { client, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const delivery = {
  uuid: '44444444-4444-4444-8444-444444444444',
  event_type: 'invoice.paid',
  reference: 'order-1',
  target_url: 'https://m.example/hook',
  status: 'failed',
  attempts: 3,
  max_attempts: 10,
  resend_count: 1,
  last_error: 'HTTP 500',
  last_http_status: 500,
  next_attempt_at: null,
  delivered_at: null,
  created_at: '2026-09-03T10:00:00Z',
  superseded_by: null,
  attempt_history: [
    {
      attempt: 3,
      http_status: 500,
      error: 'HTTP 500',
      duration_ms: 120,
      target_url: 'https://m.example/hook',
      created_at: '2026-09-03T10:02:00Z',
      response_body: '<html>oops',
      response_content_type: 'text/html',
      response_truncated: true,
    },
    {
      attempt: 2,
      http_status: null,
      error: 'dial tcp: connection refused',
      duration_ms: null,
      target_url: 'https://m.example/hook',
      created_at: null,
      response_body: null,
      response_content_type: null,
      response_truncated: false,
    },
  ],
  payload: { body: '{"event":"invoice.paid"}', bytes: 24, truncated: false },
};

describe('webhooks', () => {
  it('reads a delivery with its attempts, keeping null as "not recorded"', async () => {
    const { client, calls } = makeClient(() => json(200, delivery));

    const d = await client.webhooks.info(delivery.uuid);

    expect(calls[0]!.url).toMatch(/\/v1\/webhooks\/info$/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uuid: delivery.uuid });
    expect(d.status).toBe(WebhookDeliveryStatus.Failed);
    expect(d.lastHttpStatus).toBe(500);
    expect(d.deliveredAt).toBeNull();
    expect(d.supersededBy).toBeNull();
    expect(d.attemptHistory).toHaveLength(2);
    const [answered, silent] = d.attemptHistory;
    expect(answered!.responseTruncated).toBe(true);
    expect(answered!.responseContentType).toBe('text/html');
    // An attempt nothing answered has no status and no body - only the error.
    expect(silent!.httpStatus).toBeNull();
    expect(silent!.responseBody).toBeNull();
    expect(silent!.createdAt).toBeNull();
    expect(silent!.error).toContain('connection refused');
    expect(d.payload.bytes).toBe(24);
  });

  it('resends a static deposit by the DEPOSIT uuid and reads the per-delivery list', async () => {
    const { client, calls } = makeClient(() =>
      json(200, {
        uuid: 'dep-1',
        deliveries: [
          { uuid: 'd-1', event_type: 'static_deposit.paid', reference: 'dep-1', status: 'delivered', queued: true, attempts: 2, resend_count: 1 },
        ],
        queued: 1,
        total: 1,
      }),
    );

    const out = await client.webhooks.resendStaticDeposit('dep-1');

    expect(calls[0]!.url).toMatch(/\/v1\/static-deposits\/resend$/);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uuid: 'dep-1' });
    expect(out.queued).toBe(1);
    expect(out.deliveries[0]!.queued).toBe(true);
    expect(out.deliveries[0]!.resendCount).toBe(1);
  });

  it('surfaces a refusal as an ApiError with the code, not a queued:false result', async () => {
    const { client } = makeClient(() =>
      json(409, { ok: false, error: 'DELIVERY_SUPERSEDED', msg: 'not the latest; resend invoice.paid instead', superseded_by: 'invoice.paid' }),
    );

    const err = await client.webhooks.resend(delivery.uuid).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe(ErrorCode.DeliverySuperseded);
    expect(apiErr.httpStatus).toBe(409);
    // The detail stays readable on the raw body.
    expect(apiErr.raw).toContain('"superseded_by":"invoice.paid"');
  });

  it('names the header the delivery uuid arrives in', () => {
    expect(WEBHOOK_DELIVERY_HEADER).toBe('X-Webhook-Delivery');
  });
});
