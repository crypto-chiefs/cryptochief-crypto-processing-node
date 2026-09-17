import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CryptoChiefError } from './errors';
import { isBlankApiKey } from './sign';
import { fromWire } from './case';
import type { Chain, ChainFamily } from './chains';
import type { PayInMode } from './services/payins';
import type { PayoutInfo, PayoutServiceOperation, PayoutSource } from './services/payouts';
import type { TransactionInfo, TxType } from './services/transactions';

/*
 * Webhook signature HMAC-SHA256 v1.
 *
 * ```
 * string_to_sign = "CC-HMAC-SHA256-WEBHOOK-V1\n" + X-CC-Timestamp + "\n" +
 *                  X-Webhook-Delivery + "\n" + hex(sha256(raw body))
 * X-CC-Signature = "v1=" + hex(hmac_sha256(apiKey, string_to_sign))
 * ```
 */

const WEBHOOK_V1_SCOPE = 'CC-HMAC-SHA256-WEBHOOK-V1';
const SIGNATURE_PREFIX = 'v1=';
const DEFAULT_TOLERANCE_SEC = 300;
const INT64_MAX = 9223372036854775807n;
const DELIVERY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNATURE = /^v1=[0-9A-Fa-f]{64}$/;

/**
 * Header carrying the delivery's uuid on every webhook the platform sends.
 * Constant across every attempt and resend of one delivery - use it as your
 * receiver's idempotency key - and the argument `client.webhooks.info()` /
 * `resend()` take. Keep it when you log an incoming webhook: there is no
 * other way to name a delivery later.
 */
export const WEBHOOK_DELIVERY_HEADER = 'X-Webhook-Delivery';

/** Webhook headers covered by the signature. Names are case-insensitive. */
export const WEBHOOK_HEADERS = {
  /** Delivery id: 1–128 chars of `[A-Za-z0-9_-]`. */
  delivery: WEBHOOK_DELIVERY_HEADER,
  /** Unix time of the attempt in seconds, decimal, without leading zeros. */
  timestamp: 'X-CC-Timestamp',
  /** `v1=<64 hex>`. */
  signature: 'X-CC-Signature',
} as const;

/** IP addresses Crypto Chief delivers webhooks from - whitelist for defense in depth. */
export const WEBHOOK_SENDER_IPS = ['164.90.231.203', '104.248.248.64'] as const;

/**
 * Why a webhook failed verification:
 *
 * - `'headers'` - `X-CC-Timestamp`, `X-Webhook-Delivery` or `X-CC-Signature`
 *   is missing, repeated or malformed;
 * - `'timestamp'` - `X-CC-Timestamp` is outside the tolerance;
 * - `'signature'` - the signature does not match.
 */
export type WebhookVerificationReason = 'headers' | 'timestamp' | 'signature';

const REASON_MESSAGES: Record<WebhookVerificationReason, string> = {
  headers: 'cryptochief: webhook signature headers are missing, repeated or malformed',
  timestamp: 'cryptochief: webhook timestamp is out of range',
  signature: 'cryptochief: webhook signature does not match',
};

/** Thrown when a webhook fails verification. Answer the sender with `401`. */
export class WebhookVerificationError extends CryptoChiefError {
  readonly reason: WebhookVerificationReason;

  constructor(reason: WebhookVerificationReason) {
    super(REASON_MESSAGES[reason]);
    this.name = 'WebhookVerificationError';
    this.reason = reason;
  }
}

/**
 * Request headers as a record (Node `req.headers`, `req.headersDistinct`, a
 * plain object; an array value is one value per header line) or as
 * `[name, value]` pairs (WHATWG `Headers`, `Map`, an array). Names are matched
 * case-insensitively; values under different spellings of one name count as
 * repeats.
 */
export type WebhookHeaders =
  | { readonly [name: string]: string | readonly string[] | undefined }
  | Iterable<readonly [string, string]>;

/** Options of {@link verifyWebhook}. */
export interface WebhookVerifyOptions {
  /**
   * Allowed difference between `X-CC-Timestamp` and the current time, in
   * seconds; the fraction is dropped. Default 300; zero or less means 300.
   */
  toleranceSec?: number;
  /** Current time. Default: the system clock. */
  now?: Date | (() => Date);
}

