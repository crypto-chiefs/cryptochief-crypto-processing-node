import type { RequestOptions } from '../client';
import { BaseService } from './base';

export interface ConvertRequest {
  /** Exchange data source (optional; server picks a default). */
  provider?: string;
  /** Source ticker (fiat code for fiat->crypto; crypto symbol for crypto->fiat). */
  from: string;
  /** Destination ticker. */
  to: string;
  /** Human-readable amount of the `from` currency. */
  amount: string;
}

export interface ConvertResponse {
  amountCrypto: number;
  amountFiat: number;
  crypto: string;
  cryptoToUsdt: number;
  exchange: string;
  fiat: string;
  fiatToUsd: number;
  timestampCrypto: number;
  timestampFiat: number;
}

/**
 * Fiat <-> crypto rate calculator. These quote rates only - they do NOT move
 * funds (a swap is a payout with `autoConvert: true`).
 */
export class CurrenciesService extends BaseService {
  /** Quote how much crypto the given fiat amount is worth. */
  fiatToCrypto(req: ConvertRequest, opts?: RequestOptions): Promise<ConvertResponse> {
    return this.call('/v1/currencies/convert/fiat-crypto', req, opts);
  }

  /** Quote how much fiat the given crypto amount is worth. */
  cryptoToFiat(req: ConvertRequest, opts?: RequestOptions): Promise<ConvertResponse> {
    return this.call('/v1/currencies/convert/crypto-fiat', req, opts);
  }
}
