import type { RequestOptions } from '../client';
import { CryptoChiefError } from '../errors';
import { BaseService } from './base';

/** Energy-rental order outcomes. */
export const EnergyOrderStatus = {
  /** Claimed; a supplier is about to be called. */
  Reserved: 'reserved',
  /** A supplier took the order; delivery is being confirmed. */
  Placed: 'placed',
  /** The energy is delegated to `receiveAddress`; the rental is complete. */
  Delivered: 'delivered',
  /** No supplier took the order: nothing was bought and nothing is owed. */
  Refused: 'refused',
  /**
   * The supplier call ended without a certain answer - the energy may already
   * have been bought. The order will not resolve itself; do not retry it.
   */
  Unresolved: 'unresolved',
  /** Settled and the charge was returned to the credits balance. */
  Refunded: 'refunded',
} as const;
export type EnergyOrderStatus = (typeof EnergyOrderStatus)[keyof typeof EnergyOrderStatus];

export interface EnergyQuoteRequest {
  /** Sender of the planned transfer - the address the energy would be delegated to. */
  receiveAddress: string;
  /**
   * Energy units to price. Omitted, the supplier sizes it for the address:
   * about 65k when it already holds the token being sent, about 130k when it
   * does not.
   */
  energy?: number;
  /** Rental duration in seconds. Defaults to one hour. */
  durationSec?: number;
}

/**
 * A price the platform stands behind until `expiresAt`. Free of charge.
 *
 * Prices are quoted twice: integer `priceSun` (authoritative, safe to compare)
 * and decimal-string `priceTrx` (human-readable). The USD / credits fields are
 * conversions at `trxUsd` and are absent when no rate is available - compare
 * `credits` against `client.credits.balance()` before ordering.
 */
export interface EnergyQuote {
  /** Quote reference; pass as `quoteRef` to {@link EnergyService.rent} to buy at this price. */
  ref: string;
  receiveAddress: string;
  /** Energy units covered. */
  energy: number;
  durationSec: number;
  /** Rental price in SUN (1 TRX = 1,000,000 SUN). */
  priceSun: number;
  /** The same price in TRX, as a decimal string. */
  priceTrx: string;
  /** `priceSun` converted at `trxUsd`; absent when no rate is available. */
  priceUsd?: string;
  /** What the order will be charged, in credits; computed the same way the charge will be. */
  credits?: number;
  /** The TRX/USD rate the conversions were made at (8 decimals). */
  trxUsd?: string;
  /** Why the energy figure is what it is: `warm`, `cold` or `unknown` (an address holding the token needs about half). */
  recipientState: string;
  /** What the same transfer would cost burning TRX directly, in SUN. */
  burnPriceSun: number;
  burnPriceTrx: string;
  burnPriceUsd?: string;
  burnPriceCredits?: number;
  /** `burnPrice` - `price`: the saving from renting, in TRX. */
  savingTrx: string;
  savingUsd?: string;
  savingCredits?: number;
  /** The price is held until this time, RFC 3339. */
  expiresAt: string;
  expiresInSec: number;
}

export interface RentEnergyRequest {
  /**
   * Sender of the transfer - the address the energy is delegated to.
   * Required unless `quoteRef` is given; with a quote the quoted terms win,
   * so a mismatched address cannot redirect the energy.
   */
  receiveAddress?: string;
  /** Energy units; sized for the address when omitted. */
  energy?: number;
  /** Rental duration in seconds. Defaults to one hour. */
  durationSec?: number;
  /** Buy at a price already quoted. Omitted, the order is priced and bought in one call. */
  quoteRef?: string;
}

/**
 * One energy rental, as returned by `rent` and `order`.
 *
 * `priceUsd` / `credits` / `trxUsd` record what was ACTUALLY charged, so they
 * are absent on an order nobody was charged for (`refused`) rather than sent
 * as zero.
 */
