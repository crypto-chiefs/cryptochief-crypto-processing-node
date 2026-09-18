import type { RequestOptions } from '../client';
import type { Chain } from '../chains';
import { CryptoChiefError } from '../errors';
import { BaseService } from './base';

/** Native-coin order outcomes. */
export const NativeOrderStatus = {
  /** The coins were sent to `receiveAddress`; the order is complete. */
  Delivered: 'delivered',
  /** The buy was not performed: nothing was sent and nothing is owed. */
  Refused: 'refused',
  /**
   * The buy ended without a certain answer - the coins may already have been
   * sent. The order will not resolve itself; do not retry it.
   */
  Unresolved: 'unresolved',
} as const;
export type NativeOrderStatus = (typeof NativeOrderStatus)[keyof typeof NativeOrderStatus];

export interface NativeQuoteRequest {
  /** Network to buy the native coin of (TRX on TRON, ETH on Ethereum, ...). */
  network: Chain;
  /**
   * Address the coins will be sent to. Any address qualifies - the platform
   * pays for the transfer out of its own wallet.
   */
  receiveAddress: string;
  /** Amount to buy, in human units as a decimal string (e.g. `'0.05'`). */
  amount: string;
}

/**
 * A price the platform stands behind until `expiresAt`. Free of charge.
 *
 * The price covers the coins themselves at the current market rate plus the
 * fee of the platform's own transfer at the same rate. `totalUsd` is the full
 * price; `credits` is exactly what the order will be charged - compare it
 * against `client.credits.balance()` before buying.
 */
export interface NativeQuote {
  /** Quote reference (`nq_...`); pass as `quoteRef` to {@link NativeService.buy} to buy at this price. */
  ref: string;
  network: Chain;
  receiveAddress: string;
  /** Quoted amount, in human units as a decimal string. */
  amount: string;
  /** What `amount` of the coin costs at `coinUsd`, in USD. */
  coinPriceUsd: string;
  /** The fee of the platform's transfer to you, in the native coin. */
  transferFee: string;
  /** The same fee in USD. */
  transferFeeUsd: string;
  /** `coinPriceUsd` + `transferFeeUsd`. */
  subtotalUsd: string;
  /** The total price in USD. */
  totalUsd: string;
  /** What the order will be charged, in credits; computed the same way the charge will be. */
  credits: number;
  /** The coin/USD rate the conversions were made at. */
  coinUsd: string;
  /** The price is held until this time, RFC 3339. Short-lived (about 90 seconds) and single-use. */
  expiresAt: string;
  expiresInSec: number;
}

export interface BuyNativeRequest {
  /**
   * Network to buy the native coin of. Required unless `quoteRef` is given;
   * with a quote the quoted terms win.
   */
  network?: Chain;
  /**
   * Address the coins are sent to. Any address qualifies - the platform pays
   * for the transfer. Required unless `quoteRef` is given.
   */
  receiveAddress?: string;
  /** Amount to buy, in human units as a decimal string. Required unless `quoteRef` is given. */
  amount?: string;
  /** Buy at a price already quoted. Omitted, the order is priced and bought in one call. */
  quoteRef?: string;
}

/**
 * One native-coin buy, as returned by `buy` and `order`.
 *
 * `txHash` / `totalUsd` / `credits` record what was ACTUALLY sent and charged,
 * so they are absent on an order nothing was charged for (`refused`) rather
 * than sent as zero. `transferFee` / `transferFeeUsd` / `coinPriceUsd` /
 * `coinUsd` are always present - empty (`''`) or zero (`'0.00'`) when nothing
 * was sent.
 */
