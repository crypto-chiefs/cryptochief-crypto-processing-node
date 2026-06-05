import type { Chain, ChainFamily } from '../chains';
import type { Asset, AssetsPolicy } from '../assets';
import type { RequestOptions } from '../client';
import type { HistoryMeta, HistoryQuery } from '../pagination';
import { waitForTerminal, type PollOptions } from '../poll';
import { BaseService } from './base';

/** Pay-in mode: `fiat` fixes a stable fiat price; `crypto` fixes the crypto amount. */
export const PayInMode = {
  Fiat: 'fiat',
  Crypto: 'crypto',
} as const;
export type PayInMode = (typeof PayInMode)[keyof typeof PayInMode];

/** Pay-in status values. */
export const PayInStatus = {
  WaitingAssetSelect: 'waiting_asset_select',
  Pending: 'pending',
  Processing: 'processing',
  Process: 'process',
  Paid: 'paid',
  Cancel: 'cancel',
  Expired: 'expired',
} as const;

const TERMINAL = new Set<string>([PayInStatus.Paid, PayInStatus.Cancel, PayInStatus.Expired]);

/** Whether a pay-in status is final. */
export function isPayInTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

export interface CreatePayInRequest {
  orderId: string;
  userId: string;
  mode: PayInMode;
  toAddress?: string;
  lifetimeSec?: number;
  urlCallback?: string;
  urlSuccess?: string;
  urlError?: string;
  additionalData?: string;
  accuracyPaymentPercent?: number;
  /** FIAT-mode: amount in fiat. */
  amountFiat?: string;
  /** FIAT-mode: fiat currency code. */
  currency?: string;
  /** FIAT-mode: rate source, e.g. `"binance"`, `"any"`. */
  courseSource?: string;
  /** FIAT-mode: restrict which coins the customer may pick. */
  assets?: AssetsPolicy;
  /** CRYPTO-mode: amount in crypto. */
  amountCrypto?: string;
  /** CRYPTO-mode: fix the exact coin+network. */
  asset?: Asset;
}

export interface CoinOption {
  chainFamily: ChainFamily;
  coin: string;
  network: Chain;
  contract?: string;
}

export interface PayIn {
  type: string;
  uuid: string;
  orderId: string;
  userId?: string;
  status: string;
  mode?: PayInMode;
  amountCrypto?: string;
  amountFiat?: string;
  currency?: string;
  paymentCoin?: string;
  paymentNetwork?: Chain;
  toAddress?: string;
  coins?: CoinOption[];
  paymentLink?: string;
  urlCallback?: string;
  urlSuccess?: string;
  urlError?: string;
  additionalData?: string;
  canCancel?: boolean;
  expiredAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PayInHistoryResponse {
  items: PayIn[];
  meta: HistoryMeta;
}

export interface SelectAssetRequest {
  uuid: string;
  coin: string;
  network: Chain;
}

/** Incoming-payment (invoice) endpoints. */
export class PayInsService extends BaseService {
  /** Open a new pay-in order. */
  create(req: CreatePayInRequest, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/create', req, opts);
  }

  /** Commit the customer's coin/network choice on a `waiting_asset_select` order. */
  selectAsset(req: SelectAssetRequest, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/asset/select', req, opts);
  }

  /** Revert a pending order to `waiting_asset_select` (H2H only). */
  resetAsset(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/asset/reset', { uuid }, opts);
  }

  /** Cancel an open order. */
  cancel(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/cancel', { uuid }, opts);
  }

  /** Fetch the current state of one pay-in by uuid. */
  info(uuid: string, opts?: RequestOptions): Promise<PayIn> {
    return this.call('/v1/payments/order/info', { uuid }, opts);
  }

  /** Paged list of pay-ins. */
  history(query: HistoryQuery = {}, opts?: RequestOptions): Promise<PayInHistoryResponse> {
    return this.call('/v1/payments/history', query, opts);
  }

  /** Poll `info` until the pay-in reaches a terminal state (or timeout). */
  waitFor(uuid: string, opts: PollOptions = {}): Promise<PayIn> {
    return waitForTerminal(
      (signal) => this.info(uuid, { signal }),
      (p) => isPayInTerminal(p.status),
      opts,
    );
  }
}
