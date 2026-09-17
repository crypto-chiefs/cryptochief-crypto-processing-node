import { describe, it, expect } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as pkg from '../src/index';
import * as webhook from '../src/webhook';
import { createWebhookHandler, signWebhookV1, WEBHOOK_DELIVERY_HEADER, WEBHOOK_HEADERS } from '../src/index';

describe('package entry point', () => {
  it('re-exports every runtime export of the webhook module', () => {
    const missing = Object.keys(webhook).filter(
      (name) => (pkg as Record<string, unknown>)[name] !== (webhook as Record<string, unknown>)[name],
    );
    expect(missing).toEqual([]);
    expect(pkg.WEBHOOK_DELIVERY_HEADER).toBe('X-Webhook-Delivery');
    expect(pkg.WEBHOOK_HEADERS).toEqual({
      delivery: 'X-Webhook-Delivery',
      timestamp: 'X-CC-Timestamp',
      signature: 'X-CC-Signature',
    });
  });

  it('does not export the removed signing API', () => {
    for (const name of [
      'sign',
      'signValue',
      'canonicalJSON',
      'canonicalizeJSON',
      'verifyWebhookSignature',
      'WebhookSignatureError',
      'WEBHOOK_HEADER',
      'WEBHOOK_SIGNATURE_HEADERS',
    ]) {
      expect(pkg).not.toHaveProperty(name);
    }
  });

  it('lets a webhook handler read the delivery id via WEBHOOK_DELIVERY_HEADER', async () => {
    const apiKey = 'test_api_key_123';
    const deliveryId = '44444444-4444-4444-8444-444444444444';
    const body = JSON.stringify({ event: 'invoice.paid', order_id: 'o-1' });
    const timestamp = Math.floor(Date.now() / 1000);
    const seen: string[] = [];

    const server: Server = createServer(
      createWebhookHandler(apiKey, (_event, { req }) => {
        seen.push(req.headers[WEBHOOK_DELIVERY_HEADER.toLowerCase()] as string);
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/webhook',
            headers: {
              'Content-Type': 'application/json',
              [WEBHOOK_HEADERS.timestamp]: String(timestamp),
              [WEBHOOK_DELIVERY_HEADER]: deliveryId,
              [WEBHOOK_HEADERS.signature]: signWebhookV1(apiKey, timestamp, deliveryId, body),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
      expect(status).toBe(200);
      expect(seen).toEqual([deliveryId]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