export interface NativeOrder {
  id: number;
  /** The `Idempotency-Key` the order was placed with; also the lookup key for {@link NativeService.order}. */
  idempotencyKey: string;
  /** One of {@link NativeOrderStatus}. */
  status: NativeOrderStatus | string;
  network: Chain;
  receiveAddress: string;
  /** Bought amount, in human units as a decimal string. */
  amount: string;
  /** The transfer's hash on the network; absent until delivered. */
  txHash?: string;
  /** The fee of the platform's transfer, in the native coin; `''` when nothing was sent. */
  transferFee: string;
  /** The same fee in USD; `'0.00'` when nothing was sent. */
  transferFeeUsd: string;
  /** What the coins cost at `coinUsd`; `'0.00'` when nothing was charged. */
  coinPriceUsd: string;
  /** Total price in USD; absent when nothing was charged. */
  totalUsd?: string;
  /** Credits charged; absent when nothing was charged. */
  credits?: number;
  /** The coin/USD rate the charge was computed at; `'0.00'` when nothing was charged. */
  coinUsd: string;
  /** The outcome is final, in either direction. */
  settled: boolean;
  /**
   * Nothing automatic should touch this order again: the coins may have been
   * sent and cannot be accounted for. When true, do NOT retry the buy.
   */
  needsAttention: boolean;
  /** Why the order was refused or is unresolved. */
  error?: string;
  /** Machine form of `error` (wire `error_code`), when the order carries one. */
  errorCode?: string;
  createdAt: string;
  /** When the coins were sent; absent until delivered. */
  deliveredAt?: string;
}

/**
 * Buying native coins (TRX, ETH, BNB, SOL, TON, ...) from the platform's own
 * liquidity, paid for in API credits. The platform sends the coins to any
 * address and pays the transfer fee itself; the charge - coins at the market
 * rate plus that fee - goes to the same credits balance as the rest of the
 * API (see {@link CreditsService}).
 */
export class NativeService extends BaseService {
  /**
   * Price a buy without buying. Free of charge; the price is held briefly
   * (about 90 seconds, single-use) and can be locked in by passing `ref` as
   * `quoteRef` to {@link buy}.
   */
  quote(req: NativeQuoteRequest, opts?: RequestOptions): Promise<NativeQuote> {
    return this.call('/v1/native/quote', req, opts);
  }

  /**
   * Buy native coins, synchronously: by the time this answers, the coins are
   * either on their way (`status` `delivered`) or the reason they are not is
   * known.
   *
   * `opts.idempotencyKey` is REQUIRED and sent as the `Idempotency-Key` header
   * (the server answers 400 `IDEMPOTENCY_KEY_REQUIRED` without it; the SDK
   * refuses locally). It is what makes a retry safe: resubmitting the same key
   * returns the same order instead of buying the coins twice.
   *
   * The answer is always a {@link NativeOrder}, one of:
   *
   * - `delivered` (HTTP 200) - the coins are sent; `txHash` is the transfer.
   * - `refused` (HTTP 502, or HTTP 402 when the credits balance is short) -
   *   the purchase did not happen and nothing was charged (`credits` /
   *   `totalUsd` absent); `error` / `errorCode` say why. Retrying with the
   *   SAME key is safe - it returns this same order; a NEW key re-attempts
   *   the purchase.
   * - `unresolved` (HTTP 409, `needsAttention` true) - the transfer's outcome
   *   never arrived, so the coins may already be sent. Do NOT retry: re-buying
   *   is exactly how the same coins get paid for twice. Follow the order with
   *   {@link order} until it settles.
   *
   * Errors with no order to report (409 `QUOTE_EXPIRED` / `QUOTE_ALREADY_USED`
   * - quote again, gateway failures, ...) throw an {@link ApiError} as usual.
   */
  async buy(req: BuyNativeRequest, opts?: RequestOptions): Promise<NativeOrder> {
    if (!opts?.idempotencyKey) {
      throw new CryptoChiefError(
        'cryptochief: native.buy: idempotencyKey is required (opts.idempotencyKey) - without it a retry after a timeout would buy the coins twice',
      );
    }
    try {
      return await this.call('/v1/native/buy', req, opts);
    } catch (err) {
      const order = this.recoverOrder<NativeOrder>(err);
      if (order) return order;
      throw err;
    }
  }

  /**
   * What became of a buy, by its idempotency key. This is the right move after
   * a timeout or a 409 - ask what happened, do not buy again. An order
   * belonging to another project answers 404, as a nonexistent one.
   */
  order(key: string, opts?: RequestOptions): Promise<NativeOrder> {
    return this.call('/v1/native/order', { key }, opts);
  }
}
