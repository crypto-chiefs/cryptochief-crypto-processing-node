import type { RequestOptions } from '../client';
import { BaseService } from './base';

/**
 * Delivery statuses in {@link WebhookDelivery.status}.
 *
 * - `pending` — queued, not yet attempted (or waiting for a retry)
 * - `in_progress` — a worker holds it right now
 * - `delivered` — your endpoint answered 2xx
 * - `failed` — every attempt so far was refused or timed out
 * - `cancelled` — superseded by a newer event before it was ever sent
 */
export const WebhookDeliveryStatus = {
  Pending: 'pending',
  InProgress: 'in_progress',
  Delivered: 'delivered',
  Failed: 'failed',
  Cancelled: 'cancelled',
} as const;

/** One POST the platform made to your endpoint. Newest first in `attemptHistory`. */
export interface WebhookAttempt {
  attempt: number;
  /** `null` when nothing answered (DNS, connect, TLS, timeout); `error` then holds the transport error. */
  httpStatus: number | null;
  error: string | null;
  durationMs: number | null;
  targetUrl: string;
  /** `null` for attempts recorded before the platform kept the time. */
  createdAt: string | null;
  /** What your endpoint answered, as the platform saw it. Capped; see `responseTruncated`. */
  responseBody: string | null;
  responseContentType: string | null;
  responseTruncated: boolean;
}

/** The body the platform sent. `bytes` is the whole size even when `body` was cut. */
export interface WebhookPayload {
  body: string;
  bytes: number;
  truncated: boolean;
}

/**
 * One outbound webhook, with every attempt the platform made and the body it
 * sent. `null` means "not recorded", distinct from zero or empty.
 */
export interface WebhookDelivery {
  uuid: string;
  eventType: string;
  /** The object the event was about — the order or static deposit uuid you already hold. */
  reference: string;
  targetUrl: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  /** How many times a resend was asked for, by API or from the dashboard. */
  resendCount: number;
  lastError: string | null;
  lastHttpStatus: number | null;
  nextAttemptAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  /**
   * The NEWER event for the same object, when there is one. A superseded
   * delivery cannot be resent — resend the latest event instead.
   */
  supersededBy: string | null;
  attemptHistory: WebhookAttempt[];
  payload: WebhookPayload;
}

/**
 * What a resend did. On this platform a resend is synchronous: the POST to
 * your endpoint happens before the answer comes back, so `queued: true`
 * arrives with `status` already `delivered` or `failed` for that attempt.
 */
export interface WebhookResendResult {
  uuid: string;
  eventType: string;
  reference: string;
  status: string;
  queued: boolean;
  attempts: number;
  resendCount: number;
  /** Set when `queued` is false: one of the `ErrorCode.Delivery*` / `ResendTooSoon` codes. */
  reason?: string;
  supersededBy?: string;
  retryAfterSeconds?: number;
}

/**
 * The resend of a static deposit's webhook. `deliveries` has one entry — the
 * newest delivery for the deposit — kept as a list so the shape matches the
 * white-label platform, which may requeue several.
 */
export interface StaticDepositResendResult {
  uuid: string;
  deliveries: WebhookResendResult[];
  queued: number;
  total: number;
}

/**
 * Reads and re-fires the platform's OUTBOUND webhooks — the deliveries made to
 * your endpoint. (Verifying INCOMING webhooks is `verifyWebhookSignature` /
 * `createWebhookHandler` in `webhook.ts`.)
 *
 * A delivery is named by the uuid the platform put on it in the
 * `X-Webhook-Delivery` header ({@link WEBHOOK_DELIVERY_HEADER}). It is the same
 * across every attempt and resend of that delivery — the natural idempotency
 * key for your receiver — and it is the only handle there is: the API has no
 * listing of deliveries, and the payload names the order, not the delivery.
 * Keep it when you log an incoming webhook.
 */
export class WebhooksService extends BaseService {
  /**
   * One delivery by the uuid from its `X-Webhook-Delivery` header. A delivery
   * that is not this project's is `NOT_FOUND`, the same as one that does not exist.
   */
  info(deliveryUuid: string, opts?: RequestOptions): Promise<WebhookDelivery> {
    return this.call('/v1/webhooks/info', { uuid: deliveryUuid }, opts);
  }

  /**
   * Send one delivery to your endpoint again, right now.
   *
   * Refused with an `ApiError` whose `code` is:
   * - `DELIVERY_SUPERSEDED` (409) — a newer event exists for the same object.
   *   Re-sending `invoice.in_mempool` after `invoice.paid` would tell your
   *   system the order went backwards, so only the latest event may be resent.
   *   Permanent; the newer event's name is in the error message.
   * - `DELIVERY_IN_FLIGHT` (409) — a worker is delivering it right now, or it
   *   is already scheduled for an automatic retry. Try again in a moment.
   * - `RESEND_TOO_SOON` (429) — resent under a minute ago; `Retry-After` is set.
   *
   * A successful manual delivery is billed as `/v1/webhook/resend`; a refused one is not.
   */
  resend(deliveryUuid: string, opts?: RequestOptions): Promise<WebhookResendResult> {
    return this.call('/v1/webhooks/resend', { uuid: deliveryUuid }, opts);
  }

  /**
   * Re-fire the NEWEST webhook of one static deposit, named by the deposit's
   * own uuid — for when you have the deposit and not the delivery. Older
   * events of the deposit are superseded and are not resent.
   *
   * Refused with `NO_DELIVERIES` (409) when the deposit is yours but no webhook
   * was ever queued for it: it arrived on a static wallet with no `callback_url`.
   * The per-delivery refusals of {@link resend} apply as well.
   */
  resendStaticDeposit(depositUuid: string, opts?: RequestOptions): Promise<StaticDepositResendResult> {
    return this.call('/v1/static-deposits/resend', { uuid: depositUuid }, opts);
  }
}
