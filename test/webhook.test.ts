import { describe, it, expect } from 'vitest';
import { canonicalJSON, sign } from '../src/sign';
import {
  verifyWebhookSignature,
  parseWebhookEvent,
  WebhookSignatureError,
  type PayoutWebhookEvent,
} from '../src/webhook';

const KEY = 'test_api_key_123';

// What the server sends: arbitrary JSON bytes + the signature over their canonical form.
const eventObject = {
  event: 'payout.paid',
  uuid: 'p-1',
  order_id: 'o-1',
  status: 'paid',
  amount_to_receive: '0.0099',
};
const canonicalSig = sign(canonicalJSON(eventObject), KEY);

describe('verifyWebhookSignature', () => {
  it('accepts a correctly-signed body (canonical form)', () => {
    const rawBody = canonicalJSON(eventObject);
    expect(verifyWebhookSignature(KEY, rawBody, canonicalSig)).toBe(true);
  });

  it('accepts an unsorted body (re-canonicalized before hashing)', () => {
    const unsorted = JSON.stringify({
      status: 'paid',
      amount_to_receive: '0.0099',
      event: 'payout.paid',
      order_id: 'o-1',
      uuid: 'p-1',
    });
    expect(verifyWebhookSignature(KEY, unsorted, canonicalSig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    expect(verifyWebhookSignature(KEY, canonicalJSON(eventObject), 'deadbeef')).toBe(false);
  });

  it('rejects a tampered body', () => {
    const tampered = JSON.stringify({ ...eventObject, amount_to_receive: '9.9999' });
    expect(verifyWebhookSignature(KEY, tampered, canonicalSig)).toBe(false);
  });

  it('rejects empty body / missing signature', () => {
    expect(verifyWebhookSignature(KEY, '', canonicalSig)).toBe(false);
    expect(verifyWebhookSignature(KEY, canonicalJSON(eventObject), undefined)).toBe(false);
  });
});

describe('parseWebhookEvent', () => {
  it('returns the camelCased typed event on a valid signature', () => {
    const evt = parseWebhookEvent<PayoutWebhookEvent>(KEY, canonicalJSON(eventObject), canonicalSig);
    expect(evt.event).toBe('payout.paid');
    expect(evt.orderId).toBe('o-1');
    expect(evt.amountToReceive).toBe('0.0099');
  });

  it('throws WebhookSignatureError on an invalid signature', () => {
    expect(() => parseWebhookEvent(KEY, canonicalJSON(eventObject), 'bad')).toThrow(WebhookSignatureError);
  });
});