function bodyBytes(body: string | Uint8Array): Uint8Array {
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return body;
  throw new CryptoChiefError('cryptochief: webhook body must be the raw request body (string or bytes)');
}

function timestampString(timestamp: number | bigint): string {
  const ok =
    typeof timestamp === 'bigint'
      ? timestamp > 0n && timestamp <= INT64_MAX
      : Number.isSafeInteger(timestamp) && timestamp > 0;
  if (!ok) throw new CryptoChiefError('cryptochief: webhook timestamp must be a positive integer');
  return timestamp.toString();
}

function stringToSign(timestamp: string, deliveryId: string, body: Uint8Array): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return `${WEBHOOK_V1_SCOPE}\n${timestamp}\n${deliveryId}\n${bodyHash}`;
}

function mac(apiKey: string, message: string): Buffer {
  return createHmac('sha256', Buffer.from(apiKey, 'utf8')).update(message, 'utf8').digest();
}

/**
 * Webhook v1 string to sign. A string body is taken as UTF-8.
 * Throws {@link CryptoChiefError} when `timestamp` is not a positive integer
 * or `deliveryId` is not 1–128 chars of `[A-Za-z0-9_-]`.
 */
export function webhookV1StringToSign(
  timestamp: number | bigint,
  deliveryId: string,
  body: string | Uint8Array,
): string {
  const ts = timestampString(timestamp);
  if (typeof deliveryId !== 'string' || !DELIVERY_ID.test(deliveryId)) {
    throw new CryptoChiefError('cryptochief: webhook delivery id must be 1-128 chars of [A-Za-z0-9_-]');
  }
  return stringToSign(ts, deliveryId, bodyBytes(body));
}

/**
 * `X-CC-Signature` value for a webhook: `v1=<64 lowercase hex>`. `body` is the
 * exact bytes sent; a string is taken as UTF-8. Throws {@link CryptoChiefError}
 * on an `apiKey` that is empty or only spaces and tabs, and on the inputs
 * {@link webhookV1StringToSign} rejects.
 */
export function signWebhookV1(
  apiKey: string,
  timestamp: number | bigint,
  deliveryId: string,
  body: string | Uint8Array,
): string {
  if (isBlankApiKey(apiKey)) throw new CryptoChiefError('cryptochief: apiKey is required');
  return SIGNATURE_PREFIX + mac(apiKey, webhookV1StringToSign(timestamp, deliveryId, body)).toString('hex');
}

function headerValues(headers: WebhookHeaders, name: string): string[] {
  const want = name.toLowerCase();
  const values: string[] = [];
  const add = (v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      for (const x of v) values.push(typeof x === 'string' ? x : '');
      return;
    }
    values.push(typeof v === 'string' ? v : '');
  };
  if (headers === null || headers === undefined) return values;
  if (typeof headers !== 'object') {
    throw new CryptoChiefError('cryptochief: webhook headers must be the request headers');
  }
  if (typeof (headers as Iterable<unknown>)[Symbol.iterator] === 'function') {
    for (const entry of headers as Iterable<unknown>) {
      if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue;
      if (entry[0].toLowerCase() === want) add(entry[1]);
    }
    return values;
  }
  const record = headers as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === want) add(record[key]);
  }
  return values;
}

/** The only value of a header, without spaces and tabs at the ends; `undefined` when absent, repeated or with CR/LF. */
function singleHeader(headers: WebhookHeaders, name: string): string | undefined {
  const values = headerValues(headers, name);
  if (values.length !== 1) return undefined;
  const v = values[0]!.replace(/^[ \t]+|[ \t]+$/g, '');
  return /[\r\n]/.test(v) ? undefined : v;
}

function nowUnixSeconds(now: WebhookVerifyOptions['now']): bigint {
  const date = typeof now === 'function' ? now() : now;
  const ms = date === undefined ? Date.now() : date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(ms)) throw new CryptoChiefError('cryptochief: now must be a valid Date');
  return BigInt(Math.floor(ms / 1000));
}

function toleranceSeconds(toleranceSec: number | undefined): bigint {
  if (toleranceSec === undefined) return BigInt(DEFAULT_TOLERANCE_SEC);
  if (typeof toleranceSec !== 'number' || !Number.isFinite(toleranceSec)) {
    throw new CryptoChiefError('cryptochief: toleranceSec must be a finite number');
  }
  return BigInt(toleranceSec > 0 ? Math.trunc(toleranceSec) : DEFAULT_TOLERANCE_SEC);
}