export interface EnergyOrder {
  id: number;
  /** The `Idempotency-Key` the order was placed with; also the lookup key for {@link EnergyService.order}. */
  idempotencyKey: string;
  /** One of {@link EnergyOrderStatus}. */
  status: EnergyOrderStatus | string;
  receiveAddress: string;
  energy: number;
  durationSec: number;
  priceSun: number;
  priceTrx: string;
  /** Absent when nothing was charged (a refused order). */
  priceUsd?: string;
  /** Credits charged; absent when nothing was charged. */
  credits?: number;
  /** The TRX/USD rate the charge was computed at. */
  trxUsd?: string;
  /** Energy actually delegated. */
  deliveredEnergy?: number;
  /** The outcome is final, in either direction. */
  settled: boolean;
  /**
   * Nothing automatic should touch this order again: it may have been bought
   * and cannot be accounted for. When true, do NOT retry the rent.
   */
  needsAttention: boolean;
  /** Why the order was refused or is unresolved. */
  error?: string;
  /** Machine form of `error` (wire `error_code`), when the order carries one. */
  errorCode?: string;
  createdAt: string;
  /** When the energy was delegated; absent until delivered. */
  deliveredAt?: string;
}

/**
 * TRON energy rental. Renting delegates energy to the sending address instead
 * of burning TRX for it; the charge goes to the same credits balance as the
 * rest of the API (see {@link CreditsService}).
 */
export class EnergyService extends BaseService {
  /**
   * Price a rental without buying. Free of charge; the price is held until
   * `expiresAt` and can be locked in by passing `ref` as `quoteRef` to
   * {@link rent}.
   */
  quote(req: EnergyQuoteRequest, opts?: RequestOptions): Promise<EnergyQuote> {
    return this.call('/v1/energy/quote', req, opts);
  }

  /**
   * Rent energy, synchronously: by the time this answers, the energy is either
   * delegated (`status` `delivered`) or the reason it was not is known.
   *
   * `opts.idempotencyKey` is REQUIRED and sent as the `Idempotency-Key` header
   * (the server answers 400 `IDEMPOTENCY_KEY_REQUIRED` without it; the SDK
   * refuses locally). It is what makes a retry safe: resubmitting the same key
   * returns the same order instead of buying the energy twice.
   *
   * The answer is always an {@link EnergyOrder}, one of:
   *
   * - `delivered` (HTTP 200) - the energy is delegated.
   * - `refused` (HTTP 502, or HTTP 402 when the credits balance is short) - no
   *   supplier could fill the order and nothing was charged (`credits` /
   *   `priceUsd` absent); `error` / `errorCode` say why. Retrying with the
   *   SAME key is safe - it returns this same order; a NEW key re-attempts
   *   the rental.
   * - `unresolved` (HTTP 409, `needsAttention` true) - the supplier's answer
   *   never arrived, so the energy may already be delegated. Do NOT retry:
   *   re-renting is exactly how the same energy gets paid for twice. Follow
   *   the order with {@link order} until it settles.
   *
   * Errors with no order to report (409 `QUOTE_EXPIRED` / `NOT_WORTH_RENTING`,
   * gateway failures, ...) throw an {@link ApiError} as usual.
   */
  async rent(req: RentEnergyRequest, opts?: RequestOptions): Promise<EnergyOrder> {
    if (!opts?.idempotencyKey) {
      throw new CryptoChiefError(
        'cryptochief: energy.rent: idempotencyKey is required (opts.idempotencyKey) - without it a retry after a timeout would buy the energy twice',
      );
    }
    try {
      return await this.call('/v1/energy/rent', req, opts);
    } catch (err) {
      const order = this.recoverOrder<EnergyOrder>(err);
      if (order) return order;
      throw err;
    }
  }

  /**
   * What became of a rental, by its idempotency key. This is the right move
   * after a timeout or a 409 - ask what happened, do not rent again. An order
   * belonging to another project answers 404, as a nonexistent one.
   */
  order(key: string, opts?: RequestOptions): Promise<EnergyOrder> {
    return this.call('/v1/energy/order', { key }, opts);
  }
}
