import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CryptoChiefError } from './errors';
import { canonicalJSON, sign } from './sign';
import { fromWire } from './case';
import type { Chain, ChainFamily } from './chains';
import type { PayInMode } from './services/payins';
import type { TxType } from './services/transactions';

/** Thrown when a webhook signature does not match the body. */
export class WebhookSignatureError extends CryptoChiefError {
  constructor() {
    super('cryptochief: invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

/** Case-insensitive header name carrying the webhook signature. */
export const WEBHOOK_HEADER = 'Signature';

/**
 * Header carrying the delivery's uuid on every webhook the platform sends.
 * Constant across every attempt and resend of one delivery - use it as your
 * receiver's idempotency key - and the argument `client.webhooks.info()` /
 * `resend()` take. Keep it when you log an incoming webhook: there is no
 * other way to name a delivery later.
 */
export const WEBHOOK_DELIVERY_HEADER = 'X-Webhook-Delivery';

/** IP addresses Crypto Chief delivers webhooks from - whitelist for defense in depth. */
export const WEBHOOK_SENDER_IPS = ['164.90.231.203', '104.248.248.64'] as const;

function toBytes(body: string | Buffer | Uint8Array): Buffer {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

/**
 * Verify an incoming webhook against the merchant API key. `rawBody` MUST be
 * the exact bytes received - do not re-encode it first. Returns `true`/`false`;
 * the comparison is constant-time.
 *
 * The signature is `hex(md5(base64(canonicalJSON(body)) + apiKey))` - the same
 * algorithm used for outgoing requests. The body is re-canonicalized before
 * hashing, so any key-order drift is normalized.
 */
export function verifyWebhookSignature(
  apiKey: string,
  rawBody: string | Buffer | Uint8Array,
  signature: string | undefined | null,
): boolean {
  if (!apiKey) throw new CryptoChiefError('cryptochief: apiKey is required for webhook verification');
  const bytes = toBytes(rawBody);
  if (bytes.length === 0 || !signature) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return false; // not JSON -> fail closed
  }
  const expected = sign(canonicalJSON(parsed), apiKey);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Verify and parse a webhook in one step. Throws {@link WebhookSignatureError}
 * if the signature is invalid; otherwise returns the typed, camelCased event.
 *
 * ```ts
 * const evt = parseWebhookEvent<PayoutWebhookEvent>(apiKey, req.body, req.headers['signature']);
 * ```
 */
export function parseWebhookEvent<T = WebhookEvent>(
  apiKey: string,
  rawBody: string | Buffer | Uint8Array,
  signature: string | undefined | null,
): T {
  if (!verifyWebhookSignature(apiKey, rawBody, signature)) throw new WebhookSignatureError();
  return fromWire(JSON.parse(toBytes(rawBody).toString('utf8'))) as T;
}

/** Options for {@link createWebhookHandler}. */
export interface WebhookHandlerOptions {
  /** Max accepted body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
}

/**
 * Create a Node `http` request handler that reads the raw body, verifies the
 * signature, parses the typed event, and invokes `onEvent`. Responds `200` if
 * the callback didn't write a response, `401` on a bad signature, `405` for
 * non-POST. Works as a plain `http`/`https` listener or an Express route
 * mounted before any body parser.
 *
 * For Express with `express.raw()`, prefer calling {@link parseWebhookEvent}
 * directly on `req.body`.
 */
export function createWebhookHandler<T = WebhookEvent>(
  apiKey: string,
  onEvent: (event: T, ctx: { req: IncomingMessage; res: ServerResponse }) => void | Promise<void>,
  options: WebhookHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? 1 << 20;
  return (req, res) => {
    void (async () => {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        res.writeHead(405).end('method not allowed');
        return;
      }
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBytes);
      } catch (err) {
        res.writeHead(400).end(err instanceof Error ? err.message : 'read error');
        return;
      }
      const sig = headerValue(req.headers[WEBHOOK_HEADER.toLowerCase()]);
      if (!verifyWebhookSignature(apiKey, raw, sig)) {
        res.writeHead(401).end('invalid signature');
        return;
      }
      const event = fromWire(JSON.parse(raw.toString('utf8'))) as T;
      try {
        await onEvent(event, { req, res });
      } catch {
        if (!res.headersSent) res.writeHead(500).end('handler error');
        return;
      }
      if (!res.writableEnded) res.writeHead(200).end();
    })();
  };
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new CryptoChiefError('cryptochief: webhook body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// -- Typed event payloads -----------------------------------------------------

/** Payout webhook. Fires only on terminal status: `payout.paid` / `payout.system_fail`. */
export interface PayoutWebhookEvent {
  event: string;
  uuid: string;
  orderId: string;
  userId?: string;
  status: string;
  amountRequested?: string;
  amountToReceive?: string;
  toAddress?: string;
  feeInfo?: Record<string, unknown>;
  sources?: unknown;
  serviceOperations?: unknown;
  createdAt?: string;
  completedAt?: string;
  errorReason?: string;
}

/** Transaction webhook. Fires only on terminal status (`transaction.confirmed`/`failed`/`expired`). */
export interface TransactionWebhookEvent {
  event: string;
  uuid: string;
  status: string;
  network?: Chain;
  chainFamily?: ChainFamily;
  type?: TxType;
  fromAddress?: string;
  toAddress?: string;
  value?: string;
  contract?: string;
  txHash?: string;
  createdAt?: string;
  completedAt?: string;
  errorReason?: string;
}

/** Pay-in webhook. Event names carry the `invoice.` prefix (e.g. `invoice.paid`). */
export interface PayInWebhookEvent {
  event: string;
  uuid: string;
  orderId: string;
  userId?: string;
  status: string;
  prevStatus?: string;
  mode?: PayInMode;
  amountCrypto?: string;
  amountFiat?: string;
  factAmountCrypto?: string;
  factAmountFiat?: string;
  currency?: string;
  paymentCoin?: string;
  paymentNetwork?: Chain;
  toAddress?: string;
  txid?: string;
}

/** Static-deposit webhook. Event names carry the `static_deposit.` prefix. */
export interface StaticDepositWebhookEvent {
  event: string;
  uuid: string;
  status: string;
  network?: Chain;
  chainFamily?: ChainFamily;
  coin?: string;
  contract?: string;
  decimals?: number;
  toAddress?: string;
  fromAddress?: string;
  txHash?: string;
  amount?: string;
  amountFiat?: string;
  confirmations?: number;
  requiredConfirmations?: number;
  foundInMempool?: boolean;
  logType?: string;
  blockNumber?: number;
  createdAt?: string;
  updatedAt?: string;
  confirmedAt?: string;
  paidAt?: string;
}

/**
 * The only sweep event the platform emits. There is deliberately no
 * `sweep.broadcasted`: "we sent it" is not something you can act on, and an
 * event that means "maybe" is one more thing to reconcile.
 */
export const SWEEP_EVENT_CONFIRMED = 'sweep.confirmed';

/**
 * Payload on `sweep.confirmed`: funds that arrived on one of your deposit
 * wallets have been swept to your master wallet AND the sweep transaction is
 * confirmed on chain.
 *
 * A `static_deposit.paid` tells you a customer paid you. This tells you the
 * money has finished moving into your own custody - until it fires, the balance
 * still sits on the deposit address. Reconciliation, treasury reporting and
 * "funds available to pay out" all key off this event, not off the deposit.
 *
 * Sweeps run on static deposit wallets AND on the transit wallets issued per
 * pay-in order; both deliver here, to the callback URL configured for the
 * wallet the funds left.
 */
export interface SweepWebhookEvent {
  event: string;
  /** The sweeper task. One sweep settles once - use it as your idempotency key. */
  taskId: string;
  /** Always `'completed'`. A sweep reaches you in no other state. */
  status: string;

  /** The wallet the funds left - the address your customer paid into. */
  walletAddress: string;
  /** The master wallet they landed on. */
  toAddress?: string;

  network: Chain;
  chainFamily?: ChainFamily;
  assetSymbol: string;
  assetContract?: string;
  /** `'native'` or `'token'`. */
  assetType?: string;
  amountRaw?: string;
  amountHuman?: string;

  sweepTxHash: string;
  /** Set when the platform had to fund gas on the wallet before it could sweep. */
  gasPumpTxHash?: string;

  /**
   * What makes this event true rather than hopeful, and never zero. It travels
   * with the event rather than being implied by it: "confirmed" is not the same
   * number on every chain, so if you run your own finality policy you need the
   * count to apply it.
   */
  sweepConfirmations: number;

  /**
   * When the chain was observed to hold the sweep. NOT the task's completion
   * timestamp, which is stamped on every terminal outcome - failures included -
   * and so says nothing about settlement.
   */
  confirmedAt?: string;

  /** What triggered it: `'momentum'`, `'threshold'` or `'force'`. */
  typeWork?: string;
  /** What the sweep cost: network fee plus any gas or energy the platform fronted. */
  totalFeeUsd?: string;
}

/** Union of all known webhook event payloads. */
export type WebhookEvent =
  | PayoutWebhookEvent
  | TransactionWebhookEvent
  | PayInWebhookEvent
  | StaticDepositWebhookEvent
  | SweepWebhookEvent;