/**
 * Verify a webhook against the merchant API key. Returns normally when the
 * webhook is authentic; throws {@link WebhookVerificationError} otherwise.
 *
 * `rawBody` is the request body exactly as received, before any JSON parsing;
 * a string is taken as UTF-8. Checks, in order: headers (`'headers'`), then
 * `|now - X-CC-Timestamp| <= toleranceSec` (`'timestamp'`), then the signature
 * (`'signature'`). Header values lose spaces and tabs at the ends; hex is
 * accepted in any case and compared in constant time.
 *
 * Throws {@link CryptoChiefError} on an `apiKey` that is empty or only spaces
 * and tabs, a body that is not a string or bytes, and invalid options.
 */
export function verifyWebhook(
  apiKey: string,
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  options: WebhookVerifyOptions = {},
): void {
  if (isBlankApiKey(apiKey)) {
    throw new CryptoChiefError('cryptochief: apiKey is required for webhook verification');
  }
  const body = bodyBytes(rawBody);
  const tolerance = toleranceSeconds(options.toleranceSec);
  const now = nowUnixSeconds(options.now);

  const tsValue = singleHeader(headers, WEBHOOK_HEADERS.timestamp);
  if (tsValue === undefined || !DECIMAL.test(tsValue)) throw new WebhookVerificationError('headers');
  const timestamp = BigInt(tsValue);
  if (timestamp > INT64_MAX) throw new WebhookVerificationError('headers');

  const deliveryId = singleHeader(headers, WEBHOOK_HEADERS.delivery);
  if (deliveryId === undefined || !DELIVERY_ID.test(deliveryId)) throw new WebhookVerificationError('headers');

  const signature = singleHeader(headers, WEBHOOK_HEADERS.signature);
  if (signature === undefined || !SIGNATURE.test(signature)) throw new WebhookVerificationError('headers');

  if (timestamp < now - tolerance || timestamp > now + tolerance) throw new WebhookVerificationError('timestamp');
  if (timestamp <= 0n) throw new WebhookVerificationError('headers');

  const expected = mac(apiKey, stringToSign(timestamp.toString(), deliveryId, body));
  const given = Buffer.from(signature.slice(SIGNATURE_PREFIX.length), 'hex');
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) {
    throw new WebhookVerificationError('signature');
  }
}

function parseBody(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8'));
  } catch {
    throw new CryptoChiefError('cryptochief: webhook body is not JSON');
  }
}

/**
 * Verify and parse a webhook in one step: {@link verifyWebhook}, then the
 * typed, camelCased event. Throws {@link WebhookVerificationError} when
 * verification fails and {@link CryptoChiefError} when the body is not JSON.
 *
 * ```ts
 * app.post('/webhook', express.raw({ type: '*\/*' }), (req, res) => {
 *   const evt = parseWebhookEvent<PayoutWebhookEvent>(apiKey, req.body, req.headers);
 *   res.sendStatus(200);
 * });
 * ```
 */
export function parseWebhookEvent<T = WebhookEvent>(
  apiKey: string,
  rawBody: string | Uint8Array,
  headers: WebhookHeaders,
  options: WebhookVerifyOptions = {},
): T {
  verifyWebhook(apiKey, rawBody, headers, options);
  return fromWire(parseBody(bodyBytes(rawBody))) as T;
}

/** Options for {@link createWebhookHandler}. */
export interface WebhookHandlerOptions extends WebhookVerifyOptions {
  /** Max accepted body size in bytes. Default 1 MiB. A larger body gets `413`. */
  maxBodyBytes?: number;
}

/** Bytes of an oversized body read and discarded before the connection is closed. */
const OVERSIZE_DRAIN_BYTES = 1 << 20;

/**
 * Create a Node `http` request handler that reads the raw body, verifies it
 * with {@link verifyWebhook}, parses the typed event, and invokes `onEvent`.
 * Responds `200` if the callback didn't write a response, `401` when
 * verification fails, `400` on an unreadable or non-JSON body, `405` for
 * non-POST, `413` when the body is larger than `maxBodyBytes`, `500` when the
 * callback throws. Works as a plain `http`/`https` listener or an Express
 * route mounted before any body parser.
 *
 * An oversized body is read and discarded, and `413` is sent when it ends.
 * Past 1 MiB over `maxBodyBytes`, `413` is sent with `Connection: close` and
 * the connection is closed; the sender may see a reset instead of the response.
 *
 * For Express with `express.raw()`, call {@link parseWebhookEvent} on
 * `req.body` and `req.headers`.
 */
