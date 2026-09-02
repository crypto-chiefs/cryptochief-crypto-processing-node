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
 * A fiat currency the platform can price an order in - the `currency` of a
 * fiat-mode pay-in, and the `from`/`to` of a rate quote.
 */
export interface FiatCurrency {
  /** ISO 4217 code, e.g. `SEK`. */
  code: string;
  /** Display name, e.g. `Swedish Krona`. */
  name: string;
}

/**
 * The crypto tickers the platform has a rate for, against `quote`.
 *
 * Rate availability only: a ticker here can be quoted, which does NOT mean the
 * platform takes deposits, sweeps or payouts in it. For that, read
 * `client.blockchain.contractsAvailable()`.
 */
export interface CryptoCurrencies {
  /** Every ticker, deduplicated across the exchanges. */
  tickers: string[];
  /**
   * The tickers each exchange carries, keyed by exchange name - `binance`,
   * `bybit`, `exmo`, `kucoin`. The keys are data, so they reach you verbatim
   * rather than camelCased like the field names around them.
   *
   * Every value is a real array. The map, and any one exchange's list inside
   * it, can arrive as literal `null`; none of them reaches you that way, so an
   * exchange that carries nothing is an empty list rather than a `TypeError`.
   */
  byExchange: Record<string, string[]>;
  /** How many tickers `tickers` holds. */
  count: number;
  /** The asset the rates are quoted against - `USDT`. */
  quote: string;
}

/**
 * Fiat <-> crypto rates: the two catalogues of what can be quoted, and the two
 * calculators that quote it. These quote rates only - they do NOT move funds,
 * and there is no swap endpoint to move them with: `autoConvert` on a payout is
 * refused by the platform with `AUTO_CONVERT_NOT_IMPLEMENTED`.
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

  /**
   * Every fiat currency the platform can price an order in and quote a rate
   * against - the values `payIns.create` accepts as `currency` in fiat mode,
   * and either side of a {@link CurrenciesService.fiatToCrypto} quote.
   *
   * The API answers with a bare JSON array rather than an `items` envelope, so
   * this resolves to the array itself. An empty result comes off the wire as
   * literal `null` rather than `[]`; this normalises it, so the caller always
   * gets an array to iterate.
   */
  async fiats(opts?: RequestOptions): Promise<FiatCurrency[]> {
    return (await this.call<FiatCurrency[] | null>('/v1/currencies/fiats', {}, opts)) ?? [];
  }

  /**
   * Every crypto ticker the platform has a rate for, against USDT, and which
   * exchange each one comes from.
   *
   * **Rate availability only.** A ticker here can be priced; it does not follow
   * that the platform takes deposits, sweeps or payouts in it. Build a picker
   * from this list and it will offer assets an order is then refused for - the
   * list that governs orders is `client.blockchain.contractsAvailable()`.
   */
  async cryptos(opts?: RequestOptions): Promise<CryptoCurrencies> {
    // Exchange names are data, not field names. The shared `call` helper
    // camelCases every key it walks, which would rename an exchange the moment
    // one arrives with an underscore in it, so the envelope is unpacked here
    // and the map is taken off the wire untouched.
    //
    // The defaults below are load-bearing, not decoration: an empty result
    // arrives as literal `null` - the whole body, or `tickers`/`by_exchange`
    // inside it, or ONE EXCHANGE'S LIST inside the map - and `tickers` and
    // `byExchange` are promised as a list and a map of lists, so every level is
    // handed over empty rather than null.
    const raw =
      (await this.client.request<Record<string, unknown>>('/v1/currencies/cryptos', {}, opts)) ?? {};
    const byExchange: Record<string, string[]> = {};
    for (const [exchange, tickers] of Object.entries(
      (raw.by_exchange as Record<string, string[] | null> | null | undefined) ?? {},
    )) {
      byExchange[exchange] = tickers ?? [];
    }
    return {
      tickers: (raw.tickers as string[] | null | undefined) ?? [],
      byExchange,
      count: (raw.count as number | null | undefined) ?? 0,
      quote: (raw.quote as string | null | undefined) ?? '',
    };
  }
}
