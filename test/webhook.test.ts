import { describe, it, expect } from 'vitest';
import { canonicalJSON, sign } from '../src/sign';
import {
  verifyWebhookSignature,
  parseWebhookEvent,
  WebhookSignatureError,
  type PayoutWebhookEvent,
  type SweepWebhookEvent,
  type TransactionWebhookEvent,
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

describe('confirmation counts on webhook payloads', () => {
  const signed = (body: unknown) => {
    const raw = canonicalJSON(body);
    return { raw, sig: sign(raw, KEY) };
  };

  it('types the payout counts per source, per service operation and overall', () => {
    const { raw, sig } = signed({
      event: 'payout.paid',
      uuid: 'p-1',
      order_id: 'o-1',
      status: 'paid',
      sources: [
        { address: '0xa', network: 'ETH_MAINNET', coin: 'USDT', amount_crypto: '100', txid: '0xaaa', confirmations: 40 },
        { address: '0xb', network: 'ETH_MAINNET', coin: 'USDT', amount_crypto: '50', txid: '0xbbb', confirmations: 33 },
      ],
      service_operations: [
        { type: 'gas_refuel', context: 'payout_prepare', status: 'done', txid: '0xgas', confirmations: 40 },
      ],
      confirmations: 33,
      required_confirmations: 32,
    });

    const evt = parseWebhookEvent<PayoutWebhookEvent>(KEY, raw, sig);

    expect(evt.confirmations).toBe(33);
    // payout.paid is sent only once every source reached the depth.
    expect(evt.requiredConfirmations).toBe(32);
    expect(evt.sources?.every((s) => (s.confirmations ?? 0) >= evt.requiredConfirmations!)).toBe(true);
    expect(evt.sources?.map((s) => s.confirmations)).toEqual([40, 33]);
    expect(evt.sources?.[0]?.amountCrypto).toBe('100');
    expect(evt.sources?.[0]?.txid).toBe('0xaaa');
    expect(evt.sources?.[0]?.network).toBe('ETH_MAINNET');
    // The API never sends `amount`; the source amount is `amountCrypto`.
    expect(evt.sources?.[0]?.amount).toBeUndefined();
    expect(evt.sources?.reduce((sum, s) => sum + Number(s.amountCrypto), 0)).toBe(150);
    expect(evt.serviceOperations?.[0]?.confirmations).toBe(40);
  });

  it('leaves the payout counts absent when no source ever sent a transaction', () => {
    const { raw, sig } = signed({
      event: 'payout.system_fail',
      uuid: 'p-2',
      order_id: 'o-2',
      status: 'system_fail',
      sources: [{ address: '0xa', network: 'ETH_MAINNET', coin: 'USDT', amount_crypto: '10' }],
      service_operations: [],
      error_reason: 'no route',
    });

    const evt = parseWebhookEvent<PayoutWebhookEvent>(KEY, raw, sig);

    expect(evt.confirmations).toBeUndefined();
    expect(evt.sources?.[0]?.confirmations).toBeUndefined();
    expect(evt.sources?.[0]?.amountCrypto).toBe('10');
    expect(evt.sources?.[0]?.txid).toBeUndefined();
    expect(evt.serviceOperations).toEqual([]);
    // A payout that never reached the confirmation step may carry no depth.
    expect(evt.requiredConfirmations).toBeUndefined();
    expect('requiredConfirmations' in evt).toBe(false);
  });

  it('types the transaction count and threshold, 0 included', () => {
    const confirmed = signed({
      event: 'transaction.confirmed',
      uuid: 't-1',
      status: 'confirmed',
      confirmations: 12,
      required_confirmations: 12,
    });
    const expired = signed({
      event: 'transaction.expired',
      uuid: 't-2',
      status: 'expired',
      confirmations: 0,
      required_confirmations: 20,
    });

    const ok = parseWebhookEvent<TransactionWebhookEvent>(KEY, confirmed.raw, confirmed.sig);
    const gone = parseWebhookEvent<TransactionWebhookEvent>(KEY, expired.raw, expired.sig);

    expect([ok.confirmations, ok.requiredConfirmations]).toEqual([12, 12]);
    expect([gone.confirmations, gone.requiredConfirmations]).toEqual([0, 20]);
  });
});

describe('sweep.confirmed payload', () => {
  const signed = (body: unknown) => {
    const raw = canonicalJSON(body);
    return { raw, sig: sign(raw, KEY) };
  };

  const base = {
    event: 'sweep.confirmed',
    task_id: 'task-1',
    status: 'completed',
    wallet_address: 'TQrY8bYc2yQ8sM8nJ1sZ9c2Zx7L2wq7pQb',
    to_address: 'TMaster1111111111111111111111111111',
    network: 'TRON_MAINNET',
    chain_family: 'TRON',
    asset_symbol: 'USDT',
    asset_type: 'token',
    amount_human: '125.5',
    sweep_tx_hash: 'abc123',
    confirmed_at: '2026-09-14T10:00:00Z',
  };

  it('carries the depth the sweep was held to, reached by the count', () => {
    const { raw, sig } = signed({ ...base, sweep_confirmations: 21, required_confirmations: 20 });

    const evt = parseWebhookEvent<SweepWebhookEvent>(KEY, raw, sig);

    expect(evt.sweepConfirmations).toBe(21);
    expect(evt.requiredConfirmations).toBe(20);
    expect(evt.sweepConfirmations).toBeGreaterThanOrEqual(evt.requiredConfirmations!);
  });

  it('parses an event from a sweep service that predates the depth', () => {
    const { raw, sig } = signed({ ...base, sweep_confirmations: 1 });

    const evt = parseWebhookEvent<SweepWebhookEvent>(KEY, raw, sig);

    expect(evt.taskId).toBe('task-1');
    expect(evt.sweepConfirmations).toBe(1);
    expect(evt.requiredConfirmations).toBeUndefined();
    expect('requiredConfirmations' in evt).toBe(false);
  });
});