export function createWebhookHandler<T = WebhookEvent>(
  apiKey: string,
  onEvent: (event: T, ctx: { req: IncomingMessage; res: ServerResponse }) => void | Promise<void>,
  options: WebhookHandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  if (isBlankApiKey(apiKey)) {
    throw new CryptoChiefError('cryptochief: apiKey is required for webhook verification');
  }
  const maxBytes = options.maxBodyBytes ?? 1 << 20;
  const verifyOptions: WebhookVerifyOptions = { toleranceSec: options.toleranceSec, now: options.now };
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
        if (err instanceof BodyTooLargeError) {
          res.writeHead(413, err.drained ? {} : { Connection: 'close' }).end(err.message);
        } else {
          res.writeHead(400).end(err instanceof Error ? err.message : 'read error');
        }
        return;
      }
      try {
        verifyWebhook(apiKey, raw, requestHeaders(req), verifyOptions);
      } catch (err) {
        if (err instanceof WebhookVerificationError) res.writeHead(401).end(err.message);
        else res.writeHead(500).end('webhook verification error');
        return;
      }
      let event: T;
      try {
        event = fromWire(parseBody(raw)) as T;
      } catch (err) {
        res.writeHead(400).end(err instanceof Error ? err.message : 'invalid body');
        return;
      }
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

/** Header lines as received (`rawHeaders`), so a repeated header stays repeated. */
function requestHeaders(req: IncomingMessage): WebhookHeaders {
  const raw = req.rawHeaders;
  if (!Array.isArray(raw)) return req.headers;
  const pairs: [string, string][] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) pairs.push([raw[i]!, raw[i + 1]!]);
  return pairs;
}

class BodyTooLargeError extends CryptoChiefError {
  /** `true` when the whole body was read, so the connection can stay open. */
  readonly drained: boolean;

  constructor(drained: boolean) {
    super('cryptochief: webhook body too large');
    this.drained = drained;
  }
}

/**
 * Reads the body up to `limit` bytes. A larger body is discarded as it arrives
 * and rejects on its end, or once `OVERSIZE_DRAIN_BYTES` past `limit` are read.
 * The socket is left to the `http` server, so the response is written before
 * the connection closes.
 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) {
        chunks.push(chunk);
        return;
      }
      chunks = [];
      if (size > limit + OVERSIZE_DRAIN_BYTES) reject(new BodyTooLargeError(false));
    });
    req.on('end', () => {
      if (size > limit) reject(new BodyTooLargeError(true));
      else resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

// -- Typed event payloads -----------------------------------------------------

/**
 * Payout webhook. Fires only on terminal status: `payout.paid` / `payout.system_fail`.
 * `payout.paid` is sent once every source reaches `requiredConfirmations`.
 */
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
  sources?: PayoutSource[];
  serviceOperations?: PayoutServiceOperation[];
  /** Lowest confirmation count among `sources`; see {@link PayoutInfo.confirmations}. */
  confirmations?: number;
  /** The network's finality depth; see {@link PayoutInfo.requiredConfirmations}. */
  requiredConfirmations?: number;
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
  /** See {@link TransactionInfo.confirmations}. */
  confirmations?: number;
  /** See {@link TransactionInfo.requiredConfirmations}. */
  requiredConfirmations?: number;
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
 * wallets have been swept to your master wallet AND the sweep transaction has
 * reached the network's finality depth. Sent once, when the sweep turns
 * `completed`.
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
   * What makes this event true rather than hopeful: at least
   * `requiredConfirmations`, and never zero. It travels with the event rather
   * than being implied by it: "confirmed" is not the same number on every chain,
   * so if you run your own finality policy you need the count to apply it.
   */
  sweepConfirmations: number;

  /** The network's finality depth the sweep waited for. */
  requiredConfirmations?: number;

  /**
   * When the sweep was observed at `requiredConfirmations`. Not `Sweep.completedAt`,
   * which is set at broadcast.
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
